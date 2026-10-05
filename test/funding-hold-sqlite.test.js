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
        "sponsorrail-hold-"
      )
    );

  return join(
    dir,
    "hold.db"
  );
}

function campaign() {
  return {
    campaignId: "campaign",
    sponsorDisclosure:
      "Example Sponsor",
    capabilityType: "compute",
    benefitDescription:
      "Funds useful compute",
    targetingMode: "universal",
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
    computeRequested: 5,
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

async function setup(
  depositCredits = 20
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

  broker.depositCampaign(
    funding.fundingSource
      .issueDeposit({
        campaignId: "campaign",
        credits:
          depositCredits,
        depositId: "deposit",
        externalReference:
          "payment"
      }),
    funding.registry
  );

  return {
    database,
    broker,
    ...funding
  };
}

function runHoldWorker(
  database,
  receipt,
  publicKey
) {
  return new Promise(
    (resolve, reject) => {
      const worker =
        new Worker(
          new URL(
            "../scripts/test-workers/sqlite-funding-hold-worker.mjs",
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

test(
  "fully funded hold quarantines campaign credits",
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
      await setup(20);

    const hold =
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 7,
        reason: "dispute",
        holdId: "hold-1"
      });

    const placed =
      broker.placeFundingHold(
        hold,
        registry
      );

    assert.equal(
      placed.heldCredits,
      7
    );

    assert.equal(
      placed.unfundedCredits,
      0
    );

    const snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHoldCount,
      1
    );

    assert.equal(
      snapshot.activeHeldCredits,
      7
    );

    assert.equal(
      snapshot
        .outstandingHoldCredits,
      0
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      14
    );

    broker.close();
  }
);

test(
  "uncovered hold deficit absorbs new deposits before availability",
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
      await setup(10);

    broker.authorizeCampaign(
      task({
        id: "reserved-before-hold",
        computeRequested: 5
      })
    );

    broker.placeFundingHold(
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 8,
        reason: "dispute",
        holdId: "hold-deficit"
      }),
      registry
    );

    let snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHeldCredits,
      6
    );

    assert.equal(
      snapshot
        .outstandingHoldCredits,
      2
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      0
    );

    const topup =
      broker.depositCampaign(
        fundingSource
          .issueDeposit({
            campaignId:
              "campaign",
            credits: 3,
            depositId: "topup",
            externalReference:
              "topup-payment"
          }),
        registry
      );

    assert.equal(
      topup.holdCoverageAdded,
      2
    );

    assert.equal(
      topup.availableAdded,
      1
    );

    snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHeldCredits,
      8
    );

    assert.equal(
      snapshot
        .outstandingHoldCredits,
      0
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      1
    );

    broker.close();
  }
);

test(
  "released reservation covers hold deficit before becoming available",
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
      await setup(20);

    const grant =
      broker.authorizeCampaign(
        task({
          computeRequested: 15
        })
      );

    broker.placeFundingHold(
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 10,
        reason: "dispute",
        holdId:
          "hold-reservation"
      }),
      registry
    );

    let snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHeldCredits,
      6
    );

    assert.equal(
      snapshot
        .outstandingHoldCredits,
      4
    );

    assert.equal(
      snapshot
        .currentReservedCredits,
      15
    );

    broker.release(grant);

    snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHeldCredits,
      10
    );

    assert.equal(
      snapshot
        .outstandingHoldCredits,
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
  "winning dispute releases quarantined credits and clears provisional deficit",
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
      await setup(10);

    broker.authorizeCampaign(
      task({
        id: "reserved-before-win",
        computeRequested: 5
      })
    );

    broker.placeFundingHold(
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 8,
        reason: "dispute",
        holdId: "hold-won"
      }),
      registry
    );

    const resolution =
      fundingSource
        .issueHoldResolution({
          holdId: "hold-won",
          originalDepositId:
            "deposit",
          campaignId: "campaign",
          outcome: "release",
          reason: "dispute_won",
          resolutionId:
            "resolution-won"
        });

    const result =
      broker.resolveFundingHold(
        resolution,
        registry
      );

    assert.equal(
      result.releasedHeldCredits,
      6
    );

    assert.equal(
      result.clearedUnfundedCredits,
      2
    );

    const snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHoldCount,
      0
    );

    assert.equal(
      snapshot
        .outstandingHoldCredits,
      0
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      6
    );

    broker.close();
  }
);

