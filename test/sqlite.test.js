import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Worker
} from "node:worker_threads";

import {
  createReceiptKeyPair,
  executeSponsoredTask,
  loadSqliteBackend,
  verifyReceipt,
  verifyReceiptChain
} from "../src/index.js";

const [major, minor] =
  process.versions.node
    .split(".")
    .map(Number);

const sqliteAvailable =
  major > 22 ||
  (
    major === 22 &&
    minor >= 5
  );

function dbPath() {
  const dir = mkdtempSync(
    join(
      tmpdir(),
      "sponsorrail-sqlite-"
    )
  );

  return join(
    dir,
    "sponsorrail.db"
  );
}

async function loadBackend() {
  return loadSqliteBackend();
}

function runAuthorizeWorker(
  database,
  taskId,
  computeRequested
) {
  return new Promise(
    (resolve, reject) => {
      const worker =
        new Worker(
          new URL(
            "./helpers/sqlite-authorize-worker.mjs",
            import.meta.url
          ),
          {
            workerData: {
              dbPath: database,
              taskId,
              computeRequested
            }
          }
        );

      worker.once(
        "message",
        resolve
      );

      worker.once(
        "error",
        reject
      );

      worker.once(
        "exit",
        (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `worker exited with code ${code}`
              )
            );
          }
        }
      );
    }
  );
}

test(
  "SQLite backend loads lazily on supported Node",
  {
    skip: !sqliteAvailable
  },
  async () => {
    const backend =
      await loadBackend();

    assert.equal(
      typeof backend
        .SqliteFundingBroker,
      "function"
    );
  }
);

test(
  "two independent workers cannot over-reserve one sponsor pool",
  {
    skip: !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } = await loadBackend();

    const database =
      dbPath();

    const setup =
      new SqliteFundingBroker(
        database
      );

    setup.createPool({
      id: "shared",
      sponsorDisclosure:
        "ExampleCloud",
      balanceCredits: 30,
      eligibleTaskClasses: [
        "software-development"
      ],
      allowedPrivacyModes: [
        "blind"
      ]
    });

    setup.close();

    const [a, b] =
      await Promise.all([
        runAuthorizeWorker(
          database,
          "worker-a",
          20
        ),
        runAuthorizeWorker(
          database,
          "worker-b",
          20
        )
      ]);

    assert.equal(
      [a, b].filter(
        (result) =>
          result.funded === true
      ).length,
      1
    );

    assert.equal(
      [a, b].filter(
        (result) =>
          result.reason ===
          "INSUFFICIENT_SPONSOR_CREDITS"
      ).length,
      1
    );

    const inspect =
      new SqliteFundingBroker(
        database
      );

    const pool =
      inspect.poolSnapshot(
        "shared"
      );

    assert.equal(
      pool.availableCredits,
      10
    );

    assert.equal(
      pool.reservedCredits,
      20
    );

    assert.equal(
      pool.spentCredits,
      0
    );

    assert.equal(
      pool.totalCredits,
      30
    );

    inspect.close();
  }
);

test(
  "settlement is replay-safe across independent SQLite connections",
  {
    skip: !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } = await loadBackend();

    const database =
      dbPath();

    const first =
      new SqliteFundingBroker(
        database
      );

    first.createPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud",
      balanceCredits: 100
    });

    const grant =
      first.authorize({
        id: "task-1",
        taskClass:
          "software-development",
        computeRequested: 25,
        privacy: "blind",
        allowSponsorship: true,
        prompt: "private"
      });

    const second =
      new SqliteFundingBroker(
        database
      );

    const settled =
      second.settle(
        grant,
        17,
        {
          idempotencyKey:
            "settle-1"
        }
      );

    const replay =
      first.settle(
        grant,
        17,
        {
          idempotencyKey:
            "settle-1"
        }
      );

    assert.deepEqual(
      replay,
      settled
    );

    const pool =
      first.poolSnapshot(
        "pool"
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

    first.close();
    second.close();
  }
);

