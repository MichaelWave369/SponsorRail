import {
  FundingBroker,
  SponsorCampaignRegistry,
  executeSponsoredTask
} from "../src/index.js";

const registry =
  new SponsorCampaignRegistry([
    {
      campaignId:
        "open-source-builds",
      sponsorDisclosure:
        "Example Compute Patron",
      capabilityType:
        "compute",
      benefitDescription:
        "Funds open-source agent compute",
      budgetCredits: 100,
      eligibleTaskClasses: [
        "*"
      ],
      allowedPrivacyModes: [
        "blind"
      ],
      maxComputePerGrant: 25,
      targetingMode:
        "universal"
    }
  ]);

const task = {
  id: "campaign-demo",
  taskClass:
    "software-development",
  computeRequested: 20,
  privacy: "blind",
  allowSponsorship: true,
  prompt:
    "Implement the private task.",
  repositoryContext:
    "Private repository context."
};

const matches =
  registry.match(task);

console.log(
  "Visible sponsorship:",
  matches[0].campaign
);

const broker =
  new FundingBroker(
    registry.poolsFor(task)
  );

const execution =
  await executeSponsoredTask({
    task,
    broker,
    runner:
      async ({
        modelContext,
        authorization
      }) => {
        console.log(
          "Agent authorization:",
          authorization
        );

        console.log(
          "Sponsor visible to agent:",
          JSON.stringify(
            modelContext
          ).includes(
            "Example Compute Patron"
          )
        );

        return {
          completed: true,
          computeUnitsUsed: 12
        };
      }
  });

console.log(
  "Campaign receipt:",
  execution.receipt
    .campaign
);
