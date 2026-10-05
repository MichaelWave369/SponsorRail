import {
  parentPort,
  workerData
} from "node:worker_threads";

import {
  FundingSourceRegistry
} from "../../src/funding.js";

import {
  SqliteFundingBroker
} from "../../src/sqlite.js";

const broker =
  new SqliteFundingBroker(
    workerData.dbPath
  );

const registry =
  new FundingSourceRegistry([
    {
      sourceId:
        workerData.sourceId,
      publicKey:
        workerData.publicKey
    }
  ]);

try {
  const result =
    broker.depositCampaign(
      workerData.receipt,
      registry
    );

  parentPort.postMessage(
    result
  );
} catch (error) {
  parentPort.postMessage({
    error:
      error?.message ??
      String(error)
  });
} finally {
  broker.close();
}
