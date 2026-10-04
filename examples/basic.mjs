import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BlindSponsorPool,
  FundingBroker,
  JsonPoolStore,
  createReceiptKeyPair,
  executeSponsoredTask,
  verifyReceipt,
  verifyReceiptHash
} from "../src/index.js";

const dir = mkdtempSync(
  join(tmpdir(), "sponsorrail-demo-")
);

const store = new JsonPoolStore(
  join(dir, "state.json")
);

const pool = new BlindSponsorPool({
  id: "oss-pool",
  sponsorDisclosure: "ExampleCloud",
  balanceCredits: 100,
  eligibleTaskClasses: [
    "software-development"
  ],
  allowedPrivacyModes: ["blind"],
  maxComputePerGrant: 50
});

const broker = new FundingBroker(
  [pool],
  {
    store,
    grantTtlMs: 60_000
  }
);

const keys = createReceiptKeyPair();

const task = {
  id: "task-001",
  taskClass:
    "software-development",
  computeRequested: 25,
  userMaxCost: 0,
  privacy: "blind",
  allowSponsorship: true,
  prompt:
    "Add a health endpoint and tests.",
  repositoryContext:
    "Private repository context that the sponsor must never receive."
};

const execution =
  await executeSponsoredTask({
    task,
    broker,
    receiptPrivateKey:
      keys.privateKey,
    runner: async ({
      modelContext,
      authorization
    }) => {
      console.log(
        "Agent sees:",
        modelContext
      );

      console.log(
        "Execution authorization:",
        authorization
      );

      return {
        completed: true,
        computeUnitsUsed: 18,
        summary:
          "Health endpoint implemented and tests passed."
      };
    }
  });

console.log("\nSponsor receipt:");
console.log(
  JSON.stringify(
    execution.receipt,
    null,
    2
  )
);

console.log(
  "\nReceipt signature valid:",
  verifyReceipt(
    execution.receipt,
    keys.publicKey
  )
);

console.log(
  "Receipt hash valid:",
  verifyReceiptHash(
    execution.receipt
  )
);

console.log(
  "Pool accounting:",
  {
    available:
      pool.availableCredits,
    reserved:
      pool.reservedCredits,
    spent:
      pool.spentCredits,
    total:
      pool.totalCredits
  }
);

const restarted =
  new FundingBroker(
    [],
    { store }
  );

console.log(
  "Recovered receipt chain:",
  restarted.receiptChainState()
);
