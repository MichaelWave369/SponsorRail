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
  executeSponsoredTask,
  loadSqliteBackend
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
  const dir =
    mkdtempSync(
      join(
        tmpdir(),
        "sponsorrail-campaign-sqlite-"
      )
    );

  return join(
    dir,
    "campaign.db"
  );
}

function campaign(
  overrides = {}
) {
  return {
    campaignId:
      "oss-builds",
    sponsorDisclosure:
      "ExampleCloud",
    capabilityType:
      "compute",
    benefitDescription:
      "Funds agent build compute",
    targetingMode:
      "universal",
    budgetCredits: 100,
    eligibleTaskClasses: [
      "*"
    ],
    allowedPrivacyModes: [
      "blind"
    ],
    maxComputePerGrant: 50,
    priority: 5,
    ...overrides
  };
}

function task(
  overrides = {}
) {
  return {
    id: "sqlite-campaign-task",
    taskClass:
      "software-development",
    computeRequested: 20,
    privacy: "blind",
    allowSponsorship: true,
    prompt:
      "ULTRA_SECRET_PROMPT",
    repositoryContext:
      "TOP_SECRET_SOURCE",
    ...overrides
  };
}

function runWorker(
  database,
  taskId,
  computeRequested
) {
  return new Promise(
    (resolve, reject) => {
      const worker =
        new Worker(
          new URL(
            "../scripts/test-workers/sqlite-campaign-authorize-worker.mjs",
            import.meta.url
          ),
          {
            workerData: {
              dbPath: database,
              taskId,
              computeRequested,
              campaignPreferences: {
                allowContextual:
                  false
              }
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
  "SQLite campaign persists across broker restart",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const first =
      new SqliteFundingBroker(
        database
      );

    const created =
      first.createCampaign(
        campaign()
      );

    assert.equal(
      created.campaignId,
      "oss-builds"
    );

    assert.equal(
      created.pool
        .availableCredits,
      100
    );

    first.close();

    const restarted =
      new SqliteFundingBroker(
        database
      );

    const recovered =
      restarted
        .campaignSnapshot(
          "oss-builds"
        );

    assert.equal(
      recovered
        .capabilityType,
      "compute"
    );

    assert.equal(
      recovered
        .targetingMode,
      "universal"
    );

    assert.equal(
      recovered
        .pool
        .campaign
        .campaignId,
      "oss-builds"
    );

    restarted.close();
  }
);

test(
  "generic SQLite authorization cannot bypass campaign matching",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    broker.createCampaign(
      campaign()
    );

    const result =
      broker.authorize(
        task()
      );

    assert.equal(
      result.funded,
      false
    );

    assert.equal(
      result.reason,
      "NO_ELIGIBLE_SPONSOR_POOL"
    );

    assert.equal(
      broker
        .campaignSnapshot(
          "oss-builds"
        )
        .pool
        .availableCredits,
      100
    );

    broker.close();
  }
);

test(
  "contextual SQLite campaign requires explicit opt-in",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    broker.createCampaign(
      campaign({
        campaignId:
          "code-only",
        targetingMode:
          "contextual",
        eligibleTaskClasses: [
          "software-development"
        ]
      })
    );

    const declined =
      broker.authorizeCampaign(
        task(),
        {
          allowContextual:
            false
        }
      );

    assert.equal(
      declined.funded,
      false
    );

    assert.equal(
      declined.reason,
      "NO_ELIGIBLE_SPONSOR_CAMPAIGN"
    );

    const accepted =
      broker.authorizeCampaign(
        task(),
        {
          allowContextual:
            true
        }
      );

    assert.equal(
      accepted.funded,
      true
    );

    assert.equal(
      accepted.campaign
        .campaignId,
      "code-only"
    );

    broker.release(
      accepted
    );

    broker.close();
  }
);

test(
  "constructor campaign preferences work with normal execution flow",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const setup =
      new SqliteFundingBroker(
        database
      );

    setup.createCampaign(
      campaign({
        campaignId:
          "context-builds",
        targetingMode:
          "contextual",
        eligibleTaskClasses: [
          "software-development"
        ]
      })
    );

    setup.close();

    const broker =
      new SqliteFundingBroker(
        database,
        {
          campaignPreferences: {
            allowContextual:
              true,
            allowedCapabilityTypes: [
              "compute"
            ]
          }
        }
      );

    let observed;

    const execution =
      await executeSponsoredTask({
        task: task(),
        broker,
        runner:
          async (envelope) => {
            observed =
              envelope;

            return {
              completed: true,
              computeUnitsUsed: 12
            };
          }
      });

    assert.equal(
      execution.funded,
      true
    );

    assert.equal(
      execution.receipt
        .campaign
        .campaignId,
      "context-builds"
    );

    assert.equal(
      execution.receipt
        .campaign
        .dataShared,
      "none"
    );

    assert.equal(
      execution.receipt
        .campaign
        .influence,
      "none"
    );

    assert.deepEqual(
      Object.keys(
        observed.authorization
      ).sort(),
      [
        "computeUnits",
        "grantId"
      ]
    );

    assert.equal(
      JSON.stringify(observed)
        .includes(
          "ExampleCloud"
        ),
      false
    );

    const snapshot =
      broker
        .campaignSnapshot(
          "context-builds"
        );

    assert.equal(
      snapshot.pool
        .availableCredits,
      88
    );

    assert.equal(
      snapshot.pool
        .spentCredits,
      12
    );

    broker.close();
  }
);

test(
  "campaign filters block campaign before reservation",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    broker.createCampaign(
      campaign()
    );

    const blocked =
      broker.authorizeCampaign(
        task(),
        {
          blockedCampaignIds: [
            "oss-builds"
          ]
        }
      );

    assert.equal(
      blocked.funded,
      false
    );

    const wrongCapability =
      broker.authorizeCampaign(
        task(),
        {
          allowedCapabilityTypes: [
            "ci"
          ]
        }
      );

    assert.equal(
      wrongCapability.funded,
      false
    );

    assert.equal(
      broker
        .campaignSnapshot(
          "oss-builds"
        )
        .pool
        .availableCredits,
      100
    );

    broker.close();
  }
);