test(
  "lost dispute converts hold to permanent reversal and liability",
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
      await setup(10);

    broker.authorizeCampaign(
      task({
        id: "reserved-before-loss",
        computeRequested: 5
      })
    );

    broker.placeFundingHold(
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 8,
        reason: "dispute",
        holdId: "hold-lost"
      }),
      registry
    );

    const result =
      broker.resolveFundingHold(
        fundingSource
          .issueHoldResolution({
            holdId:
              "hold-lost",
            originalDepositId:
              "deposit",
            campaignId:
              "campaign",
            outcome: "reverse",
            reason:
              "dispute_loss",
            resolutionId:
              "resolution-lost"
          }),
        registry
      );

    assert.equal(
      result.consumedHeldCredits,
      6
    );

    assert.equal(
      result.liabilityAdded,
      2
    );

    const snapshot =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      snapshot.activeHoldCount,
      0
    );

    assert.equal(
      snapshot
        .verifiedReversalCredits,
      8
    );

    assert.equal(
      snapshot
        .outstandingLiabilityCredits,
      2
    );

    assert.equal(
      snapshot
        .currentAvailableCredits,
      0
    );

    broker.close();
  }
);

test(
  "active holds and reversals cannot over-claim one deposit",
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
      await setup(10);

    broker.placeFundingHold(
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 7,
        reason: "dispute",
        holdId: "hold-exposure"
      }),
      registry
    );

    assert.throws(
      () =>
        broker.applyFundingReversal(
          fundingSource
            .issueReversal({
              originalDepositId:
                "deposit",
              campaignId:
                "campaign",
              credits: 4,
              reason: "refund",
              reversalId:
                "refund-overlap"
            }),
          registry
        ),
      /exceeds unheld deposit credits/
    );

    assert.throws(
      () =>
        broker.placeFundingHold(
          fundingSource
            .issueHold({
              originalDepositId:
                "deposit",
              campaignId:
                "campaign",
              credits: 4,
              reason: "dispute",
              holdId:
                "hold-overlap"
            }),
          registry
        ),
      /exceeds remaining deposit credits/
    );

    broker.close();
  }
);

test(
  "exact hold and resolution replays are idempotent",
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
      await setup(10);

    const hold =
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 5,
        reason: "dispute",
        holdId:
          "hold-replay"
      });

    broker.placeFundingHold(
      hold,
      registry
    );

    const holdReplay =
      broker.placeFundingHold(
        hold,
        registry
      );

    assert.equal(
      holdReplay.idempotent,
      true
    );

    const resolution =
      fundingSource
        .issueHoldResolution({
          holdId:
            "hold-replay",
          originalDepositId:
            "deposit",
          campaignId:
            "campaign",
          outcome: "release",
          reason:
            "dispute_won",
          resolutionId:
            "resolution-replay"
        });

    broker.resolveFundingHold(
      resolution,
      registry
    );

    const replay =
      broker.resolveFundingHold(
        resolution,
        registry
      );

    assert.equal(
      replay.idempotent,
      true
    );

    broker.close();
  }
);

test(
  "concurrent placement of one signed hold quarantines credits once",
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
      await setup(20);

    const hold =
      fundingSource.issueHold({
        originalDepositId:
          "deposit",
        campaignId: "campaign",
        credits: 7,
        reason: "dispute",
        holdId:
          "hold-concurrent",
        externalReference:
          "dispute-concurrent"
      });

    broker.close();

    const [a, b] =
      await Promise.all([
        runHoldWorker(
          database,
          hold,
          keys.publicKey
        ),
        runHoldWorker(
          database,
          hold,
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
      inspect.fundingSnapshot(
        "campaign"
      ).activeHeldCredits,
      7
    );

    assert.equal(
      inspect.campaignSnapshot(
        "campaign"
      ).pool.availableCredits,
      14
    );

    inspect.close();
  }
);
