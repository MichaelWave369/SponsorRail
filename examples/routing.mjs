import {
  BlindSponsorPool,
  FundingBroker,
  ProviderRegistry,
  ProviderRouter,
  SignedComputeProvider,
  createProviderKeyPair,
  executeRoutedSponsoredTask
} from "../src/index.js";

function makeProvider(
  providerId,
  computeUnitsUsed
) {
  const keys =
    createProviderKeyPair();

  return {
    keys,
    provider:
      new SignedComputeProvider({
        providerId,
        privateKey:
          keys.privateKey,
        modelClass:
          `demo:${providerId}`,
        executor:
          async () => ({
            completed: true,
            computeUnitsUsed,
            output:
              `private output from ${providerId}`
          })
      })
  };
}

const local =
  makeProvider(
    "provider.local.demo",
    8
  );

const remote =
  makeProvider(
    "provider.remote.demo",
    7
  );

const registry =
  new ProviderRegistry([
    {
      providerId:
        local.provider
          .providerId,
      publicKey:
        local.keys.publicKey
    },
    {
      providerId:
        remote.provider
          .providerId,
      publicKey:
        remote.keys.publicKey
    }
  ]);

const router =
  new ProviderRouter([
    {
      providerId:
        local.provider
          .providerId,
      provider:
        local.provider,
      locality: "local",
      capabilities: [
        "chat",
        "code"
      ],
      costPerUnit: 0,
      priority: 2,
      probe:
        async () => ({
          available: true
        })
    },
    {
      providerId:
        remote.provider
          .providerId,
      provider:
        remote.provider,
      locality: "remote",
      capabilities: [
        "chat",
        "code"
      ],
      costPerUnit: 0.001,
      priority: 2,
      probe:
        async () => ({
          available: true
        })
    }
  ]);

const fundingBroker =
  new FundingBroker([
    new BlindSponsorPool({
      id: "routing-demo",
      sponsorDisclosure:
        "Example Compute Patron",
      balanceCredits: 100
    })
  ]);

const execution =
  await executeRoutedSponsoredTask({
    task: {
      id: "routing-demo-task",
      taskClass:
        "software-development",
      computeRequested: 20,
      privacy: "blind",
      allowSponsorship: true,
      prompt:
        "Implement the private task.",
      repositoryContext:
        "Private source context."
    },
    broker:
      fundingBroker,
    router,
    providerRegistry:
      registry,
    routingPreferences: {
      requiredCapabilities: [
        "chat",
        "code"
      ],
      preferredLocality:
        "local",
      maxCostPerUnit:
        1
    }
  });

console.log(
  "Selected provider:",
  execution.routing
    .decision
    .selectedProviderId
);

console.log(
  "Routing evidence:",
  execution.receipt.routing
);

console.log(
  "Sponsor accounting:",
  {
    available:
      fundingBroker
        .pools[0]
        .availableCredits,
    reserved:
      fundingBroker
        .pools[0]
        .reservedCredits,
    spent:
      fundingBroker
        .pools[0]
        .spentCredits
  }
);
