import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
        "sponsorrail-reconciliation-"
      )
    );

  return join(
    dir,
    "reconciliation.db"
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

function source() {
  const keys =
    createFundingSourceKeyPair();

  const fundingSource =
    new SignedFundingSource({
      sourceId:
        "source.example",
      privateKey:
        keys.privateKey,
      now:
        () => 10_000
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

async function setup() {
  const {
    SqliteFundingBroker
  } =
    await loadSqliteBackend();

  const database =
    dbPath();

  const broker =
    new SqliteFundingBroker(
      database,
      {
        now:
          () => 20_000
      }
    );

  broker.createCampaign(
    campaign()
  );

  const funding =
    source();

  return {
    database,
    broker,
    ...funding
  };
}

test(
  "internal funding audit proves campaign conservation",
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
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 20,
          depositId:
            "deposit-1",
          externalReference:
            "payment-1",
          occurredAt: 1000
        }),
      registry
    );

    broker.applyFundingReversal(
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit-1",
          campaignId:
            "campaign",
          credits: 4,
          reason: "refund",
          reversalId:
            "refund-1",
          occurredAt: 2000
        }),
      registry
    );

    const audit =
      broker.auditCampaignFunding(
        "campaign"
      );

    assert.equal(
      audit.healthy,
      true
    );

    assert.equal(
      audit.balanceDelta,
      0
    );

    assert.equal(
      audit
        .economicFundingCredits,
      17
    );

    assert.equal(
      audit
        .liabilityAdjustedBookCredits,
      17
    );

    assert.equal(
      audit
        .exposureViolationCount,
      0
    );

    broker.close();
  }
);

test(
  "internal funding audit detects raw balance corruption",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      database,
      broker,
      fundingSource,
      registry
    } =
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 10,
          depositId:
            "deposit-corrupt",
          externalReference:
            "payment-corrupt",
          occurredAt: 1000
        }),
      registry
    );

    broker.close();

    const {
      DatabaseSync
    } =
      await import(
        "node:sqlite"
      );

    const raw =
      new DatabaseSync(
        database
      );

    raw
      .prepare(
        "UPDATE sponsor_pools SET available_credits = available_credits + 3 WHERE id = ?"
      )
      .run(
        "campaign:campaign"
      );

    raw.close();

    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const inspect =
      new SqliteFundingBroker(
        database
      );

    const audit =
      inspect
        .auditCampaignFunding(
          "campaign"
        );

    assert.equal(
      audit.healthy,
      false
    );

    assert.equal(
      audit.balanceDelta,
      3
    );

    inspect.close();
  }
);

test(
  "signed statement matches local source ledger",
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
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 20,
          depositId:
            "deposit-match",
          externalReference:
            "payment-match",
          occurredAt: 1000
        }),
      registry
    );

    broker.applyFundingReversal(
      fundingSource
        .issueReversal({
          originalDepositId:
            "deposit-match",
          campaignId:
            "campaign",
          credits: 4,
          reason: "refund",
          reversalId:
            "refund-match",
          occurredAt: 2000
        }),
      registry
    );

    broker.placeFundingHold(
      fundingSource
        .issueHold({
          originalDepositId:
            "deposit-match",
          campaignId:
            "campaign",
          credits: 5,
          reason: "dispute",
          holdId:
            "hold-match",
          occurredAt: 3000
        }),
      registry
    );

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign",
          depositedCredits: 20,
          reversedCredits: 4,
          activeHoldCredits: 5,
          statementId:
            "statement-match",
          asOf: 3500
        });

    const report =
      broker
        .reconcileFundingStatement(
          statement,
          registry
        );

    assert.equal(
      report.matched,
      true
    );

    assert.deepEqual(
      report.deltas,
      {
        depositedCredits: 0,
        reversedCredits: 0,
        activeHoldCredits: 0
      }
    );

    assert.equal(
      report.local.depositCount,
      1
    );

    assert.equal(
      report.local.reversalCount,
      1
    );

    assert.equal(
      report.local.activeHoldCount,
      1
    );

    broker.close();
  }
);

