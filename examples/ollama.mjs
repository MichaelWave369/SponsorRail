import {
  BlindSponsorPool,
  FundingBroker,
  OllamaChatProvider,
  ProviderRegistry,
  createProviderKeyPair,
  executeSponsoredProviderTask
} from "../src/index.js";

const model =
  process.env.OLLAMA_MODEL;

if (!model) {
  console.error(
    "Set OLLAMA_MODEL to an installed local Ollama model."
  );
  process.exitCode = 2;
} else {
  const outputBudget =
    Number(
      process.env
        .SPONSORRAIL_OUTPUT_BUDGET ??
      256
    );

  if (
    !Number.isInteger(outputBudget) ||
    outputBudget <= 0
  ) {
    throw new Error(
      "SPONSORRAIL_OUTPUT_BUDGET must be a positive integer"
    );
  }

  const keys =
    createProviderKeyPair();

  const providerId =
    "ollama.local.demo";

  const provider =
    new OllamaChatProvider({
      providerId,
      privateKey:
        keys.privateKey,
      model,
      baseUrl:
        process.env
          .OLLAMA_BASE_URL ??
        "http://127.0.0.1:11434"
    });

  const registry =
    new ProviderRegistry([
      {
        providerId,
        publicKey:
          keys.publicKey,
        usageMetric:
          "ollama-output-tokens"
      }
    ]);

  const broker =
    new FundingBroker([
      new BlindSponsorPool({
        id: "local-demo",
        sponsorDisclosure:
          "Local Demo Sponsor",
        balanceCredits:
          outputBudget
      })
    ]);

  const execution =
    await executeSponsoredProviderTask({
      task: {
        id: "ollama-demo",
        taskClass:
          "software-development",
        computeRequested:
          outputBudget,
        privacy: "blind",
        allowSponsorship: true,
        prompt:
          process.env
            .SPONSORRAIL_PROMPT ??
          "Write a tiny JavaScript health-check function.",
        repositoryContext: ""
      },
      broker,
      provider,
      providerRegistry:
        registry
    });

  console.log(
    "Model output:\n",
    execution.result
      .output.content
  );

  console.log(
    "\nOllama metering:",
    execution.result.metering
  );

  console.log(
    "\nSponsorRail provider evidence:",
    execution.receipt
      .provider
  );

  console.log(
    "\nSponsor accounting:",
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
}