test(
  "SQLite heartbeat renewal is visible across connections",
  {
    skip: !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } = await loadBackend();

    const database =
      dbPath();

    let firstNow = 1000;

    const first =
      new SqliteFundingBroker(
        database,
        {
          now:
            () => firstNow,
          grantTtlMs: 100
        }
      );

    first.createPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud",
      balanceCredits: 100
    });

    const grant =
      first.authorize({
        id: "task",
        taskClass:
          "software-development",
        computeRequested: 25,
        privacy: "blind",
        allowSponsorship: true,
        prompt: "private"
      });

    const second =
      new SqliteFundingBroker(
        database,
        {
          now:
            () => 1080,
          grantTtlMs: 100
        }
      );

    const renewed =
      second.heartbeat(
        grant,
        {
          leaseMs: 200
        }
      );

    assert.equal(
      renewed.expiresAt,
      "1970-01-01T00:00:01.280Z"
    );

    assert.equal(
      renewed
        .lastHeartbeatAt,
      "1970-01-01T00:00:01.080Z"
    );

    firstNow = 1200;

    const settlement =
      first.settle(
        renewed,
        10
      );

    assert.equal(
      settlement.usedUnits,
      10
    );

    first.close();
    second.close();
  }
);

test(
  "executeSponsoredTask uses atomic SQLite receipt sequencing",
  {
    skip: !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } = await loadBackend();

    const database =
      dbPath();

    const first =
      new SqliteFundingBroker(
        database
      );

    first.createPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud",
      balanceCredits: 100
    });

    const second =
      new SqliteFundingBroker(
        database
      );

    const keys =
      createReceiptKeyPair();

    const run = async (
      broker,
      id
    ) =>
      executeSponsoredTask({
        task: {
          id,
          taskClass:
            "software-development",
          computeRequested: 20,
          privacy: "blind",
          allowSponsorship: true,
          prompt:
            "Secret prompt",
          repositoryContext:
            "SECRET_SOURCE"
        },
        broker,
        receiptPrivateKey:
          keys.privateKey,
        runner:
          async () => ({
            completed: true,
            computeUnitsUsed: 10
          })
      });

    const firstRun =
      await run(
        first,
        "task-a"
      );

    const secondRun =
      await run(
        second,
        "task-b"
      );

    assert.equal(
      firstRun.receipt
        .chain.sequence,
      1
    );

    assert.equal(
      secondRun.receipt
        .chain.sequence,
      2
    );

    assert.equal(
      secondRun.receipt
        .chain
        .previousReceiptHash,
      firstRun.receipt
        .chain
        .receiptHash
    );

    assert.equal(
      verifyReceipt(
        firstRun.receipt,
        keys.publicKey
      ),
      true
    );

    assert.equal(
      verifyReceiptChain(
        second
          .receiptJournal()
      ),
      true
    );

    first.close();
    second.close();
  }
);

test(
  "SQLite funding tables never store prompt repository context or model output",
  {
    skip: !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } = await loadBackend();

    const {
      DatabaseSync
    } = await import(
      "node:sqlite"
    );

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    broker.createPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud",
      balanceCredits: 100
    });

    await executeSponsoredTask({
      task: {
        id: "private-task",
        taskClass:
          "software-development",
        computeRequested: 20,
        privacy: "blind",
        allowSponsorship: true,
        prompt:
          "ULTRA_SECRET_PROMPT",
        repositoryContext:
          "TOP_SECRET_SOURCE"
      },
      broker,
      runner:
        async () => ({
          completed: true,
          computeUnitsUsed: 10,
          output:
            "PRIVATE_MODEL_OUTPUT"
        })
    });

    broker.close();

    const raw =
      new DatabaseSync(
        database
      );

    const tables = [
      "sponsor_pools",
      "grants",
      "settlements",
      "receipts",
      "meta"
    ];

    const serialized =
      tables
        .flatMap(
          (table) =>
            raw
              .prepare(
                `SELECT * FROM ${table}`
              )
              .all()
        )
        .map(
          (row) =>
            JSON.stringify(row)
        )
        .join("\n");

    raw.close();

    assert.equal(
      serialized.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "TOP_SECRET_SOURCE"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "PRIVATE_MODEL_OUTPUT"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "private-task"
      ),
      true
    );
  }
);