test(
  "reconciliation reconstructs hold state as of statement time",
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
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 20,
          depositId:
            "deposit-history",
          externalReference:
            "payment-history",
          occurredAt: 1000
        }),
      registry
    );

    broker.placeFundingHold(
      fundingSource
        .issueHold({
          originalDepositId:
            "deposit-history",
          campaignId:
            "campaign",
          credits: 7,
          reason: "dispute",
          holdId:
            "hold-history",
          occurredAt: 2000
        }),
      registry
    );

    broker.resolveFundingHold(
      fundingSource
        .issueHoldResolution({
          holdId:
            "hold-history",
          originalDepositId:
            "deposit-history",
          campaignId:
            "campaign",
          outcome: "release",
          reason:
            "dispute_won",
          resolutionId:
            "resolution-history",
          occurredAt: 4000
        }),
      registry
    );

    assert.equal(
      broker.fundingSnapshot(
        "campaign"
      ).activeHoldCount,
      0
    );

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign",
          depositedCredits: 20,
          reversedCredits: 0,
          activeHoldCredits: 7,
          statementId:
            "statement-history",
          asOf: 3000
        });

    const report =
      broker
        .reconcileFundingStatement(
          statement,
          registry
        );

    assert.equal(
      report.matched,
      true
    );

    assert.equal(
      report.local
        .activeHoldCredits,
      7
    );

    broker.close();
  }
);

test(
  "mismatch is persisted as evidence and never mutates balances",
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
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 20,
          depositId:
            "deposit-mismatch",
          externalReference:
            "payment-mismatch",
          occurredAt: 1000
        }),
      registry
    );

    const before =
      broker.fundingSnapshot(
        "campaign"
      );

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign",
          depositedCredits: 19,
          reversedCredits: 0,
          activeHoldCredits: 0,
          statementId:
            "statement-mismatch",
          asOf: 3000
        });

    const report =
      broker
        .reconcileFundingStatement(
          statement,
          registry
        );

    const after =
      broker.fundingSnapshot(
        "campaign"
      );

    assert.equal(
      report.matched,
      false
    );

    assert.equal(
      report.deltas
        .depositedCredits,
      1
    );

    assert.deepEqual(
      {
        available:
          after
            .currentAvailableCredits,
        reserved:
          after
            .currentReservedCredits,
        spent:
          after
            .currentSpentCredits,
        liability:
          after
            .outstandingLiabilityCredits
      },
      {
        available:
          before
            .currentAvailableCredits,
        reserved:
          before
            .currentReservedCredits,
        spent:
          before
            .currentSpentCredits,
        liability:
          before
            .outstandingLiabilityCredits
      }
    );

    const mismatches =
      broker
        .listFundingReconciliations({
          matched: false
        });

    assert.equal(
      mismatches.length,
      1
    );

    assert.equal(
      mismatches[0].matched,
      false
    );

    broker.close();
  }
);

test(
  "statement reconciliation replay is idempotent and mutation conflicts",
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
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 10,
          depositId:
            "deposit-replay",
          externalReference:
            "payment-replay",
          occurredAt: 1000
        }),
      registry
    );

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign",
          depositedCredits: 10,
          reversedCredits: 0,
          activeHoldCredits: 0,
          statementId:
            "statement-replay",
          asOf: 3000
        });

    const first =
      broker
        .reconcileFundingStatement(
          statement,
          registry
        );

    const replay =
      broker
        .reconcileFundingStatement(
          statement,
          registry
        );

    assert.equal(
      first.idempotent,
      false
    );

    assert.equal(
      replay.idempotent,
      true
    );

    assert.equal(
      replay.reportHash,
      first.reportHash
    );

    const mutated =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign",
          depositedCredits: 9,
          reversedCredits: 0,
          activeHoldCredits: 0,
          statementId:
            "statement-replay",
          asOf: 3000
        });

    assert.throws(
      () =>
        broker
          .reconcileFundingStatement(
            mutated,
            registry
          ),
      /idempotency conflict/
    );

    broker.close();
  }
);

test(
  "reconciliation is scoped to one registered funding source",
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
      await setup();

    broker.depositCampaign(
      fundingSource
        .issueDeposit({
          campaignId:
            "campaign",
          credits: 10,
          depositId:
            "source-a",
          externalReference:
            "payment-a",
          occurredAt: 1000
        }),
      registry
    );

    const otherKeys =
      createFundingSourceKeyPair();

    const other =
      new SignedFundingSource({
        sourceId:
          "source.other",
        privateKey:
          otherKeys.privateKey,
        now:
          () => 10_000
      });

    registry.register({
      sourceId:
        "source.other",
      publicKey:
        otherKeys.publicKey
    });

    broker.depositCampaign(
      other.issueDeposit({
        campaignId:
          "campaign",
        credits: 8,
        depositId:
          "source-b",
        externalReference:
          "payment-b",
        occurredAt: 1000
      }),
      registry
    );

    const statement =
      fundingSource
        .issueStatement({
          campaignId:
            "campaign",
          depositedCredits: 10,
          reversedCredits: 0,
          activeHoldCredits: 0,
          statementId:
            "statement-source-a",
          asOf: 3000
        });

    const report =
      broker
        .reconcileFundingStatement(
          statement,
          registry
        );

    assert.equal(
      report.matched,
      true
    );

    assert.equal(
      report.local
        .depositedCredits,
      10
    );

    broker.close();
  }
);
