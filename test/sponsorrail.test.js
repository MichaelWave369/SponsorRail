import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BlindSponsorPool,
  FundingBroker,
  JsonPoolStore,
  buildExecutionAuthorization,
  buildModelContext,
  createReceiptKeyPair,
  evaluatePolicy,
  executeSponsoredTask,
  sanitizeFundingRequest,
  verifyReceipt,
  verifyReceiptChain,
  verifyReceiptHash
} from "../src/index.js";

function makeTask(overrides = {}) {
  return {
    id: "private-task",
    taskClass: "software-development",
    computeRequested: 25,
    userMaxCost: 0,
    privacy: "blind",
    allowSponsorship: true,
    prompt: "Secret prompt",
    repositoryContext: "SECRET_SOURCE_CODE",
    ...overrides
  };
}

function makePool(overrides = {}) {
  return new BlindSponsorPool({
    id: "pool",
    sponsorDisclosure: "ExampleCloud",
    balanceCredits: 100,
    ...overrides
  });
}

function makeStore() {
  const dir = mkdtempSync(
    join(tmpdir(), "sponsorrail-")
  );

  return new JsonPoolStore(
    join(dir, "state.json")
  );
}

test("funding request strips prompt and repository context", () => {
  const request =
    sanitizeFundingRequest(
      makeTask()
    );

  assert.deepEqual(request, {
    taskId: "private-task",
    taskClass:
      "software-development",
    computeRequested: 25,
    userMaxCost: 0,
    privacy: "blind"
  });

  assert.equal(
    JSON.stringify(request)
      .includes("Secret prompt"),
    false
  );

  assert.equal(
    JSON.stringify(request)
      .includes("SECRET_SOURCE_CODE"),
    false
  );
});

test("model context contains task data but no sponsor identity", () => {
  const context =
    buildModelContext(
      makeTask()
    );

  assert.equal(
    context.prompt,
    "Secret prompt"
  );

  assert.equal(
    JSON.stringify(context)
      .includes("ExampleCloud"),
    false
  );

  assert.equal(
    JSON.stringify(context)
      .includes("sponsor"),
    false
  );
});

test("execution authorization strips sponsor metadata", () => {
  const auth =
    buildExecutionAuthorization({
      grantId:
        "broker-minted",
      computeUnits: 25,
      sponsorDisclosure:
        "ExampleCloud",
      sponsorInstructions:
        "Use our database"
    });

  assert.deepEqual(auth, {
    grantId:
      "broker-minted",
    computeUnits: 25
  });
});

test("policy matcher rejects task class privacy mode and oversized grants", () => {
  const policy = {
    eligibleTaskClasses: [
      "software-development"
    ],
    allowedPrivacyModes: [
      "blind"
    ],
    maxComputePerGrant: 50
  };

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(
        makeTask()
      ),
      policy
    ).eligible,
    true
  );

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(
        makeTask({
          taskClass: "research"
        })
      ),
      policy
    ).reason,
    "TASK_CLASS_NOT_ELIGIBLE"
  );

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(
        makeTask({
          privacy: "contextual"
        })
      ),
      policy
    ).reason,
    "PRIVACY_MODE_NOT_ELIGIBLE"
  );

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(
        makeTask({
          computeRequested: 51
        })
      ),
      policy
    ).reason,
    "GRANT_LIMIT_EXCEEDED"
  );
});

test("authorization reserves credits without spending them", () => {
  const pool = makePool();

  const broker =
    new FundingBroker(
      [pool],
      {
        now: () => 1000
      }
    );

  const grant =
    broker.authorize(
      makeTask()
    );

  assert.equal(
    grant.funded,
    true
  );

  assert.equal(
    grant.issuedAt,
    "1970-01-01T00:00:01.000Z"
  );

  assert.equal(
    pool.availableCredits,
    75
  );

  assert.equal(
    pool.reservedCredits,
    25
  );

  assert.equal(
    pool.spentCredits,
    0
  );

  assert.equal(
    pool.totalCredits,
    100
  );
});

test("settlement spends actual usage and refunds unused reservation", () => {
  const pool = makePool();

  const broker =
    new FundingBroker(
      [pool]
    );

  const grant =
    broker.authorize(
      makeTask()
    );

  const settlement =
    broker.settle(
      grant,
      17
    );

  assert.deepEqual(
    settlement,
    {
      reservedUnits: 25,
      usedUnits: 17,
      refundUnits: 8
    }
  );

  assert.equal(
    pool.availableCredits,
    83
  );

  assert.equal(
    pool.reservedCredits,
    0
  );

  assert.equal(
    pool.spentCredits,
    17
  );

  assert.equal(
    pool.totalCredits,
    100
  );
});

