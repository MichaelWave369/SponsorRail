import {
  FundingSourceRegistry,
  SignedFundingSource,
  createFundingSourceKeyPair,
  loadSqliteBackend,
  verifyFundingDeposit
} from "../src/index.js";

const keys =
  createFundingSourceKeyPair();

const source =
  new SignedFundingSource({
    sourceId:
      "funding.demo",
    privateKey:
      keys.privateKey
  });

const registry =
  new FundingSourceRegistry([
    {
      sourceId:
        "funding.demo",
      publicKey:
        keys.publicKey
    }
  ]);

const receipt =
  source.issueDeposit({
    campaignId:
      "demo-campaign",
    credits: 25,
    externalReference:
      "demo-payment-001"
  });

console.log(
  "Funding receipt valid:",
  verifyFundingDeposit(
    receipt,
    registry
  )
);

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
    "SQLite deposit demo skipped: node:sqlite requires Node 22.5+."
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
          "sponsorrail-funding-demo-"
        )
      ),
      "funding.db"
    );

  const broker =
    new SqliteFundingBroker(
      database
    );

  broker.createCampaign({
    campaignId:
      "demo-campaign",
    sponsorDisclosure:
      "Example Compute Patron",
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
    maxComputePerGrant: 50
  });

  console.log(
    "Deposit result:",
    broker.depositCampaign(
      receipt,
      registry
    )
  );

  console.log(
    "Idempotent replay:",
    broker.depositCampaign(
      receipt,
      registry
    )
  );

  console.log(
    "Funding snapshot:",
    broker.fundingSnapshot(
      "demo-campaign"
    )
  );

  broker.close();
}
