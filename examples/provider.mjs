import {
  BlindSponsorPool,
  FundingBroker,
  ProviderRegistry,
  SignedComputeProvider,
  createProviderKeyPair,
  executeSponsoredProviderTask,
  verifyProviderUsageReceipt
} from "../src/index.js";

const providerKeys =
  createProviderKeyPair();

const provider =
  new SignedComputeProvider({
    providerId:
      "provider.local.demo",
    privateKey:
      providerKeys.privateKey,
    modelClass:
      "demo-local-model",
    executor:
      async ({
        modelContext,
        authorization
      }) => {
        console.log(
          "Provider received task:",
          modelContext.taskId
        );

        console.log(
          "Provider received grant:",
          authorization.grantId
        );

        return {
          completed: true,
          computeUnitsUsed: 12,
          output:
            "Private provider output"
        };
      }
  });

const registry =
  new ProviderRegistry([
    {
      providerId:
        "provider.local.demo",
      publicKey:
        providerKeys.publicKey
    }
  ]);

const broker =
  new FundingBroker([
    new BlindSponsorPool({
      id: "demo-pool",
      sponsorDisclosure:
        "ExampleCloud Sponsor",
      balanceCredits: 100
    })
  ]);

const execution =
  await executeSponsoredProviderTask({
    task: {
      id: "provider-demo",
      taskClass:
        "software-development",
      computeRequested: 20,
      privacy: "blind",
      allowSponsorship: true,
      prompt:
        "Implement a private demo task.",
      repositoryContext:
        "Private repository context"
    },
    broker,
    provider,
    providerRegistry:
      registry
  });

console.log(
  "Provider usage valid:",
  verifyProviderUsageReceipt(
    execution
      .providerUsageReceipt,
    registry,
    {
      grantId:
        execution.receipt
          .grantId,
      computeUnits:
        execution.receipt
          .computeUnitsAuthorized
    }
  )
);

console.log(
  "SponsorRail receipt provider evidence:",
  execution.receipt.provider
);

console.log(
  "Sponsor accounting:",
  {
    available:
      broker.pools[0]
        .availableCredits,
    reserved:
      broker.pools[0]
        .reservedCredits,
    spent:
      broker.pools[0]
        .spentCredits
  }
);
