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

if (!sqliteAvailable) {
  console.log(
    "SQLite campaign demo skipped: node:sqlite requires Node 22.5+."
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
          "sponsorrail-campaign-demo-"
        )
      ),
      "campaign.db"
    );

  const setup =
    new SqliteFundingBroker(
      database
    );

  setup.createCampaign({
    campaignId:
      "open-source-builds",
    sponsorDisclosure:
      "Example Compute Patron",
    capabilityType:
      "compute",
    benefitDescription:
      "Funds agent build compute",
    targetingMode:
      "universal",
    budgetCredits: 50,
    eligibleTaskClasses:
      ["*"],
    allowedPrivacyModes:
      ["blind"],
    maxComputePerGrant: 25
  });

  setup.close();

  const broker =
    new SqliteFundingBroker(
      database,
      {
        campaignPreferences: {
          allowContextual:
            false,
          allowedCapabilityTypes:
            ["compute"]
        }
      }
    );

  const execution =
    await executeSponsoredTask({
      task: {
        id:
          "sqlite-campaign-demo",
        taskClass:
          "software-development",
        computeRequested: 20,
        privacy: "blind",
        allowSponsorship: true,
        prompt:
          "Perform the private task.",
        repositoryContext:
          "Private source context."
      },
      broker,
      runner:
        async () => ({
          completed: true,
          computeUnitsUsed: 12
        })
    });

  console.log(
    "Campaign:",
    execution.receipt
      .campaign
  );

  console.log(
    "Accounting:",
    broker
      .campaignSnapshot(
        "open-source-builds"
      )
      .pool
  );

  broker.close();
}
