import {
  ProviderUnavailableError,
  SignedComputeProvider
} from "../provider.js";

const DEFAULT_BASE_URL =
  "http://127.0.0.1:11434";

const LOOPBACK_HOSTS =
  new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    "[::1]"
  ]);

function normalizeBaseUrl(value) {
  const url = new URL(
    value ?? DEFAULT_BASE_URL
  );

  if (
    !["http:", "https:"]
      .includes(url.protocol)
  ) {
    throw new TypeError(
      "Ollama baseUrl must use http or https"
    );
  }

  if (!url.pathname.endsWith("/")) {
    url.pathname += "/";
  }

  return url;
}

function assertEndpointPolicy(
  url,
  {
    allowRemote,
    allowInsecureRemote
  }
) {
  const loopback =
    LOOPBACK_HOSTS.has(
      url.hostname
    );

  if (
    !loopback &&
    allowRemote !== true
  ) {
    throw new Error(
      "remote Ollama endpoint requires allowRemote=true"
    );
  }

  if (
    !loopback &&
    url.protocol !== "https:" &&
    allowInsecureRemote !== true
  ) {
    throw new Error(
      "remote Ollama endpoint requires https unless allowInsecureRemote=true"
    );
  }
}

function normalizeAllowedModels(
  model,
  allowedModels
) {
  const list =
    allowedModels ??
    [model];

  if (
    !Array.isArray(list) ||
    list.length === 0
  ) {
    throw new TypeError(
      "allowedModels must be a non-empty array"
    );
  }

  const normalized =
    [...new Set(
      list.map(String)
    )];

  if (
    !normalized.includes(
      String(model)
    )
  ) {
    throw new Error(
      "configured Ollama model is not in allowedModels"
    );
  }

  return Object.freeze(
    normalized
  );
}

function buildMessages(
  modelContext
) {
  const messages = [];

  const repositoryContext =
    String(
      modelContext
        .repositoryContext ??
      ""
    ).trim();

  const task =
    String(
      modelContext.prompt
    );

  if (repositoryContext) {
    messages.push({
      role: "user",
      content:
        [
          "Repository context:",
          repositoryContext,
          "",
          "Task:",
          task
        ].join("\n")
    });
  } else {
    messages.push({
      role: "user",
      content: task
    });
  }

  return messages;
}

function nonNegativeInteger(
  value,
  fallback = 0
) {
  const number =
    Number(value);

  if (
    !Number.isInteger(number) ||
    number < 0
  ) {
    return fallback;
  }

  return number;
}

function timeoutSignal(
  timeoutMs
) {
  const controller =
    new AbortController();

  const timer =
    setTimeout(
      () =>
        controller.abort(
          new Error(
            "Ollama request timed out"
          )
        ),
      timeoutMs
    );

  return {
    signal:
      controller.signal,
    cancel:
      () => clearTimeout(timer)
  };
}

