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

if (!sqliteAvailable) {
  console.log(
    "Funding reconciliation demo skipped: node:sqlite requires Node 22.5+."
  );
} else {
  const {
    mkdtempSync
  } = await import("node:fs");

  const {
    join
  } = await import("node:path");

  const {
    tmpdir
  } = await import("node:os");

  const {
    SqliteFundingBroker
  } =
    await loadSqliteBackend();

  const database =
    join(
      mkdtempSync(
        join(
          tmpdir(),
          "sponsorrail-reconcile-demo-"
        )
      ),
      "reconcile.db"
    );

  const broker =
    new SqliteFundingBroker(
      database,
      {
        now:
          () => 20_000
      }
    );

  broker.createCampaign({
    campaignId:
      "demo-campaign",
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
  });

  const keys =
    createFundingSourceKeyPair();

  const source =
    new SignedFundingSource({
      sourceId:
        "funding.demo.v1",
      privateKey:
        keys.privateKey,
      now:
        () => 10_000
    });

  const registry =
    new FundingSourceRegistry([
      {
        sourceId:
          "funding.demo.v1",
        publicKey:
          keys.publicKey
      }
    ]);

  broker.depositCampaign(
    source.issueDeposit({
      campaignId:
        "demo-campaign",
      credits: 20,
      depositId:
        "demo-deposit",
      externalReference:
        "demo-payment",
      occurredAt: 1000
    }),
    registry
  );

  broker.applyFundingReversal(
    source.issueReversal({
      originalDepositId:
        "demo-deposit",
      campaignId:
        "demo-campaign",
      credits: 4,
      reason: "refund",
      reversalId:
        "demo-refund",
      occurredAt: 2000
    }),
    registry
  );

  const statement =
    source.issueStatement({
      campaignId:
        "demo-campaign",
      depositedCredits: 20,
      reversedCredits: 4,
      activeHoldCredits: 0,
      statementId:
        "demo-statement",
      asOf: 3000
    });

  console.log(
    "Internal audit:",
    broker.auditCampaignFunding(
      "demo-campaign"
    )
  );

  console.log(
    "External reconciliation:",
    broker.reconcileFundingStatement(
      statement,
      registry
    )
  );

  broker.close();
}
