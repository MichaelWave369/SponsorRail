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
  FundingSourceRegistry,
  SignedFundingSource,
  createFundingSourceKeyPair,
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
        "sponsorrail-funding-"
      )
    );

  return join(
    dir,
    "funding.db"
  );
}

function campaign(
  overrides = {}
) {
  return {
    campaignId:
      "funded-campaign",
    sponsorDisclosure:
      "Example Sponsor",
    capabilityType:
      "compute",
    benefitDescription:
      "Funds useful compute",
    targetingMode:
      "universal",
    budgetCredits: 10,
    eligibleTaskClasses:
      ["*"],
    allowedPrivacyModes:
      ["blind"],
    maxComputePerGrant: 50,
    ...overrides
  };
}

function fundingSource(
  overrides = {}
) {
  const keys =
    createFundingSourceKeyPair();

  const source =
    new SignedFundingSource({
      sourceId:
        "source.example",
      privateKey:
        keys.privateKey,
      now:
        () => 1000,
      ...overrides
    });

  const registry =
    new FundingSourceRegistry([
      {
        sourceId:
          source.sourceId,
        publicKey:
          keys.publicKey
      }
    ]);

  return {
    keys,
    source,
    registry
  };
}

function runDepositWorker(
  database,
  receipt,
  publicKey
) {
  return new Promise(
    (resolve, reject) => {
      const worker =
        new Worker(
          new URL(
            "../scripts/test-workers/sqlite-funding-deposit-worker.mjs",
            import.meta.url
          ),
          {
            workerData: {
              dbPath:
                database,
              receipt,
              sourceId:
                receipt.sourceId,
              publicKey
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
  "verified funding deposit atomically tops up campaign",
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

    const {
      source,
      registry
    } =
      fundingSource();

    const receipt =
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 25,
        depositId:
          "deposit-1",
        externalReference:
          "payment-1"
      });

    const result =
      broker.depositCampaign(
        receipt,
        registry
      );

    assert.equal(
      result.applied,
      true
    );

    const snapshot =
      broker.fundingSnapshot(
        "funded-campaign"
      );

    assert.equal(
      snapshot
        .operatorSeedCredits,
      10
    );

    assert.equal(
      snapshot
        .verifiedDepositCount,
      1
    );

    assert.equal(
      snapshot
        .verifiedDepositCredits,
      25
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      35
    );

    broker.close();
  }
);

test(
  "replaying exact deposit is idempotent and never double-credits",
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

    const {
      source,
      registry
    } =
      fundingSource();

    const receipt =
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 25,
        depositId:
          "deposit-replay"
      });

    const first =
      broker.depositCampaign(
        receipt,
        registry
      );

    const replay =
      broker.depositCampaign(
        receipt,
        registry
      );

    assert.equal(
      first.applied,
      true
    );

    assert.equal(
      replay.applied,
      false
    );

    assert.equal(
      replay.idempotent,
      true
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "funded-campaign"
        )
        .verifiedDepositCredits,
      25
    );

    assert.equal(
      broker
        .campaignSnapshot(
          "funded-campaign"
        )
        .pool
        .availableCredits,
      35
    );

    broker.close();
  }
);

test(
  "same deposit ID with different signed payload conflicts",
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

    const {
      source,
      registry
    } =
      fundingSource();

    const first =
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 25,
        depositId:
          "same-id"
      });

    const conflicting =
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 30,
        depositId:
          "same-id"
      });

    broker.depositCampaign(
      first,
      registry
    );

    assert.throws(
      () =>
        broker.depositCampaign(
          conflicting,
          registry
        ),
      /idempotency conflict/
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "funded-campaign"
        )
        .verifiedDepositCredits,
      25
    );

    broker.close();
  }
);

test(
  "external funding reference cannot be deposited twice under different IDs",
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

    const {
      source,
      registry
    } =
      fundingSource();

    broker.depositCampaign(
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 10,
        depositId:
          "one",
        externalReference:
          "payment-unique"
      }),
      registry
    );

    assert.throws(
      () =>
        broker.depositCampaign(
          source.issueDeposit({
            campaignId:
              "funded-campaign",
            credits: 10,
            depositId:
              "two",
            externalReference:
              "payment-unique"
          }),
          registry
        ),
      /external reference already deposited/
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "funded-campaign"
        )
        .verifiedDepositCredits,
      10
    );

    broker.close();
  }
);

test(
  "deposit ledger and campaign credits survive restart",
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

    const {
      source,
      registry
    } =
      fundingSource();

    const first =
      new SqliteFundingBroker(
        database
      );

    first.createCampaign(
      campaign()
    );

    first.depositCampaign(
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 15,
        depositId:
          "restart-deposit"
      }),
      registry
    );

    first.close();

    const restarted =
      new SqliteFundingBroker(
        database
      );

    assert.equal(
      restarted
        .listFundingDeposits({
          campaignId:
            "funded-campaign"
        })
        .length,
      1
    );

    assert.equal(
      restarted
        .campaignSnapshot(
          "funded-campaign"
        )
        .pool
        .availableCredits,
      25
    );

    restarted.close();
  }
);

test(
  "unknown campaign deposit fails without ledger entry",
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

    const {
      source,
      registry
    } =
      fundingSource();

    const receipt =
      source.issueDeposit({
        campaignId:
          "missing",
        credits: 10
      });

    assert.throws(
      () =>
        broker.depositCampaign(
          receipt,
          registry
        ),
      /unknown campaign/
    );

    assert.equal(
      broker
        .listFundingDeposits()
        .length,
      0
    );

    broker.close();
  }
);

test(
  "unregistered or tampered funding deposit cannot change balance",
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

    const {
      source
    } =
      fundingSource();

    const receipt =
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 10
      });

    assert.throws(
      () =>
        broker.depositCampaign(
          receipt,
          new FundingSourceRegistry()
        ),
      /verification failed/
    );

    assert.equal(
      broker
        .campaignSnapshot(
          "funded-campaign"
        )
        .pool
        .availableCredits,
      10
    );

    broker.close();
  }
);

test(
  "concurrent replay of one signed deposit credits campaign exactly once",
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
      campaign()
    );

    setup.close();

    const {
      keys,
      source
    } =
      fundingSource();

    const receipt =
      source.issueDeposit({
        campaignId:
          "funded-campaign",
        credits: 25,
        depositId:
          "concurrent-deposit",
        externalReference:
          "payment-concurrent"
      });

    const [a, b] =
      await Promise.all([
        runDepositWorker(
          database,
          receipt,
          keys.publicKey
        ),
        runDepositWorker(
          database,
          receipt,
          keys.publicKey
        )
      ]);

    assert.equal(
      [a, b].filter(
        (result) =>
          result.applied ===
          true
      ).length,
      1
    );

    assert.equal(
      [a, b].filter(
        (result) =>
          result.idempotent ===
          true
      ).length,
      1
    );

    const inspect =
      new SqliteFundingBroker(
        database
      );

    assert.equal(
      inspect
        .fundingSnapshot(
          "funded-campaign"
        )
        .verifiedDepositCredits,
      25
    );

    assert.equal(
      inspect
        .campaignSnapshot(
          "funded-campaign"
        )
        .pool
        .availableCredits,
      35
    );

    inspect.close();
  }
);
