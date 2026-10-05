import test from "node:test";
import assert from "node:assert/strict";

import {
  BlindSponsorPool,
  FundingBroker,
  OllamaChatProvider,
  ProviderHealthTracker,
  ProviderRegistry,
  ProviderRouter,
  ProviderUnavailableError,
  SignedComputeProvider,
  createProviderKeyPair,
  executeRoutedSponsoredTask,
  isSafeProviderRetry
} from "../src/index.js";

function makeTask(overrides = {}) {
  return {
    id: "failover-task",
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

function makeBroker() {
  return new FundingBroker([
    new BlindSponsorPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud Sponsor",
      balanceCredits: 100
    })
  ]);
}

function providerEntry(
  providerId,
  executor,
  {
    locality = "remote",
    priority = 0,
    costPerUnit = 0
  } = {}
) {
  const keys =
    createProviderKeyPair();

  const provider =
    new SignedComputeProvider({
      providerId,
      privateKey:
        keys.privateKey,
      modelClass:
        `test:${providerId}`,
      executor
    });

  return {
    provider,
    keys,
    registration: {
      providerId,
      provider,
      locality,
      priority,
      costPerUnit,
      capabilities: [
        "chat",
        "code"
      ]
    }
  };
}

function makeRegistry(entries) {
  return new ProviderRegistry(
    entries.map(
      (entry) => ({
        providerId:
          entry.provider
            .providerId,
        publicKey:
          entry.keys.publicKey
      })
    )
  );
}

