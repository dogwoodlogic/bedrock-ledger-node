/*!
 * Copyright (c) 2016-2019 Digital Bazaar, Inc. All rights reserved.
 */
const bedrock = require('bedrock');
const {config} = require('bedrock');
const database = require('bedrock-mongodb');
const logger = require('./logger');
const LedgerNodeWorkSession = require('./LedgerNodeWorkSession');
const brJobs = require('bedrock-jobs');

const {get: getLedgerNode} = require('./rootApi');

const namespace = 'ledger-node';

// in memory (per process instance) concurrent work session tracking var
let runningConsensusWorkSessions = 0;

const SHUTDOWN_GRACE_PERIOD = 3000;

// set up signal handling
let ABORT_SCHEDULING_CONSENSUS;

bedrock.events.on('bedrock.exit', async () => {
  logger.info(`Stopping consensus scheduling...`);
  ABORT_SCHEDULING_CONSENSUS = true;
  await bedrock.util.delay(SHUTDOWN_GRACE_PERIOD);
});

// module API
const api = {};
module.exports = api;

bedrock.events.on('bedrock.ready', async () => {
  if(config.ledger.jobs.scheduleConsensusWork.enabled) {
    const consensusQueue = api._jobQueue = brJobs.addQueue({name: namespace});
    // setup a processor for the queue with the default concurrency of 1
    consensusQueue.process(api._scheduleConsensusWork);
    await consensusQueue.add({}, {
      // prevent duplicate jobs by specifying a non-unique jobId
      jobId: 'scheduleConsensusWork',
      // repeated jobs are completed and rescheduled on every iteration
      repeat: {
        every: 100
      },
      // do not keep record of successfully completed jobs in redis
      removeOnComplete: true
    });
  }
});

api._hasher = require('./hasher');
api._rdfCanonizeAndHash = require('./rdfCanonizeAndHash');

/**
 * Scans for ledger nodes that have not been inspected by their consensus
 * plugin and notifies the consensus plugin to run a worker, if desired.
 *
 * @param job the current job.
 *
 * @return a Promise that resolves once the operation completes.
 */
api._scheduleConsensusWork = async j => {
  const {opts: {jobId}} = j;
  logger.verbose(`Running worker (${jobId}) to schedule consensus work...`);

  if(ABORT_SCHEDULING_CONSENSUS) {
    logger.verbose('Abort scheduling consensus work...');
    return;
  }

  const start = Date.now();
  const {ttl} = config.ledger.jobs.scheduleConsensusWork;
  const thisWorkerExpires = start + ttl;
  const concurrency = config.ledger.jobs.scheduleConsensusWork.
    workSessionConcurrencyPerInstance;
  const collection = database.collections.ledgerNode;
  const singleUpdateOptions = bedrock.util.extend(
    {}, database.writeOptions, {upsert: false, multi: false});

  logger.verbose('Attempting offer...');
  logger.verbose(`Current state...`, {
    runningConsensusWorkSessions,
    concurrency,
    thisWorkerExpires,
    dateNow: Date.now(),
    check1: runningConsensusWorkSessions < concurrency,
    check2: thisWorkerExpires >= Date.now()
  });
  while(
    runningConsensusWorkSessions < concurrency &&
    thisWorkerExpires >= Date.now()) {
    try {
      // claim a new or stalled ledgerNode with this worker's ID
      logger.verbose('Attempting to claim ledger node...');
      const ledgerNodeId = await claimLedgerNode();
      if(!ledgerNodeId) {
        if(ledgerNodeId === false) {
          logger.verbose('No ledger nodes to claim, stop worker');
          // no ledger nodes to claim, stop worker
          break;
        }
        logger.verbose(' another process happened to grabbed a ledger node' +
          ' we tried to claim');
        // another process happened to grabbed a ledger node we tried to
        // claim, so loop and try again
        continue;
      }

      // offer claimed ledger node to a consensus plugin to reserve it
      const ledgerNode = await getLedgerNode(null, ledgerNodeId, {});
      offer(ledgerNode);
    } catch(e) {
      logger.verbose(
        `Error while scheduling consensus work on worker (${jobId})`,
        {error: e});
      logger.error(
        `Error while scheduling consensus work on worker (${jobId})`,
        {error: e});
      break;
    }
  }

  // clear any node claimed by the scheduler
  const query = {'meta.workSession.id': jobId};
  const update = {
    $set: {
      'meta.workSession': null,
      'meta.updated': Date.now()
    }
  };
  try {
    await collection.update(query, update, singleUpdateOptions);
  } catch(e) {
    logger.verbose(
      `Error after scheduling consensus work on worker (${jobId})`, {error: e});
    logger.error(
      `Error after scheduling consensus work on worker (${jobId})`, {error: e});
  } finally {
    logger.verbose(`Schedule consensus work worker (${jobId}) finished.`);
  }

  async function claimLedgerNode() {
    const ledgerNodeId = await getLruLedgerNode();
    if(!ledgerNodeId) {
      // no ledger nodes to work on
      return false;
    }

    // "claim" ledger node by marking it with scheduler worker ID
    const query = {
      id: database.hash(ledgerNodeId),
      'meta.deleted': {$exists: false},
      $or: [
        {'meta.workSession.id': null},
        {'meta.workSession.expires': {$lte: Date.now()}}
      ]
    };
    const update = {
      $set: {
        'meta.workSession': {id: jobId, expires: thisWorkerExpires},
        'meta.updated': Date.now()
      }
    };
    const result = await collection.update(query, update, singleUpdateOptions);
    if(result.result.n) {
      // ledger node record successfully marked
      return ledgerNodeId;
    }
    // another process marked the record before we could; not an error,
    // return `null` to signal an attempt can be made again to mark a
    // different ledger node
    return null;
  }

  async function getLruLedgerNode() {
    // find ledger node that was least recently updated
    const query = {
      'meta.deleted': {$exists: false},
      $or: [
        {'meta.workSession.id': null},
        {'meta.workSession.expires': {$lte: Date.now()}}
      ]
    };
    const [record] = await collection.find(query, {'ledgerNode.id': 1})
      .sort({'meta.updated': 1})
      .limit(1).toArray();
    if(!record) {
      // no ledger nodes to work on
      return false;
    }
    return record.ledgerNode.id;
  }

  function offer(ledgerNode) {
    // skip if `scheduleWork` is undefined on the consensus plugin API
    if(!ledgerNode.consensus.scheduleWork) {
      return;
    }
    runningConsensusWorkSessions++;
    // schedule offering to reserve ledger node for a work session
    process.nextTick(() => {
      const session = new LedgerNodeWorkSession({
        schedulerId: jobId,
        ledgerNode,
        onFinish() {
          logger.verbose(`Ledger Node Work Session finished.`);
          runningConsensusWorkSessions--;
        }
      });
      logger.verbose('Schedule consensus work...')
      ledgerNode.consensus.scheduleWork({session});
      if(!session.started) {
        runningConsensusWorkSessions--;
      }
    });
  }
};
