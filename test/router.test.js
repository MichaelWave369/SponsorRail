import test from "node:test";
import assert from "node:assert/strict";

import {
  BlindSponsorPool,
  FundingBroker,
  OllamaChatProvider,
  ProviderRegistry,
  ProviderRouter,
  SignedComputeProvider,
  createProviderKeyPair,
  executeRoutedSponsoredTask,
  verifyReceiptHash
} from "../src/index.js";

function task(overrides = {}) {
  return {
    id: "route-task",
    taskClass:
      "software-development",
    computeRequested: 20,
    privacy: "blind",
    allowSponsorship: true,
    prompt:
      "ULTRA_SECRET_PROMPT",
    repositoryContext:
      "TOP_SECRET_SOURCE",
    ...overrides
  };
}

function broker() {
  return new FundingBroker([
    new BlindSponsorPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud Sponsor",
      balanceCredits: 100
    })
  ]);
}

function signedProvider(
  providerId,
  {
    computeUnitsUsed = 5,
    keys =
      createProviderKeyPair(),
    executor = null
  } = {}
) {
  const provider =
    new SignedComputeProvider({
      providerId,
      privateKey:
        keys.privateKey,
      modelClass:
        `test:${providerId}`,
      executor:
        executor ??
        (async () => ({
          completed: true,
          computeUnitsUsed,
          output:
            "PRIVATE_MODEL_OUTPUT"
        }))
    });

  return {
    provider,
    keys
  };
}

function registry(entries) {
  return new ProviderRegistry(
    entries.map(
      ({ provider, keys }) => ({
        providerId:
          provider.providerId,
        publicKey:
          keys.publicKey
      })
    )
  );
}

test(
  "routing request omits prompt repository source and sponsor identity",
  async () => {
    const local =
      signedProvider(
        "provider.local"
      );

    const router =
      new ProviderRouter([
        {
          providerId:
            "provider.local",
          provider:
            local.provider,
          locality: "local",
          capabilities: [
            "chat",
            "code"
          ],
          costPerUnit: 0
        }
      ]);

    const discovery =
      await router.discover(
        task(),
        {
          requiredCapabilities: [
            "chat"
          ],
          preferredLocality:
            "local"
        }
      );

    const serialized =
      JSON.stringify(
        discovery
      );

    assert.equal(
      serialized.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "TOP_SECRET_SOURCE"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "ExampleCloud Sponsor"
      ),
      false
    );

    assert.deepEqual(
      discovery.request,
      {
        taskId:
          "route-task",
        taskClass:
          "software-development",
        privacy:
          "blind",
        computeRequested:
          20,
        requiredCapabilities:
          ["chat"],
        preferredLocality:
          "local",
        maxCostPerUnit:
          null
      }
    );
  }
);

test(
  "router prefers eligible local provider when local is preferred",
  async () => {
    const local =
      signedProvider(
        "provider.local"
      );

    const remote =
      signedProvider(
        "provider.remote"
      );

    const router =
      new ProviderRouter([
        {
          providerId:
            "provider.remote",
          provider:
            remote.provider,
          locality: "remote",
          capabilities: [
            "chat",
            "code"
          ],
          costPerUnit: 0
        },
        {
          providerId:
            "provider.local",
          provider:
            local.provider,
          locality: "local",
          capabilities: [
            "chat",
            "code"
          ],
          costPerUnit: 1
        }
      ]);

    const route =
      await router.route(
        task(),
        {
          preferredLocality:
            "local",
          requiredCapabilities: [
            "chat",
            "code"
          ]
        }
      );

    assert.equal(
      route.selected,
      true
    );

    assert.equal(
      route.decision
        .selectedProviderId,
      "provider.local"
    );

    assert.equal(
      route.decision
        .locality,
      "local"
    );
  }
);

test(
  "router falls back when preferred provider probe reports unavailable",
  async () => {
    const local =
      signedProvider(
        "provider.local"
      );

    const remote =
      signedProvider(
        "provider.remote"
      );

    const router =
      new ProviderRouter([
        {
          providerId:
            "provider.local",
          provider:
            local.provider,
          locality: "local",
          probe:
            async () => ({
              available: false,
              reason:
                "MODEL_NOT_INSTALLED"
            })
        },
        {
          providerId:
            "provider.remote",
          provider:
            remote.provider,
          locality: "remote",
          probe:
            async () => ({
              available: true
            })
        }
      ]);

    const route =
      await router.route(
        task(),
        {
          preferredLocality:
            "local"
        }
      );

    assert.equal(
      route.selected,
      true
    );

    assert.equal(
      route.decision
        .selectedProviderId,
      "provider.remote"
    );

    const localCandidate =
      route.candidates.find(
        (candidate) =>
          candidate.providerId ===
          "provider.local"
      );

    assert.equal(
      localCandidate.available,
      false
    );

    assert.equal(
      localCandidate.reasons
        .includes(
          "UNAVAILABLE"
        ),
      true
    );
  }
);