test("failed execution releases the full reservation", async () => {
  const pool = makePool();

  const broker =
    new FundingBroker(
      [pool]
    );

  await assert.rejects(
    () =>
      executeSponsoredTask({
        task: makeTask(),
        broker,
        runner: async () => {
          throw new Error(
            "agent crashed"
          );
        }
      }),
    /agent crashed/
  );

  assert.equal(
    pool.availableCredits,
    100
  );

  assert.equal(
    pool.reservedCredits,
    0
  );

  assert.equal(
    pool.spentCredits,
    0
  );
});

test("invalid over-reporting releases reservation rather than charging sponsor", async () => {
  const pool = makePool();

  const broker =
    new FundingBroker(
      [pool]
    );

  await assert.rejects(
    () =>
      executeSponsoredTask({
        task: makeTask(),
        broker,
        runner: async () => ({
          completed: true,
          computeUnitsUsed: 26
        })
      }),
    /invalid compute usage/
  );

  assert.equal(
    pool.availableCredits,
    100
  );

  assert.equal(
    pool.spentCredits,
    0
  );
});

test("user can decline sponsorship", () => {
  const pool = makePool();

  const broker =
    new FundingBroker(
      [pool]
    );

  const grant =
    broker.authorize(
      makeTask({
        allowSponsorship:
          false
      })
    );

  assert.deepEqual(
    grant,
    {
      funded: false,
      reason:
        "SPONSORSHIP_DECLINED"
    }
  );

  assert.equal(
    pool.balanceCredits,
    100
  );
});

test("durable grant can settle after broker restart", () => {
  const store = makeStore();
  const clock = () => 1000;

  const first =
    new FundingBroker(
      [makePool()],
      {
        store,
        now: clock,
        grantTtlMs: 1000
      }
    );

  const grant =
    first.authorize(
      makeTask()
    );

  const restarted =
    new FundingBroker(
      [],
      {
        store,
        now: clock,
        grantTtlMs: 1000
      }
    );

  const settlement =
    restarted.settle(
      grant,
      10
    );

  assert.deepEqual(
    settlement,
    {
      reservedUnits: 25,
      usedUnits: 10,
      refundUnits: 15
    }
  );

  assert.equal(
    restarted.pools[0]
      .availableCredits,
    90
  );

  assert.equal(
    restarted.pools[0]
      .reservedCredits,
    0
  );

  assert.equal(
    restarted.pools[0]
      .spentCredits,
    10
  );
});

test("expired durable grants are released during reconciliation", () => {
  const store = makeStore();

  const first =
    new FundingBroker(
      [makePool()],
      {
        store,
        now: () => 1000,
        grantTtlMs: 100
      }
    );

  const grant =
    first.authorize(
      makeTask()
    );

  const restarted =
    new FundingBroker(
      [],
      {
        store,
        now: () => 1200,
        grantTtlMs: 100
      }
    );

  assert.equal(
    restarted.pools[0]
      .availableCredits,
    100
  );

  assert.equal(
    restarted.pools[0]
      .reservedCredits,
    0
  );

  assert.throws(
    () =>
      restarted.settle(
        grant,
        1
      ),
    /unknown grant/
  );
});

test("unexpired orphan reservations are reported but not released", () => {
  const store = makeStore();

  const first =
    new FundingBroker(
      [makePool()],
      {
        store,
        now: () => 1000,
        grantTtlMs: 1000
      }
    );

  first.authorize(
    makeTask()
  );

  const state =
    store.loadState();

  store.saveState({
    ...state,
    grants: []
  });

  const restarted =
    new FundingBroker(
      [],
      {
        store,
        now: () => 1200,
        grantTtlMs: 1000,
        autoReconcile: false
      }
    );

  const report =
    restarted.reconcile();

  assert.equal(
    report.orphanReservations
      .length,
    1
  );

  assert.equal(
    report.releasedOrphans
      .length,
    0
  );

  assert.equal(
    restarted.pools[0]
      .reservedCredits,
    25
  );
});

test("expired orphan reservations are released", () => {
  const store = makeStore();

  const first =
    new FundingBroker(
      [makePool()],
      {
        store,
        now: () => 1000,
        grantTtlMs: 100
      }
    );

  first.authorize(
    makeTask()
  );

  const state =
    store.loadState();

  store.saveState({
    ...state,
    grants: []
  });

  const restarted =
    new FundingBroker(
      [],
      {
        store,
        now: () => 1200,
        grantTtlMs: 100,
        autoReconcile: false
      }
    );

  const report =
    restarted.reconcile();

  assert.equal(
    report.releasedOrphans
      .length,
    1
  );

  assert.equal(
    restarted.pools[0]
      .availableCredits,
    100
  );

  assert.equal(
    restarted.pools[0]
      .reservedCredits,
    0
  );
});

