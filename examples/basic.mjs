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
  verifyReceiptChain
} from "../src/index.js";

const dir = mkdtempSync(
  join(
    tmpdir(),
    "sponsorrail-demo-"
  )
);

const store =
  new JsonPoolStore(
    join(
      dir,
      "state.json"
    )
  );

let now = 1_000;

const pool =
  new BlindSponsorPool({
    id: "oss-pool",
    sponsorDisclosure:
      "ExampleCloud",
    balanceCredits: 100,
    eligibleTaskClasses: [
      "software-development"
    ],
    allowedPrivacyModes: [
      "blind"
    ],
    maxComputePerGrant: 50
  });

const broker =
  new FundingBroker(
    [pool],
    {
      store,
      now: () => now,
      grantTtlMs: 100
    }
  );

const previewGrant =
  broker.authorize({
    id: "heartbeat-demo",
    taskClass:
      "software-development",
    computeRequested: 5,
    privacy: "blind",
    allowSponsorship: true,
    prompt: "private"
  });

now = 1_080;

const renewed =
  broker.heartbeat(
    previewGrant,
    {
      leaseMs: 200
    }
  );

console.log(
  "Renewed lease:",
  renewed.expiresAt
);

broker.release(
  renewed
);

const keys =
  createReceiptKeyPair();

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
    runner:
      async ({
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

console.log(
  "Receipt signature valid:",
  verifyReceipt(
    execution.receipt,
    keys.publicKey
  )
);

console.log(
  "Journal valid:",
  verifyReceiptChain(
    store
      .loadReceiptJournal()
  )
);

console.log(
  "Journal entries:",
  store
    .loadReceiptJournal()
    .length
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
    {
      store,
      now: () => now
    }
  );

console.log(
  "Recovered chain:",
  restarted
    .receiptChainState()
);

console.log(
  "Recovered journal entries:",
  restarted
    .receiptJournal()
    .length
);
