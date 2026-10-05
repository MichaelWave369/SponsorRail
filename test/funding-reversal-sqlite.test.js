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
        "sponsorrail-reversal-"
      )
    );

  return join(
    dir,
    "reversal.db"
  );
}

function campaign() {
  return {
    campaignId:
      "campaign",
    sponsorDisclosure:
      "Example Sponsor",
    capabilityType:
      "compute",
    benefitDescription:
      "Funds useful compute",
    targetingMode:
      "universal",
    budgetCredits: 1,
    eligibleTaskClasses:
      ["*"],
    allowedPrivacyModes:
      ["blind"],
    maxComputePerGrant: 100
  };
}

function task(
  overrides = {}
) {
  return {
    id: "task",
    taskClass:
      "software-development",
    computeRequested: 10,
    privacy: "blind",
    allowSponsorship: true,
    prompt: "private",
    ...overrides
  };
}

function source() {
  const keys =
    createFundingSourceKeyPair();

  const fundingSource =
    new SignedFundingSource({
      sourceId:
        "source.example",
      privateKey:
        keys.privateKey,
      now: () => 1000
    });

  const registry =
    new FundingSourceRegistry([
      {
        sourceId:
          "source.example",
        publicKey:
          keys.publicKey
      }
    ]);

  return {
    keys,
    fundingSource,
    registry
  };
}

function runWorker(
  database,
  receipt,
  publicKey
) {
  return new Promise(
    (resolve, reject) => {
      const worker =
        new Worker(
          new URL(
            "../scripts/test-workers/sqlite-funding-reversal-worker.mjs",
            import.meta.url
          ),
          {
            workerData: {
              dbPath: database,
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

async function setupDeposit(
  credits = 20
) {
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

  const funding =
    source();

  const deposit =
    funding
      .fundingSource
      .issueDeposit({
        campaignId:
          "campaign",
        credits,
        depositId:
          "deposit",
        externalReference:
          "payment"
      });

  broker.depositCampaign(
    deposit,
    funding.registry
  );

  return {
    database,
    broker,
    deposit,
    ...funding
  };
}

test(
  "funding reversal debits available credits without rewriting history",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      broker,
      fundingSource,
      registry
    } =
      await setupDeposit(20);

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit",
          campaignId:
            "campaign",
          credits: 7,
          reason: "refund",
          reversalId:
            "refund-1"
        });

    const result =
      broker
        .applyFundingReversal(
          reversal,
          registry
        );

    assert.equal(
      result.availableDebited,
      7
    );

    assert.equal(
      result.liabilityAdded,
      0
    );

    const snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot
        .verifiedDepositCredits,
      20
    );

    assert.equal(
      snapshot
        .verifiedReversalCredits,
      7
    );

    assert.equal(
      snapshot
        .netVerifiedFundingCredits,
      13
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      14
    );

    assert.equal(
      snapshot
        .currentSpentCredits,
      0
    );

    broker.close();
  }
);

test(
  "exact funding reversal replay is idempotent",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      broker,
      fundingSource,
      registry
    } =
      await setupDeposit(20);

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit",
          campaignId:
            "campaign",
          credits: 7,
          reason: "refund",
          reversalId:
            "same-reversal"
        });

    const first =
      broker
        .applyFundingReversal(
          reversal,
          registry
        );

    const replay =
      broker
        .applyFundingReversal(
          reversal,
          registry
        );

    assert.equal(
      first.applied,
      true
    );

    assert.equal(
      replay.idempotent,
      true
    );

    assert.equal(
      broker
        .fundingSnapshot(
          "campaign"
        )
        .verifiedReversalCredits,
      7
    );

    broker.close();
  }
);

