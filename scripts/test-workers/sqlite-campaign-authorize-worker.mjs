import {
  parentPort,
  workerData
} from "node:worker_threads";

import {
  SqliteFundingBroker
} from "../../src/sqlite.js";

const broker =
  new SqliteFundingBroker(
    workerData.dbPath,
    {
      campaignPreferences:
        workerData
          .campaignPreferences
    }
  );

try {
  const result =
    broker.authorize({
      id: workerData.taskId,
      taskClass:
        "software-development",
      computeRequested:
        workerData.computeRequested,
      userMaxCost: 0,
      privacy: "blind",
      allowSponsorship: true,
      prompt:
        "private worker prompt"
    });

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
