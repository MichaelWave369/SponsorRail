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
    "Funding reversal demo skipped: node:sqlite requires Node 22.5+."
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
          "sponsorrail-reversal-demo-"
        )
      ),
      "reversal.db"
    );

  const broker =
    new SqliteFundingBroker(
      database
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
        keys.privateKey
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
        "demo-payment"
    }),
    registry
  );

  console.log(
    "Before reversal:",
    broker.fundingSnapshot(
      "demo-campaign"
    )
  );

  const reversal =
    source.issueReversal({
      originalDepositId:
        "demo-deposit",
      campaignId:
        "demo-campaign",
      credits: 7,
      reason: "refund",
      reversalId:
        "demo-refund"
    });

  console.log(
    "Reversal:",
    broker.applyFundingReversal(
      reversal,
      registry
    )
  );

  console.log(
    "After reversal:",
    broker.fundingSnapshot(
      "demo-campaign"
    )
  );

  broker.close();
}
