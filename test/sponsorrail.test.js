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
    taskClass:
      "software-development",
    computeRequested: 25,
    userMaxCost: 0,
    privacy: "blind",
    allowSponsorship: true,
    prompt: "Secret prompt",
    repositoryContext:
      "SECRET_SOURCE_CODE",
    ...overrides
  };
}

function makePool(overrides = {}) {
  return new BlindSponsorPool({
    id: "pool",
    sponsorDisclosure:
      "ExampleCloud",
    balanceCredits: 100,
    ...overrides
  });
}

function makeStore() {
  const dir = mkdtempSync(
    join(
      tmpdir(),
      "sponsorrail-"
    )
  );

  return new JsonPoolStore(
    join(
      dir,
      "state.json"
    )
  );
}

test(
  "funding request strips prompt and repository context",
  () => {
    const request =
      sanitizeFundingRequest(
        makeTask()
      );

    assert.deepEqual(
      request,
      {
        taskId:
          "private-task",
        taskClass:
          "software-development",
        computeRequested: 25,
        userMaxCost: 0,
        privacy: "blind"
      }
    );

    assert.equal(
      JSON.stringify(request)
        .includes(
          "Secret prompt"
        ),
      false
    );

    assert.equal(
      JSON.stringify(request)
        .includes(
          "SECRET_SOURCE_CODE"
        ),
      false
    );
  }
);

test(
  "model context contains task data but no sponsor identity",
  () => {
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
        .includes(
          "ExampleCloud"
        ),
      false
    );

    assert.equal(
      JSON.stringify(context)
        .includes(
          "sponsor"
        ),
      false
    );
  }
);

test(
  "execution authorization strips sponsor metadata",
  () => {
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

    assert.deepEqual(
      auth,
      {
        grantId:
          "broker-minted",
        computeUnits: 25
      }
    );
  }
);

test(
  "policy matcher rejects incompatible requests",
  () => {
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
            taskClass:
              "research"
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
            privacy:
              "contextual"
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
            computeRequested:
              51
          })
        ),
        policy
      ).reason,
      "GRANT_LIMIT_EXCEEDED"
    );
  }
);