export class OllamaChatProvider
  extends SignedComputeProvider {
  constructor({
    privateKey,
    model,
    providerId =
      "ollama.local",
    baseUrl =
      DEFAULT_BASE_URL,
    allowedModels = null,
    allowRemote = false,
    allowInsecureRemote =
      false,
    timeoutMs = 120_000,
    fetchImpl =
      globalThis.fetch,
    think = undefined,
    keepAlive = undefined,
    options = {},
    now =
      () => Date.now()
  }) {
    if (!model) {
      throw new TypeError(
        "model is required"
      );
    }

    if (
      typeof fetchImpl !==
      "function"
    ) {
      throw new TypeError(
        "fetchImpl is required"
      );
    }

    if (
      !Number.isInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new TypeError(
        "timeoutMs must be a positive integer"
      );
    }

    const normalizedUrl =
      normalizeBaseUrl(
        baseUrl
      );

    assertEndpointPolicy(
      normalizedUrl,
      {
        allowRemote,
        allowInsecureRemote
      }
    );

    const modelName =
      String(model);

    const modelAllowlist =
      normalizeAllowedModels(
        modelName,
        allowedModels
      );

    const requestUrl =
      new URL(
        "api/chat",
        normalizedUrl
      ).toString();

    const baseOptions = {
      ...options
    };

    const executor =
      async ({
        modelContext,
        authorization
      }) => {
        if (
          !modelAllowlist.includes(
            modelName
          )
        ) {
          throw new Error(
            "Ollama model is not allowed"
          );
        }

        const requestOptions = {
          ...baseOptions
        };

        const configuredNumPredict =
          requestOptions
            .num_predict;

        const maxOutputTokens =
          Math.min(
            authorization
              .computeUnits,
            Number.isInteger(
              configuredNumPredict
            ) &&
            configuredNumPredict >= 0
              ? configuredNumPredict
              : authorization
                  .computeUnits
          );

        requestOptions.num_predict =
          maxOutputTokens;

        const body = {
          model:
            modelName,
          messages:
            buildMessages(
              modelContext
            ),
          stream: false,
          options:
            requestOptions
        };

        if (
          think !== undefined
        ) {
          body.think = think;
        }

        if (
          keepAlive !==
          undefined
        ) {
          body.keep_alive =
            keepAlive;
        }

        const timeout =
          timeoutSignal(
            timeoutMs
          );

        let response;

        try {
          response =
            await fetchImpl(
              requestUrl,
              {
                method: "POST",
                headers: {
                  "content-type":
                    "application/json"
                },
                body:
                  JSON.stringify(
                    body
                  ),
                signal:
                  timeout.signal
              }
            );
        } catch (error) {
          if (
            timeout.signal
              .aborted
          ) {
            throw new Error(
              "Ollama request timed out"
            );
          }

          throw new Error(
            `Ollama request failed: ${error?.message ?? String(error)}`
          );
        } finally {
          timeout.cancel();
        }

        if (!response?.ok) {
          const status =
            Number(
              response?.status
            );

          if (
            [429, 502, 503, 504]
              .includes(status)
          ) {
            throw new ProviderUnavailableError(
              `Ollama request failed with HTTP ${status}`,
              {
                code:
                  `OLLAMA_HTTP_${status}`
              }
            );
          }

          throw new Error(
            `Ollama request failed with HTTP ${response?.status ?? "unknown"}`
          );
        }

        const data =
          await response.json();

        if (
          data?.done !== true
        ) {
          throw new Error(
            "Ollama response did not complete"
          );
        }

        const promptTokens =
          nonNegativeInteger(
            data
              .prompt_eval_count
          );

        const cachedPromptTokens =
          nonNegativeInteger(
            data
              .prompt_eval_cached_count
          );

        const outputTokens =
          nonNegativeInteger(
            data.eval_count
          );

        if (
          outputTokens >
          authorization
            .computeUnits
        ) {
          throw new Error(
            "Ollama output usage exceeded grant authority"
          );
        }

        return {
          completed: true,
          computeUnitsUsed:
            outputTokens,
          output: {
            role:
              data.message
                ?.role ??
              "assistant",
            content:
              String(
                data.message
                  ?.content ??
                ""
              )
          },
          metering: {
            billingMetric:
              "ollama-output-tokens",
            promptTokens,
            cachedPromptTokens,
            outputTokens,
            totalTokens:
              promptTokens +
              outputTokens,
            totalDurationNs:
              nonNegativeInteger(
                data.total_duration
              ),
            loadDurationNs:
              nonNegativeInteger(
                data.load_duration
              ),
            promptEvalDurationNs:
              nonNegativeInteger(
                data
                  .prompt_eval_duration
              ),
            evalDurationNs:
              nonNegativeInteger(
                data
                  .eval_duration
              )
          },
          providerResponse: {
            model:
              String(
                data.model ??
                modelName
              ),
            doneReason:
              data.done_reason ??
              null
          }
        };
      };

    super({
      providerId,
      privateKey,
      executor,
      usageMetric:
        "ollama-output-tokens",
      modelClass:
        `ollama:${modelName}`,
      now
    });

    this.model =
      modelName;

    this.baseUrl =
      normalizedUrl
        .toString();

    this.allowedModels =
      modelAllowlist;

    this.timeoutMs =
      timeoutMs;

    this.fetchImpl =
      fetchImpl;
  }

  async probe() {
    const timeout =
      timeoutSignal(
        this.timeoutMs
      );

    const tagsUrl =
      new URL(
        "api/tags",
        this.baseUrl
      ).toString();

    try {
      const response =
        await this.fetchImpl(
          tagsUrl,
          {
            method: "GET",
            signal:
              timeout.signal
          }
        );

      if (!response?.ok) {
        return Object.freeze({
          available: false,
          providerId:
            this.providerId,
          model:
            this.model,
          reason:
            `HTTP_${response?.status ?? "UNKNOWN"}`
        });
      }

      const data =
        await response.json();

      const models =
        Array.isArray(
          data?.models
        )
          ? data.models
              .map(
                (entry) =>
                  String(
                    entry?.model ??
                    entry?.name ??
                    ""
                  )
              )
              .filter(Boolean)
          : [];

      const installed =
        models.includes(
          this.model
        );

      return Object.freeze({
        available:
          installed,
        providerId:
          this.providerId,
        model:
          this.model,
        reason:
          installed
            ? "READY"
            : "MODEL_NOT_INSTALLED",
        discoveredModels:
          Object.freeze(
            [...models]
          )
      });
    } catch (error) {
      return Object.freeze({
        available: false,
        providerId:
          this.providerId,
        model:
          this.model,
        reason:
          timeout.signal
            .aborted
            ? "TIMEOUT"
            : "PROBE_FAILED",
        error:
          String(
            error?.message ??
            error
          )
      });
    } finally {
      timeout.cancel();
    }
  }
}