test(
  "two independent workers cannot overspend one campaign budget",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const setup =
      new SqliteFundingBroker(
        database
      );

    setup.createCampaign(
      campaign({
        budgetCredits: 30,
        maxComputePerGrant: 20
      })
    );

    setup.close();

    const [a, b] =
      await Promise.all([
        runWorker(
          database,
          "worker-a",
          20
        ),
        runWorker(
          database,
          "worker-b",
          20
        )
      ]);

    assert.equal(
      [a, b].filter(
        (result) =>
          result.funded ===
          true
      ).length,
      1
    );

    assert.equal(
      [a, b].filter(
        (result) =>
          result.reason ===
          "NO_ELIGIBLE_SPONSOR_CAMPAIGN"
      ).length,
      1
    );

    const inspect =
      new SqliteFundingBroker(
        database
      );

    const snapshot =
      inspect
        .campaignSnapshot(
          "oss-builds"
        );

    assert.equal(
      snapshot.pool
        .availableCredits,
      10
    );

    assert.equal(
      snapshot.pool
        .reservedCredits,
      20
    );

    assert.equal(
      snapshot.pool
        .spentCredits,
      0
    );

    inspect.close();
  }
);

test(
  "invalid campaign is rejected atomically without orphan pool",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const broker =
      new SqliteFundingBroker(
        database
      );

    assert.throws(
      () =>
        broker.createCampaign(
          campaign({
            experience: {
              forcedViewing:
                true
            }
          })
        ),
      /violates contract/
    );

    assert.equal(
      broker.listCampaigns()
        .length,
      0
    );

    assert.equal(
      broker.listPools()
        .length,
      0
    );

    broker.close();
  }
);

test(
  "old SQLite grants table migrates campaign_json column",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      DatabaseSync
    } =
      await import(
        "node:sqlite"
      );

    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const database =
      dbPath();

    const legacy =
      new DatabaseSync(
        database
      );

    legacy.exec(`
CREATE TABLE sponsor_pools (
  id TEXT PRIMARY KEY,
  sponsor_disclosure TEXT NOT NULL,
  available_credits INTEGER NOT NULL,
  reserved_credits INTEGER NOT NULL,
  spent_credits INTEGER NOT NULL,
  eligible_task_classes TEXT NOT NULL,
  allowed_privacy_modes TEXT NOT NULL,
  max_compute_per_grant INTEGER
);

CREATE TABLE grants (
  grant_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  task_class TEXT NOT NULL,
  privacy TEXT NOT NULL,
  compute_units INTEGER NOT NULL,
  sponsor_disclosure TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT
);
`);

    legacy.close();

    const migrated =
      new SqliteFundingBroker(
        database,
        {
          autoReconcile:
            false
        }
      );

    migrated.close();

    const inspect =
      new DatabaseSync(
        database
      );

    const columns =
      inspect
        .prepare(
          "PRAGMA table_info(grants)"
        )
        .all()
        .map(
          (row) =>
            String(row.name)
        );

    assert.equal(
      columns.includes(
        "campaign_json"
      ),
      true
    );

    const campaignTable =
      inspect
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sponsor_campaigns'"
        )
        .get();

    assert.equal(
      campaignTable.name,
      "sponsor_campaigns"
    );

    inspect.close();
  }
);