test(
  "reversals cannot exceed original deposit credits",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      broker,
      fundingSource,
      registry
    } =
      await setupDeposit(10);

    broker.applyFundingReversal(
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit",
          campaignId:
            "campaign",
          credits: 6,
          reason: "refund",
          reversalId: "r1"
        }),
      registry
    );

    assert.throws(
      () =>
        broker
          .applyFundingReversal(
            fundingSource
              .issueReversal({
                originalDepositId:
                  "deposit",
                campaignId:
                  "campaign",
                credits: 5,
                reason: "refund",
                reversalId:
                  "r2"
              }),
            registry
          ),
      /exceeds remaining deposit credits/
    );

    broker.close();
  }
);

test(
  "reversal creates liability when credits are reserved and blocks new campaign work",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      broker,
      fundingSource,
      registry
    } =
      await setupDeposit(20);

    const grant =
      broker.authorizeCampaign(
        task({
          computeRequested:
            15
        })
      );

    assert.equal(
      grant.funded,
      true
    );

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit",
          campaignId:
            "campaign",
          credits: 10,
          reason:
            "dispute_loss",
          reversalId:
            "dispute"
        });

    const applied =
      broker
        .applyFundingReversal(
          reversal,
          registry
        );

    assert.equal(
      applied.availableDebited,
      6
    );

    assert.equal(
      applied.liabilityAdded,
      4
    );

    let snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot
        .outstandingLiabilityCredits,
      4
    );

    assert.equal(
      snapshot
        .currentReservedCredits,
      15
    );

    assert.equal(
      broker
        .authorizeCampaign(
          task({
            id: "blocked",
            computeRequested:
              1
          })
        )
        .funded,
      false
    );

    broker.release(grant);

    snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot
        .outstandingLiabilityCredits,
      0
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      11
    );

    assert.equal(
      snapshot
        .currentReservedCredits,
      0
    );

    broker.close();
  }
);

test(
  "new deposits cure reversal liability before becoming spendable",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      broker,
      fundingSource,
      registry
    } =
      await setupDeposit(5);

    const grant =
      broker.authorizeCampaign(
        task({
          computeRequested:
            6
        })
      );

    assert.equal(
      grant.funded,
      true
    );

    broker
      .applyFundingReversal(
        fundingSource
          .issueReversal({
            originalDepositId:
              "deposit",
            campaignId:
              "campaign",
            credits: 5,
            reason: "refund",
            reversalId:
              "refund"
          }),
        registry
      );

    let snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot
        .outstandingLiabilityCredits,
      5
    );

    const topup =
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 3,
          depositId:
            "topup",
          externalReference:
            "topup-payment"
        });

    const allocation =
      broker.depositCampaign(
        topup,
        registry
      );

    assert.equal(
      allocation
        .liabilityPaid,
      3
    );

    assert.equal(
      allocation
        .availableAdded,
      0
    );

    snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot
        .outstandingLiabilityCredits,
      2
    );

    broker.release(grant);

    snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot
        .outstandingLiabilityCredits,
      0
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      4
    );

    broker.close();
  }
);

test(
  "concurrent replay of one reversal debits campaign exactly once",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      database,
      broker,
      keys,
      fundingSource
    } =
      await setupDeposit(20);

    broker.close();

    const reversal =
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit",
          campaignId:
            "campaign",
          credits: 7,
          reason: "refund",
          reversalId:
            "concurrent-refund",
          externalReference:
            "refund-ext"
        });

    const [a, b] =
      await Promise.all([
        runWorker(
          database,
          reversal,
          keys.publicKey
        ),
        runWorker(
          database,
          reversal,
          keys.publicKey
        )
      ]);

    assert.equal(
      [a, b].filter(
        (result) =>
          result.applied === true
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

    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const inspect =
      new SqliteFundingBroker(
        database
      );

    assert.equal(
      inspect
        .fundingSnapshot(
          "campaign"
        )
        .verifiedReversalCredits,
      7
    );

    assert.equal(
      inspect
        .listFundingReversals()
        .length,
      1
    );

    inspect.close();
  }
);
