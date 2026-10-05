import test from "node:test";
import assert from "node:assert/strict";

import {
  BlindSponsorPool,
  FundingBroker,
  OllamaChatProvider,
  ProviderRegistry,
  createProviderKeyPair,
  executeSponsoredProviderTask,
  verifyProviderUsageReceipt,
  verifyReceiptHash
} from "../src/index.js";

function makeBroker() {
  return new FundingBroker([
    new BlindSponsorPool({
      id: "ollama-pool",
      sponsorDisclosure:
        "ExampleCloud Sponsor",
      balanceCredits: 100
    })
  ]);
}

function makeTask(overrides = {}) {
  return {
    id: "ollama-task",
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

function responseJson(body) {
  return {
    ok: true,
    status: 200,
    async json() {
      return body;
    }
  };
}

function registryFor(
  providerId,
  publicKey
) {
  return new ProviderRegistry([
    {
      providerId,
      publicKey,
      usageMetric:
        "ollama-output-tokens"
    }
  ]);
}

test(
  "Ollama adapter calls loopback chat API and settles generated tokens",
  async () => {
    const keys =
      createProviderKeyPair();

    let captured;

    const fetchImpl =
      async (url, options) => {
        captured = {
          url,
          options,
          body:
            JSON.parse(
              options.body
            )
        };

        return responseJson({
          model:
            "qwen3.6:latest",
          created_at:
            "2026-10-04T23:00:00Z",
          message: {
            role: "assistant",
            content:
              "PRIVATE_MODEL_OUTPUT"
          },
          done: true,
          done_reason: "stop",
          total_duration:
            1000000,
          load_duration:
            100000,
          prompt_eval_count: 30,
          prompt_eval_cached_count:
            4,
          prompt_eval_duration:
            200000,
          eval_count: 12,
          eval_duration:
            700000
        });
      };

    const provider =
      new OllamaChatProvider({
        providerId:
          "ollama.local.test",
        privateKey:
          keys.privateKey,
        model:
          "qwen3.6:latest",
        fetchImpl
      });

    const registry =
      registryFor(
        "ollama.local.test",
        keys.publicKey
      );

    const broker =
      makeBroker();

    const execution =
      await executeSponsoredProviderTask({
        task: makeTask(),
        broker,
        provider,
        providerRegistry:
          registry
      });

    assert.equal(
      captured.url,
      "http://127.0.0.1:11434/api/chat"
    );

    assert.equal(
      captured.body.model,
      "qwen3.6:latest"
    );

    assert.equal(
      captured.body.stream,
      false
    );

    assert.equal(
      captured.body.options
        .num_predict,
      20
    );

    const requestText =
      JSON.stringify(
        captured.body
      );

    assert.equal(
      requestText.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      true
    );

    assert.equal(
      requestText.includes(
        "TOP_SECRET_SOURCE"
      ),
      true
    );

    assert.equal(
      requestText.includes(
        "ExampleCloud Sponsor"
      ),
      false
    );

    assert.equal(
      execution
        .providerUsageReceipt
        .computeUnitsUsed,
      12
    );

    assert.equal(
      execution
        .providerUsageReceipt
        .usageMetric,
      "ollama-output-tokens"
    );

    assert.equal(
      verifyProviderUsageReceipt(
        execution
          .providerUsageReceipt,
        registry,
        {
          grantId:
            execution.receipt
              .grantId,
          computeUnits: 20
        }
      ),
      true
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      88
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      12
    );

    assert.deepEqual(
      execution.result
        .metering,
      {
        billingMetric:
          "ollama-output-tokens",
        promptTokens: 30,
        cachedPromptTokens: 4,
        outputTokens: 12,
        totalTokens: 42,
        totalDurationNs:
          1000000,
        loadDurationNs:
          100000,
        promptEvalDurationNs:
          200000,
        evalDurationNs:
          700000
      }
    );

    const receipts =
      JSON.stringify({
        sponsor:
          execution.receipt,
        provider:
          execution
            .providerUsageReceipt
      });

    assert.equal(
      receipts.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      false
    );

    assert.equal(
      receipts.includes(
        "TOP_SECRET_SOURCE"
      ),
      false
    );

    assert.equal(
      receipts.includes(
        "PRIVATE_MODEL_OUTPUT"
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
  "Ollama adapter clamps num_predict to configured limit",
  async () => {
    const keys =
      createProviderKeyPair();

    let requested;

    const provider =
      new OllamaChatProvider({
        providerId:
          "ollama.limit",
        privateKey:
          keys.privateKey,
        model: "gemma3:12b",
        options: {
          temperature: 0,
          num_predict: 5
        },
        fetchImpl:
          async (_url, options) => {
            requested =
              JSON.parse(
                options.body
              );

            return responseJson({
              model:
                "gemma3:12b",
              message: {
                role:
                  "assistant",
                content: "ok"
              },
              done: true,
              eval_count: 5,
              prompt_eval_count:
                10
            });
          }
      });

    const registry =
      registryFor(
        "ollama.limit",
        keys.publicKey
      );

    await executeSponsoredProviderTask({
      task: makeTask(),
      broker:
        makeBroker(),
      provider,
      providerRegistry:
        registry
    });

    assert.equal(
      requested.options
        .num_predict,
      5
    );

    assert.equal(
      requested.options
        .temperature,
      0
    );
  }
);

test(
  "Ollama adapter rejects model outside allowlist",
  () => {
    const keys =
      createProviderKeyPair();

    assert.throws(
      () =>
        new OllamaChatProvider({
          privateKey:
            keys.privateKey,
          model:
            "qwen3.6:latest",
          allowedModels: [
            "gemma3:12b"
          ]
        }),
      /not in allowedModels/
    );
  }
);

test(
  "Ollama adapter is loopback-only unless remote use is explicit",
  () => {
    const keys =
      createProviderKeyPair();

    assert.throws(
      () =>
        new OllamaChatProvider({
          privateKey:
            keys.privateKey,
          model: "model",
          baseUrl:
            "https://ollama.example.com"
        }),
      /allowRemote=true/
    );

    assert.doesNotThrow(
      () =>
        new OllamaChatProvider({
          privateKey:
            keys.privateKey,
          model: "model",
          baseUrl:
            "https://ollama.example.com",
          allowRemote: true,
          fetchImpl:
            async () =>
              responseJson({
                model: "model",
                message: {
                  role:
                    "assistant",
                  content: ""
                },
                done: true,
                eval_count: 0
              })
        })
    );

    assert.throws(
      () =>
        new OllamaChatProvider({
          privateKey:
            keys.privateKey,
          model: "model",
          baseUrl:
            "http://ollama.example.com",
          allowRemote: true
        }),
      /requires https/
    );
  }
);

test(
  "Ollama HTTP failure releases sponsor reservation",
  async () => {
    const keys =
      createProviderKeyPair();

    const broker =
      makeBroker();

    const provider =
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

    const registry =
      registryFor(
        "ollama.local",
        keys.publicKey
      );

    await assert.rejects(
      () =>
        executeSponsoredProviderTask({
          task: makeTask(),
          broker,
          provider,
          providerRegistry:
            registry
        }),
      /HTTP 503/
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      broker.pools[0]
        .reservedCredits,
      0
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      0
    );
  }
);

test(
  "Ollama timeout aborts request and releases sponsor reservation",
  async () => {
    const keys =
      createProviderKeyPair();

    const broker =
      makeBroker();

    const provider =
      new OllamaChatProvider({
        privateKey:
          keys.privateKey,
        model: "model",
        timeoutMs: 10,
        fetchImpl:
          async (
            _url,
            { signal }
          ) =>
            new Promise(
              (_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () =>
                    reject(
                      signal.reason ??
                      new Error(
                        "aborted"
                      )
                    ),
                  { once: true }
                );
              }
            )
      });

    const registry =
      registryFor(
        "ollama.local",
        keys.publicKey
      );

    await assert.rejects(
      () =>
        executeSponsoredProviderTask({
          task: makeTask(),
          broker,
          provider,
          providerRegistry:
            registry
        }),
      /timed out/
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      0
    );
  }
);

test(
  "Ollama adapter forwards think and keep_alive without sponsor metadata",
  async () => {
    const keys =
      createProviderKeyPair();

    let body;

    const provider =
      new OllamaChatProvider({
        providerId:
          "ollama.options",
        privateKey:
          keys.privateKey,
        model: "model",
        think: false,
        keepAlive: "2m",
        fetchImpl:
          async (_url, options) => {
            body =
              JSON.parse(
                options.body
              );

            return responseJson({
              model: "model",
              message: {
                role:
                  "assistant",
                content: "ok"
              },
              done: true,
              eval_count: 1,
              prompt_eval_count:
                3
            });
          }
      });

    const registry =
      registryFor(
        "ollama.options",
        keys.publicKey
      );

    await executeSponsoredProviderTask({
      task: makeTask({
        computeRequested: 4
      }),
      broker:
        makeBroker(),
      provider,
      providerRegistry:
        registry
    });

    assert.equal(
      body.think,
      false
    );

    assert.equal(
      body.keep_alive,
      "2m"
    );

    assert.equal(
      JSON.stringify(body)
        .includes(
          "ExampleCloud Sponsor"
        ),
      false
    );
  }
);