test("persistent state contains only coarse grant and reservation metadata", () => {
  const store = makeStore();

  const broker =
    new FundingBroker(
      [makePool()],
      {
        store,
        now: () => 1000
      }
    );

  broker.authorize(
    makeTask()
  );

  const raw =
    readFileSync(
      store.filePath,
      "utf8"
    );

  assert.equal(
    raw.includes(
      "Secret prompt"
    ),
    false
  );

  assert.equal(
    raw.includes(
      "SECRET_SOURCE_CODE"
    ),
    false
  );

  assert.equal(
    raw.includes(
      "private-task"
    ),
    true
  );

  assert.equal(
    raw.includes(
      "ExampleCloud"
    ),
    true
  );
});

test("v0.2 store documents migrate into v0.3 state", () => {
  const store = makeStore();

  writeFileSync(
    store.filePath,
    JSON.stringify({
      schema:
        "sponsorrail.pool-store.v0.2",
      pools: [
        makePool().snapshot()
      ]
    })
  );

  const state =
    store.loadState();

  assert.equal(
    state.schema,
    "sponsorrail.store.v0.3"
  );

  assert.deepEqual(
    state.grants,
    []
  );

  assert.deepEqual(
    state.receiptChain,
    {
      sequence: 0,
      headHash: null
    }
  );
});

test("receipts are hash-linked and signatures remain verifiable", async () => {
  const pool = makePool({
    balanceCredits: 200
  });

  const broker =
    new FundingBroker(
      [pool],
      {
        now: () => 1000
      }
    );

  const keys =
    createReceiptKeyPair();

  const first =
    await executeSponsoredTask({
      task: makeTask({
        id: "task-1"
      }),
      broker,
      receiptPrivateKey:
        keys.privateKey,
      runner: async () => ({
        completed: true,
        computeUnitsUsed: 10
      })
    });

  const second =
    await executeSponsoredTask({
      task: makeTask({
        id: "task-2"
      }),
      broker,
      receiptPrivateKey:
        keys.privateKey,
      runner: async () => ({
        completed: true,
        computeUnitsUsed: 11
      })
    });

  assert.equal(
    first.receipt.schema,
    "sponsorrail.receipt.v0.3"
  );

  assert.equal(
    first.receipt.chain
      .sequence,
    1
  );

  assert.equal(
    first.receipt.chain
      .previousReceiptHash,
    null
  );

  assert.equal(
    second.receipt.chain
      .sequence,
    2
  );

  assert.equal(
    second.receipt.chain
      .previousReceiptHash,
    first.receipt.chain
      .receiptHash
  );

  assert.equal(
    verifyReceiptHash(
      first.receipt
    ),
    true
  );

  assert.equal(
    verifyReceiptHash(
      second.receipt
    ),
    true
  );

  assert.equal(
    verifyReceiptChain([
      first.receipt,
      second.receipt
    ]),
    true
  );

  assert.equal(
    verifyReceipt(
      first.receipt,
      keys.publicKey
    ),
    true
  );

  assert.equal(
    verifyReceipt(
      second.receipt,
      keys.publicKey
    ),
    true
  );
});

test("receipt chain head survives restart", async () => {
  const store = makeStore();
  const keys =
    createReceiptKeyPair();

  const firstBroker =
    new FundingBroker(
      [makePool({
        balanceCredits: 200
      })],
      {
        store,
        now: () => 1000
      }
    );

  const first =
    await executeSponsoredTask({
      task: makeTask({
        id: "task-1"
      }),
      broker: firstBroker,
      receiptPrivateKey:
        keys.privateKey,
      runner: async () => ({
        completed: true,
        computeUnitsUsed: 10
      })
    });

  const restarted =
    new FundingBroker(
      [],
      {
        store,
        now: () => 1000
      }
    );

  const second =
    await executeSponsoredTask({
      task: makeTask({
        id: "task-2"
      }),
      broker: restarted,
      receiptPrivateKey:
        keys.privateKey,
      runner: async () => ({
        completed: true,
        computeUnitsUsed: 10
      })
    });

  assert.equal(
    second.receipt.chain
      .sequence,
    2
  );

  assert.equal(
    second.receipt.chain
      .previousReceiptHash,
    first.receipt.chain
      .receiptHash
  );

  assert.deepEqual(
    restarted
      .receiptChainState(),
    {
      sequence: 2,
      headHash:
        second.receipt.chain
          .receiptHash
    }
  );
});

test("tampering breaks receipt hash verification", async () => {
  const broker =
    new FundingBroker(
      [makePool()]
    );

  const execution =
    await executeSponsoredTask({
      task: makeTask(),
      broker,
      runner: async () => ({
        completed: true,
        computeUnitsUsed: 10
      })
    });

  const tampered = {
    ...execution.receipt,
    computeUnitsUsed: 9
  };

  assert.equal(
    verifyReceiptHash(
      tampered
    ),
    false
  );
});