test(
  "retry-safe provider failure falls back to next eligible provider",
  async () => {
    const first =
      providerEntry(
        "provider.primary",
        async () => {
          throw new ProviderUnavailableError(
            "PRIVATE_PROVIDER_DETAIL",
            {
              code:
                "PRIMARY_UNAVAILABLE"
            }
          );
        },
        {
          locality: "local",
          priority: 5
        }
      );

    const second =
      providerEntry(
        "provider.backup",
        async () => ({
          completed: true,
          computeUnitsUsed: 7,
          output:
            "PRIVATE_MODEL_OUTPUT"
        }),
        {
          locality: "remote"
        }
      );

    const health =
      new ProviderHealthTracker({
        failureThreshold: 2,
        cooldownMs: 1000
      });

    const router =
      new ProviderRouter(
        [
          first.registration,
          second.registration
        ],
        {
          healthTracker:
            health
        }
      );

    const funding =
      makeBroker();

    const execution =
      await executeRoutedSponsoredTask({
        task: makeTask(),
        broker: funding,
        router,
        providerRegistry:
          makeRegistry([
            first,
            second
          ]),
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

    assert.equal(
      execution.routing
        .decision
        .selectedProviderId,
      "provider.backup"
    );

    assert.equal(
      execution.routing
        .decision
        .attemptCount,
      2
    );

    assert.equal(
      execution.routing
        .decision
        .failoverUsed,
      true
    );

    assert.deepEqual(
      execution.routing
        .decision
        .failedProviderIds,
      ["provider.primary"]
    );

    assert.equal(
      execution.routing
        .attempts.length,
      2
    );

    assert.equal(
      execution.routing
        .attempts[0]
        .safeToRetry,
      true
    );

    assert.equal(
      funding.pools[0]
        .availableCredits,
      93
    );

    assert.equal(
      funding.pools[0]
        .reservedCredits,
      0
    );

    assert.equal(
      funding.pools[0]
        .spentCredits,
      7
    );

    const receiptText =
      JSON.stringify(
        execution.receipt
      );

    assert.equal(
      receiptText.includes(
        "PRIVATE_PROVIDER_DETAIL"
      ),
      false
    );

    assert.equal(
      receiptText.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      false
    );
  }
);

test(
  "ambiguous provider failure does not automatically fail over",
  async () => {
    let backupCalls = 0;

    const first =
      providerEntry(
        "provider.uncertain",
        async () => {
          throw new Error(
            "timeout after request may have executed"
          );
        },
        {
          locality: "local",
          priority: 5
        }
      );

    const second =
      providerEntry(
        "provider.backup",
        async () => {
          backupCalls += 1;

          return {
            completed: true,
            computeUnitsUsed: 3
          };
        }
      );

    const funding =
      makeBroker();

    const router =
      new ProviderRouter([
        first.registration,
        second.registration
      ]);

    await assert.rejects(
      () =>
        executeRoutedSponsoredTask({
          task: makeTask(),
          broker: funding,
          router,
          providerRegistry:
            makeRegistry([
              first,
              second
            ]),
          routingPreferences: {
            preferredLocality:
              "local"
          },
          maxAttempts: 2
        }),
      /timeout after request/
    );

    assert.equal(
      backupCalls,
      0
    );

    assert.equal(
      funding.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      funding.pools[0]
        .spentCredits,
      0
    );
  }
);

test(
  "circuit opens after threshold and prevents probe traffic",
  async () => {
    let now = 1000;
    let probeCalls = 0;

    const health =
      new ProviderHealthTracker({
        failureThreshold: 1,
        cooldownMs: 100,
        now: () => now
      });

    const candidate =
      providerEntry(
        "provider.flaky",
        async () => ({
          completed: true,
          computeUnitsUsed: 1
        })
      );

    const router =
      new ProviderRouter(
        [
          {
            ...candidate.registration,
            probe:
              async () => {
                probeCalls += 1;
                return {
                  available: true
                };
              }
          }
        ],
        {
          healthTracker:
            health
        }
      );

    health.recordFailure(
      "provider.flaky",
      {
        code:
          "PROVIDER_UNAVAILABLE"
      }
    );

    const discovery =
      await router.discover(
        makeTask()
      );

    assert.equal(
      discovery.candidates[0]
        .eligible,
      false
    );

    assert.equal(
      discovery.candidates[0]
        .circuitState,
      "OPEN"
    );

    assert.equal(
      discovery.candidates[0]
        .reasons
        .includes(
          "CIRCUIT_OPEN"
        ),
      true
    );

    assert.equal(
      probeCalls,
      0
    );

    now = 1200;

    const halfOpen =
      await router.discover(
        makeTask()
      );

    assert.equal(
      halfOpen.candidates[0]
        .circuitState,
      "HALF_OPEN"
    );

    assert.equal(
      halfOpen.candidates[0]
        .eligible,
      true
    );

    assert.equal(
      probeCalls,
      1
    );

    router.recordSuccess(
      "provider.flaky"
    );

    assert.equal(
      health.status(
        "provider.flaky"
      ).state,
      "CLOSED"
    );
  }
);

test(
  "retry-safe failure opens circuit and future task routes around provider",
  async () => {
    let primaryCalls = 0;

    const first =
      providerEntry(
        "provider.primary",
        async () => {
          primaryCalls += 1;

          throw new ProviderUnavailableError(
            "offline",
            {
              code:
                "PROVIDER_OFFLINE"
            }
          );
        },
        {
          locality: "local",
          priority: 5
        }
      );

    const second =
      providerEntry(
        "provider.backup",
        async () => ({
          completed: true,
          computeUnitsUsed: 2
        })
      );

    const health =
      new ProviderHealthTracker({
        failureThreshold: 1,
        cooldownMs: 60_000
      });

    const router =
      new ProviderRouter(
        [
          first.registration,
          second.registration
        ],
        {
          healthTracker:
            health
        }
      );

    const providerRegistry =
      makeRegistry([
        first,
        second
      ]);

    await executeRoutedSponsoredTask({
      task:
        makeTask({
          id: "first-task"
        }),
      broker:
        makeBroker(),
      router,
      providerRegistry,
      routingPreferences: {
        preferredLocality:
          "local"
      },
      maxAttempts: 2
    });

    assert.equal(
      primaryCalls,
      1
    );

    const secondRun =
      await executeRoutedSponsoredTask({
        task:
          makeTask({
            id: "second-task"
          }),
        broker:
          makeBroker(),
        router,
        providerRegistry,
        routingPreferences: {
          preferredLocality:
            "local"
        },
        maxAttempts: 2
      });

    assert.equal(
      primaryCalls,
      1
    );

    assert.equal(
      secondRun.routing
        .decision
        .selectedProviderId,
      "provider.backup"
    );

    assert.equal(
      secondRun.routing
        .decision
        .attemptCount,
      1
    );

    assert.equal(
      secondRun.routing
        .decision
        .failoverUsed,
      false
    );
  }
);

test(
  "maxAttempts one prevents fallback even for retry-safe failure",
  async () => {
    let backupCalls = 0;

    const first =
      providerEntry(
        "provider.primary",
        async () => {
          throw new ProviderUnavailableError(
            "offline"
          );
        },
        {
          priority: 5
        }
      );

    const second =
      providerEntry(
        "provider.backup",
        async () => {
          backupCalls += 1;

          return {
            completed: true,
            computeUnitsUsed: 1
          };
        }
      );

    await assert.rejects(
      () =>
        executeRoutedSponsoredTask({
          task: makeTask(),
          broker:
            makeBroker(),
          router:
            new ProviderRouter([
              first.registration,
              second.registration
            ]),
          providerRegistry:
            makeRegistry([
              first,
              second
            ]),
          maxAttempts: 1
        }),
      /offline/
    );

    assert.equal(
      backupCalls,
      0
    );
  }
);

test(
  "Ollama 503 is explicitly retry-safe but timeout remains ambiguous",
  async () => {
    const keys =
      createProviderKeyPair();

    const unavailable =
      new OllamaChatProvider({
        privateKey:
          keys.privateKey,
        model: "model",
        fetchImpl:
          async () => ({
            ok: false,
            status: 503
          })
      });

    await assert.rejects(
      async () => {
        try {
          await unavailable.execute({
            modelContext: {
              taskId: "task",
              prompt: "private",
              repositoryContext:
                ""
            },
            authorization: {
              grantId: "grant",
              computeUnits: 10
            }
          });
        } catch (error) {
          assert.equal(
            isSafeProviderRetry(
              error
            ),
            true
          );

          assert.equal(
            error.code,
            "OLLAMA_HTTP_503"
          );

          throw error;
        }
      },
      /HTTP 503/
    );

    const timeout =
      new Error(
        "Ollama request timed out"
      );

    assert.equal(
      isSafeProviderRetry(
        timeout
      ),
      false
    );
  }
);