test(
  "router rejects privacy capability compute and cost mismatches",
  async () => {
    const candidate =
      signedProvider(
        "provider.strict"
      );

    const router =
      new ProviderRouter([
        {
          providerId:
            "provider.strict",
          provider:
            candidate.provider,
          locality:
            "remote",
          capabilities: [
            "chat"
          ],
          privacyModes: [
            "contextual"
          ],
          maxComputeUnits:
            10,
          costPerUnit:
            2
        }
      ]);

    const route =
      await router.route(
        task(),
        {
          requiredCapabilities: [
            "chat",
            "code"
          ],
          maxCostPerUnit:
            1
        }
      );

    assert.equal(
      route.selected,
      false
    );

    assert.equal(
      route.reason,
      "NO_ELIGIBLE_PROVIDER"
    );

    const reasons =
      route.candidates[0]
        .reasons;

    assert.equal(
      reasons.includes(
        "PRIVACY_MISMATCH"
      ),
      true
    );

    assert.equal(
      reasons.includes(
        "CAPABILITY_MISMATCH"
      ),
      true
    );

    assert.equal(
      reasons.includes(
        "COMPUTE_LIMIT"
      ),
      true
    );

    assert.equal(
      reasons.includes(
        "COST_LIMIT"
      ),
      true
    );
  }
);

test(
  "routed sponsored execution records coarse decision evidence",
  async () => {
    const selected =
      signedProvider(
        "provider.local",
        {
          computeUnitsUsed:
            7
        }
      );

    const providerRegistry =
      registry([
        selected
      ]);

    const router =
      new ProviderRouter([
        {
          providerId:
            "provider.local",
          provider:
            selected.provider,
          locality: "local",
          capabilities: [
            "chat",
            "code"
          ],
          costPerUnit:
            0.25,
          priority: 3,
          probe:
            async () => ({
              available: true,
              hidden:
                "DO_NOT_COPY_TO_RECEIPT"
            })
        }
      ]);

    const execution =
      await executeRoutedSponsoredTask({
        task: task(),
        broker: broker(),
        router,
        providerRegistry,
        routingPreferences: {
          preferredLocality:
            "local",
          requiredCapabilities: [
            "chat",
            "code"
          ],
          maxCostPerUnit:
            1
        }
      });

    assert.equal(
      execution.funded,
      true
    );

    assert.equal(
      execution.receipt
        .routing
        .selectedProviderId,
      "provider.local"
    );

    assert.equal(
      execution.receipt
        .routing
        .candidateCount,
      1
    );

    assert.equal(
      execution.receipt
        .routing
        .eligibleCount,
      1
    );

    assert.equal(
      execution.receipt
        .computeUnitsUsed,
      7
    );

    const receiptText =
      JSON.stringify(
        execution.receipt
      );

    assert.equal(
      receiptText.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      false
    );

    assert.equal(
      receiptText.includes(
        "TOP_SECRET_SOURCE"
      ),
      false
    );

    assert.equal(
      receiptText.includes(
        "DO_NOT_COPY_TO_RECEIPT"
      ),
      false
    );

    assert.equal(
      verifyReceiptHash(
        execution.receipt
      ),
      true
    );
  }
);

test(
  "no eligible provider returns before sponsor credits are reserved",
  async () => {
    const unavailable =
      signedProvider(
        "provider.offline"
      );

    const poolBroker =
      broker();

    const router =
      new ProviderRouter([
        {
          providerId:
            "provider.offline",
          provider:
            unavailable.provider,
          probe:
            async () => ({
              available: false
            })
        }
      ]);

    const result =
      await executeRoutedSponsoredTask({
        task: task(),
        broker:
          poolBroker,
        router,
        providerRegistry:
          registry([
            unavailable
          ])
      });

    assert.equal(
      result.funded,
      false
    );

    assert.equal(
      result.status,
      "NO_ELIGIBLE_PROVIDER"
    );

    assert.equal(
      poolBroker.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      poolBroker.pools[0]
        .reservedCredits,
      0
    );
  }
);

test(
  "router rejects provider identity mismatch",
  () => {
    const actual =
      signedProvider(
        "provider.actual"
      );

    assert.throws(
      () =>
        new ProviderRouter([
          {
            providerId:
              "provider.fake",
            provider:
              actual.provider
          }
        ]),
      /does not match/
    );
  }
);

test(
  "Ollama probe uses tags endpoint and verifies configured model is installed",
  async () => {
    const keys =
      createProviderKeyPair();

    let url;

    const provider =
      new OllamaChatProvider({
        providerId:
          "ollama.local.test",
        privateKey:
          keys.privateKey,
        model:
          "qwen3.6:latest",
        fetchImpl:
          async (
            requestUrl
          ) => {
            url =
              requestUrl;

            return {
              ok: true,
              status: 200,
              async json() {
                return {
                  models: [
                    {
                      name:
                        "qwen3.6:latest",
                      model:
                        "qwen3.6:latest"
                    },
                    {
                      name:
                        "gemma3:12b",
                      model:
                        "gemma3:12b"
                    }
                  ]
                };
              }
            };
          }
      });

    const result =
      await provider.probe();

    assert.equal(
      url,
      "http://127.0.0.1:11434/api/tags"
    );

    assert.equal(
      result.available,
      true
    );

    assert.equal(
      result.reason,
      "READY"
    );

    assert.equal(
      result
        .discoveredModels
        .includes(
          "gemma3:12b"
        ),
      true
    );
  }
);

test(
  "Ollama probe reports configured model missing without executing a task",
  async () => {
    const keys =
      createProviderKeyPair();

    const provider =
      new OllamaChatProvider({
        privateKey:
          keys.privateKey,
        model:
          "missing-model",
        fetchImpl:
          async () => ({
            ok: true,
            status: 200,
            async json() {
              return {
                models: [
                  {
                    model:
                      "other-model"
                  }
                ]
              };
            }
          })
      });

    const result =
      await provider.probe();

    assert.equal(
      result.available,
      false
    );

    assert.equal(
      result.reason,
      "MODEL_NOT_INSTALLED"
    );
  }
);