test(
  "authorization reserves credits without spending them",
  () => {
    const pool =
      makePool();

    const broker =
      new FundingBroker(
        [pool],
        {
          now:
            () => 1000
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
  }
);

test(
  "settlement spends actual usage and refunds unused reservation",
  () => {
    const pool =
      makePool();

    const broker =
      new FundingBroker(
        [pool]
      );

    const grant =
      broker.authorize(
        makeTask()
      );

    assert.deepEqual(
      broker.settle(
        grant,
        17
      ),
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
  }
);

test(
  "failed execution releases the full reservation",
  async () => {
    const pool =
      makePool();

    const broker =
      new FundingBroker(
        [pool]
      );

    await assert.rejects(
      () =>
        executeSponsoredTask({
          task: makeTask(),
          broker,
          runner:
            async () => {
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
  }
);

test(
  "invalid over-reporting releases reservation",
  async () => {
    const pool =
      makePool();

    const broker =
      new FundingBroker(
        [pool]
      );

    await assert.rejects(
      () =>
        executeSponsoredTask({
          task: makeTask(),
          broker,
          runner:
            async () => ({
              completed: true,
              computeUnitsUsed:
                26
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
  }
);

test(
  "user can decline sponsorship",
  () => {
    const pool =
      makePool();

    const broker =
      new FundingBroker(
        [pool]
      );

    assert.deepEqual(
      broker.authorize(
        makeTask({
          allowSponsorship:
            false
        })
      ),
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
  }
);

test(
  "durable grant can settle after broker restart",
  () => {
    const store =
      makeStore();

    const first =
      new FundingBroker(
        [makePool()],
        {
          store,
          now:
            () => 1000,
          grantTtlMs:
            1000
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
          now:
            () => 1000,
          grantTtlMs:
            1000
        }
      );

    assert.deepEqual(
      restarted.settle(
        grant,
        10
      ),
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
        .spentCredits,
      10
    );
  }
);

test(
  "heartbeat renews an active grant and matching reservation",
  () => {
    const store =
      makeStore();

    let now = 1000;

    const broker =
      new FundingBroker(
        [makePool()],
        {
          store,
          now: () => now,
          grantTtlMs:
            100
        }
      );

    const grant =
      broker.authorize(
        makeTask()
      );

    assert.equal(
      grant.expiresAt,
      "1970-01-01T00:00:01.100Z"
    );

    now = 1080;

    const renewed =
      broker.heartbeat(
        grant,
        {
          leaseMs: 200
        }
      );

    assert.equal(
      renewed
        .lastHeartbeatAt,
      "1970-01-01T00:00:01.080Z"
    );

    assert.equal(
      renewed.expiresAt,
      "1970-01-01T00:00:01.280Z"
    );

    const state =
      store.loadState();

    assert.equal(
      state.grants[0]
        .expiresAt,
      renewed.expiresAt
    );

    assert.equal(
      state.pools[0]
        .reservations[0]
        .expiresAt,
      renewed.expiresAt
    );
  }
);

test(
  "heartbeat cannot revive an expired grant",
  () => {
    let now = 1000;

    const pool =
      makePool();

    const broker =
      new FundingBroker(
        [pool],
        {
          now:
            () => now,
          grantTtlMs:
            100
        }
      );

    const grant =
      broker.authorize(
        makeTask()
      );

    now = 1200;

    assert.throws(
      () =>
        broker.heartbeat(
          grant
        ),
      /grant expired/
    );

    assert.equal(
      pool.availableCredits,
      100
    );

    assert.equal(
      pool.reservedCredits,
      0
    );
  }
);

test(
  "idempotent settlement replay does not spend twice",
  () => {
    const store =
      makeStore();

    const broker =
      new FundingBroker(
        [makePool()],
        { store }
      );

    const grant =
      broker.authorize(
        makeTask()
      );

    const first =
      broker.settle(
        grant,
        17,
        {
          idempotencyKey:
            "settle-123"
        }
      );

    const second =
      broker.settle(
        grant,
        17,
        {
          idempotencyKey:
            "settle-123"
        }
      );

    assert.deepEqual(
      second,
      first
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      83
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      17
    );

    const restarted =
      new FundingBroker(
        [],
        { store }
      );

    assert.deepEqual(
      restarted.settle(
        grant,
        17,
        {
          idempotencyKey:
            "settle-123"
        }
      ),
      first
    );

    assert.equal(
      restarted.pools[0]
        .spentCredits,
      17
    );
  }
);

test(
  "same grant cannot be settled twice with a different key",
  () => {
    const broker =
      new FundingBroker(
        [makePool()]
      );

    const grant =
      broker.authorize(
        makeTask()
      );

    const first =
      broker.settle(
        grant,
        10,
        {
          idempotencyKey:
            "a"
        }
      );

    const replay =
      broker.settle(
        grant,
        10,
        {
          idempotencyKey:
            "b"
        }
      );

    assert.deepEqual(
      replay,
      first
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      10
    );
  }
);

test(
  "idempotency conflicts are rejected",
  () => {
    const broker =
      new FundingBroker(
        [makePool()]
      );

    const grant =
      broker.authorize(
        makeTask()
      );

    broker.settle(
      grant,
      10,
      {
        idempotencyKey:
          "same"
      }
    );

    assert.throws(
      () =>
        broker.settle(
          grant,
          11,
          {
            idempotencyKey:
              "same"
          }
        ),
      /idempotency conflict/
    );
  }
);

test(
  "expired durable grants are released during reconciliation",
  () => {
    const store =
      makeStore();

    const first =
      new FundingBroker(
        [makePool()],
        {
          store,
          now:
            () => 1000,
          grantTtlMs:
            100
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
          now:
            () => 1200,
          grantTtlMs:
            100
        }
      );

    assert.equal(
      restarted.pools[0]
        .availableCredits,
      100
    );

    assert.throws(
      () =>
        restarted.settle(
          grant,
          1
        ),
      /unknown grant/
    );
  }
);

test(
  "unexpired orphan reservations are reported but not released",
  () => {
    const store =
      makeStore();

    const first =
      new FundingBroker(
        [makePool()],
        {
          store,
          now:
            () => 1000,
          grantTtlMs:
            1000
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
          now:
            () => 1200,
          grantTtlMs:
            1000,
          autoReconcile:
            false
        }
      );

    const report =
      restarted.reconcile();

    assert.equal(
      report
        .orphanReservations
        .length,
      1
    );

    assert.equal(
      report
        .releasedOrphans
        .length,
      0
    );

    assert.equal(
      restarted.pools[0]
        .reservedCredits,
      25
    );
  }
);

test(
  "expired orphan reservations are released",
  () => {
    const store =
      makeStore();

    const first =
      new FundingBroker(
        [makePool()],
        {
          store,
          now:
            () => 1000,
          grantTtlMs:
            100
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
          now:
            () => 1200,
          grantTtlMs:
            100,
          autoReconcile:
            false
        }
      );

    const report =
      restarted.reconcile();

    assert.equal(
      report
        .releasedOrphans
        .length,
      1
    );

    assert.equal(
      restarted.pools[0]
        .availableCredits,
      100
    );
  }
);

test(
  "persistent state contains no prompt source or output data",
  () => {
    const store =
      makeStore();

    const broker =
      new FundingBroker(
        [makePool()],
        {
          store,
          now:
            () => 1000
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
  }
);

test(
  "v0.3 store documents migrate into v0.4 state",
  () => {
    const store =
      makeStore();

    writeFileSync(
      store.filePath,
      JSON.stringify({
        schema:
          "sponsorrail.store.v0.3",
        pools: [
          makePool()
            .snapshot()
        ],
        grants: [],
        receiptChain: {
          sequence: 4,
          headHash:
            "legacy-head"
        }
      })
    );

    const state =
      store.loadState();

    assert.equal(
      state.schema,
      "sponsorrail.store.v0.4"
    );

    assert.deepEqual(
      state.settlements,
      []
    );

    assert.deepEqual(
      state.receiptChain,
      {
        sequence: 4,
        headHash:
          "legacy-head"
      }
    );
  }
);

test(
  "completed receipts are appended to durable journal",
  async () => {
    const store =
      makeStore();

    const broker =
      new FundingBroker(
        [
          makePool({
            balanceCredits:
              200
          })
        ],
        {
          store,
          now:
            () => 1000
        }
      );

    const keys =
      createReceiptKeyPair();

    const first =
      await executeSponsoredTask({
        task:
          makeTask({
            id: "task-1"
          }),
        broker,
        receiptPrivateKey:
          keys.privateKey,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed:
              10
          })
      });

    const second =
      await executeSponsoredTask({
        task:
          makeTask({
            id: "task-2"
          }),
        broker,
        receiptPrivateKey:
          keys.privateKey,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed:
              11
          })
      });

    const journal =
      store
        .loadReceiptJournal();

    assert.equal(
      journal.length,
      2
    );

    assert.equal(
      journal[0]
        .chain.receiptHash,
      first.receipt
        .chain.receiptHash
    );

    assert.equal(
      journal[1]
        .chain
        .previousReceiptHash,
      first.receipt
        .chain.receiptHash
    );

    assert.equal(
      journal[1]
        .chain.receiptHash,
      second.receipt
        .chain.receiptHash
    );

    assert.equal(
      verifyReceiptChain(
        journal
      ),
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
      verifyReceiptHash(
        second.receipt
      ),
      true
    );
  }
);

test(
  "receipt journal and chain head survive restart",
  async () => {
    const store =
      makeStore();

    const firstBroker =
      new FundingBroker(
        [
          makePool({
            balanceCredits:
              200
          })
        ],
        {
          store,
          now:
            () => 1000
        }
      );

    const first =
      await executeSponsoredTask({
        task:
          makeTask({
            id: "task-1"
          }),
        broker:
          firstBroker,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed:
              10
          })
      });

    const restarted =
      new FundingBroker(
        [],
        {
          store,
          now:
            () => 1000
        }
      );

    assert.equal(
      restarted
        .receiptJournal()
        .length,
      1
    );

    assert.deepEqual(
      restarted
        .receiptChainState(),
      {
        sequence: 1,
        headHash:
          first.receipt
            .chain
            .receiptHash
      }
    );

    const second =
      await executeSponsoredTask({
        task:
          makeTask({
            id: "task-2"
          }),
        broker:
          restarted,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed:
              10
          })
      });

    assert.equal(
      second.receipt
        .chain.sequence,
      2
    );

    assert.equal(
      second.receipt
        .chain
        .previousReceiptHash,
      first.receipt
        .chain.receiptHash
    );

    assert.equal(
      store
        .loadReceiptJournal()
        .length,
      2
    );
  }
);

test(
  "journal can recover a chain head written after state lag",
  async () => {
    const store =
      makeStore();

    const broker =
      new FundingBroker(
        [makePool()],
        {
          store,
          now:
            () => 1000
        }
      );

    const execution =
      await executeSponsoredTask({
        task: makeTask(),
        broker,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed:
              10
          })
      });

    const state =
      store.loadState();

    store.saveState({
      ...state,
      receiptChain: {
        sequence: 0,
        headHash: null
      }
    });

    const restarted =
      new FundingBroker(
        [],
        {
          store,
          now:
            () => 1000
        }
      );

    assert.deepEqual(
      restarted
        .receiptChainState(),
      {
        sequence: 1,
        headHash:
          execution.receipt
            .chain
            .receiptHash
      }
    );
  }
);

test(
  "tampering breaks receipt hash verification",
  async () => {
    const broker =
      new FundingBroker(
        [makePool()]
      );

    const execution =
      await executeSponsoredTask({
        task: makeTask(),
        broker,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed:
              10
          })
      });

    assert.equal(
      verifyReceiptHash({
        ...execution.receipt,
        computeUnitsUsed: 9
      }),
      false
    );
  }
);
