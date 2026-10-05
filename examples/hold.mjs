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
    "Funding hold demo skipped: node:sqlite requires Node 22.5+."
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
          "sponsorrail-hold-demo-"
        )
      ),
      "hold.db"
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

  const hold =
    source.issueHold({
      originalDepositId:
        "demo-deposit",
      campaignId:
        "demo-campaign",
      credits: 7,
      reason: "dispute",
      holdId:
        "demo-dispute"
    });

  console.log(
    "Placed hold:",
    broker.placeFundingHold(
      hold,
      registry
    )
  );

  console.log(
    "While disputed:",
    broker.fundingSnapshot(
      "demo-campaign"
    )
  );

  const release =
    source.issueHoldResolution({
      holdId:
        "demo-dispute",
      originalDepositId:
        "demo-deposit",
      campaignId:
        "demo-campaign",
      outcome: "release",
      reason: "dispute_won",
      resolutionId:
        "demo-dispute-won"
    });

  console.log(
    "Released hold:",
    broker.resolveFundingHold(
      release,
      registry
    )
  );

  console.log(
    "After resolution:",
    broker.fundingSnapshot(
      "demo-campaign"
    )
  );

  broker.close();
}
