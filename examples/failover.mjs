import {
  BlindSponsorPool,
  FundingBroker,
  ProviderRegistry,
  ProviderRouter,
  ProviderUnavailableError,
  SignedComputeProvider,
  createProviderKeyPair,
  executeRoutedSponsoredTask
} from "../src/index.js";

function makeProvider(
  providerId,
  executor
) {
  const keys =
    createProviderKeyPair();

  const provider =
    new SignedComputeProvider({
      providerId,
      privateKey:
        keys.privateKey,
      modelClass:
        `demo:${providerId}`,
      executor
    });

  return {
    provider,
    keys
  };
}

const primary =
  makeProvider(
    "provider.primary.demo",
    async () => {
      throw new ProviderUnavailableError(
        "primary temporarily unavailable",
        {
          code:
            "PRIMARY_UNAVAILABLE"
        }
      );
    }
  );

const backup =
  makeProvider(
    "provider.backup.demo",
    async () => ({
      completed: true,
      computeUnitsUsed: 8,
      output:
        "private backup output"
    })
  );

const registry =
  new ProviderRegistry([
    {
      providerId:
        primary.provider
          .providerId,
      publicKey:
        primary.keys.publicKey
    },
    {
      providerId:
        backup.provider
          .providerId,
      publicKey:
        backup.keys.publicKey
    }
  ]);

const router =
  new ProviderRouter([
    {
      providerId:
        primary.provider
          .providerId,
      provider:
        primary.provider,
      locality: "local",
      priority: 5,
      capabilities: [
        "chat",
        "code"
      ]
    },
    {
      providerId:
        backup.provider
          .providerId,
      provider:
        backup.provider,
      locality: "remote",
      capabilities: [
        "chat",
        "code"
      ]
    }
  ]);

const funding =
  new FundingBroker([
    new BlindSponsorPool({
      id: "failover-demo",
      sponsorDisclosure:
        "Example Compute Patron",
      balanceCredits: 100
    })
  ]);

const execution =
  await executeRoutedSponsoredTask({
    task: {
      id: "failover-demo-task",
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
    broker: funding,
    router,
    providerRegistry:
      registry,
    routingPreferences: {
      preferredLocality:
        "local",
      requiredCapabilities: [
        "chat",
        "code"
      ]
    },
    maxAttempts: 2
  });

console.log(
  "Selected provider:",
  execution.routing
    .decision
    .selectedProviderId
);

console.log(
  "Failover used:",
  execution.routing
    .decision
    .failoverUsed
);

console.log(
  "Attempts:",
  execution.routing
    .attempts
);

console.log(
  "Health:",
  router.healthSnapshot()
);

console.log(
  "Sponsor accounting:",
  {
    available:
      funding.pools[0]
        .availableCredits,
    reserved:
      funding.pools[0]
        .reservedCredits,
    spent:
      funding.pools[0]
        .spentCredits
  }
);
