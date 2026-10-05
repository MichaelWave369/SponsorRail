import {
  parentPort,
  workerData
} from "node:worker_threads";

import {
  SqliteProviderHealthTracker
} from "../../src/health-sqlite.js";

const tracker =
  new SqliteProviderHealthTracker(
    workerData.dbPath,
    {
      failureThreshold:
        workerData.failureThreshold,
      cooldownMs:
        workerData.cooldownMs,
      halfOpenLeaseMs:
        workerData.halfOpenLeaseMs,
      now:
        () => workerData.now
    }
  );

try {
  parentPort.postMessage({
    acquired:
      tracker.tryAcquireHalfOpen(
        workerData.providerId
      )
  });
} finally {
  tracker.close();
}
