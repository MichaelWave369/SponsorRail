import {
  createHash,
  randomUUID
} from "node:crypto";

import {
  buildExecutionAuthorization,
  buildModelContext,
  createReceiptKeyPair,
  signReceipt,
  verifyReceipt
} from "./sponsorrail.js";

export class ProviderUnavailableError extends Error {
  constructor(
    message,
    {
      code =
        "PROVIDER_UNAVAILABLE"
    } = {}
  ) {
    super(message);

    this.name =
      "ProviderUnavailableError";

    this.code =
      String(code);

    this.safeToRetry =
      true;
  }
}

export function isSafeProviderRetry(
  error
) {
  return (
    error?.safeToRetry === true
  );
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (
    value &&
    typeof value === "object"
  ) {
    return Object.keys(value)
      .sort()
      .reduce(
        (result, key) => {
          result[key] =
            canonicalize(value[key]);

          return result;
        },
        {}
      );
  }

  return value;
}

function canonicalJson(value) {
  return JSON.stringify(
    canonicalize(value)
  );
}

function sha256Json(value) {
  return createHash("sha256")
    .update(
      canonicalJson(value)
    )
    .digest("hex");
}

function assertUsage(value, name) {
  if (
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `${name} must be a non-negative integer`
    );
  }
}

function isoNow(now) {
  const value = Number(now());

  if (!Number.isFinite(value)) {
    throw new TypeError(
      "provider clock must return milliseconds"
    );
  }

  return new Date(value)
    .toISOString();
}

export function createProviderKeyPair() {
  return createReceiptKeyPair();
}

export class ProviderRegistry {
  #providers;

  constructor(entries = []) {
    this.#providers = new Map();

    for (const entry of entries) {
      this.register(entry);
    }
  }

  register({
    providerId,
    publicKey,
    usageMetric =
      "compute-units",
    enabled = true,
    replace = false
  }) {
    if (
      !providerId ||
      !publicKey
    ) {
      throw new TypeError(
        "providerId and publicKey are required"
      );
    }

    const id =
      String(providerId);

    if (
      this.#providers.has(id) &&
      !replace
    ) {
      throw new Error(
        "provider already registered"
      );
    }

    const record =
      Object.freeze({
        providerId: id,
        publicKey:
          String(publicKey),
        usageMetric:
          String(usageMetric),
        enabled:
          enabled === true
      });

    this.#providers.set(
      id,
      record
    );

    return record;
  }

  get(providerId) {
    return (
      this.#providers.get(
        String(providerId)
      ) ?? null
    );
  }

  verify(
    receipt,
    {
      authorization = null
    } = {}
  ) {
    if (
      receipt?.schema !==
      "sponsorrail.provider-usage.v0.6"
    ) {
      return false;
    }

    const record =
      this.get(
        receipt.providerId
      );

    if (
      !record ||
      !record.enabled
    ) {
      return false;
    }

    if (
      receipt.usageMetric !==
      record.usageMetric
    ) {
      return false;
    }

    if (
      !verifyReceipt(
        receipt,
        record.publicKey
      )
    ) {
      return false;
    }

    if (
      !Number.isInteger(
        receipt.computeUnitsAuthorized
      ) ||
      receipt.computeUnitsAuthorized <= 0 ||
      !Number.isInteger(
        receipt.computeUnitsUsed
      ) ||
      receipt.computeUnitsUsed < 0 ||
      receipt.computeUnitsUsed >
        receipt.computeUnitsAuthorized
    ) {
      return false;
    }

    if (authorization) {
      if (
        String(
          receipt.grantId
        ) !==
          String(
            authorization.grantId
          ) ||
        receipt.computeUnitsAuthorized !==
          authorization.computeUnits
      ) {
        return false;
      }
    }

    return true;
  }
}

export function verifyProviderUsageReceipt(
  receipt,
  registry,
  authorization = null
) {
  if (
    !registry ||
    typeof registry.verify !==
      "function"
  ) {
    throw new TypeError(
      "provider registry is required"
    );
  }

  return registry.verify(
    receipt,
    { authorization }
  );
}

export class SignedComputeProvider {
  constructor({
    providerId,
    privateKey,
    executor,
    usageMetric =
      "compute-units",
    modelClass =
      "unspecified",
    now =
      () => Date.now()
  }) {
    if (
      !providerId ||
      !privateKey
    ) {
      throw new TypeError(
        "providerId and privateKey are required"
      );
    }

    if (
      typeof executor !==
      "function"
    ) {
      throw new TypeError(
        "executor is required"
      );
    }

    if (
      typeof now !==
      "function"
    ) {
      throw new TypeError(
        "now must be a function"
      );
    }

    this.providerId =
      String(providerId);

    this.privateKey =
      privateKey;

    this.executor =
      executor;

    this.usageMetric =
      String(usageMetric);

    this.modelClass =
      String(modelClass);

    this.now = now;
  }

  async execute({
    modelContext,
    authorization
  }) {
    if (
      !modelContext ||
      !authorization
    ) {
      throw new TypeError(
        "modelContext and authorization are required"
      );
    }

    const startedAt =
      isoNow(this.now);

    const result =
      await this.executor(
        Object.freeze({
          modelContext,
          authorization
        })
      );

    const computeUnitsUsed =
      Number(
        result?.computeUnitsUsed ??
        0
      );

    assertUsage(
      computeUnitsUsed,
      "computeUnitsUsed"
    );

    if (
      computeUnitsUsed >
      authorization.computeUnits
    ) {
      throw new Error(
        "provider reported usage above authorization"
      );
    }

    const usagePayload = {
      schema:
        "sponsorrail.provider-usage.v0.6",
      usageId:
        randomUUID(),
      providerId:
        this.providerId,
      grantId:
        String(
          authorization.grantId
        ),
      usageMetric:
        this.usageMetric,
      modelClass:
        this.modelClass,
      computeUnitsAuthorized:
        authorization.computeUnits,
      computeUnitsUsed,
      completed:
        result?.completed ===
        true,
      startedAt,
      completedAt:
        isoNow(this.now)
    };

    const usageReceipt =
      signReceipt(
        usagePayload,
        this.privateKey
      );

    return Object.freeze({
      result,
      usageReceipt
    });
  }
}

export async function executeSponsoredProviderTask({
  task,
  broker,
  provider,
  providerRegistry,
  receiptPrivateKey = null,
  routingDecision = null
}) {
  if (
    !broker ||
    typeof broker.authorize !==
      "function"
  ) {
    throw new TypeError(
      "broker is required"
    );
  }

  if (
    !provider ||
    typeof provider.execute !==
      "function"
  ) {
    throw new TypeError(
      "provider is required"
    );
  }

  if (
    !providerRegistry ||
    typeof providerRegistry.verify !==
      "function"
  ) {
    throw new TypeError(
      "providerRegistry is required"
    );
  }

  const grant =
    broker.authorize(task);

  if (!grant.funded) {
    return Object.freeze({
      status: grant.reason,
      funded: false
    });
  }

  const modelContext =
    buildModelContext(task);

  const authorization =
    buildExecutionAuthorization(
      grant
    );

  let providerRun;
  let settlement;

  try {
    providerRun =
      await provider.execute(
        Object.freeze({
          modelContext,
          authorization
        })
      );

    const verified =
      verifyProviderUsageReceipt(
        providerRun
          .usageReceipt,
        providerRegistry,
        authorization
      );

    if (!verified) {
      throw new Error(
        "provider usage receipt verification failed"
      );
    }

    settlement =
      broker.settle(
        grant,
        providerRun
          .usageReceipt
          .computeUnitsUsed,
        {
          idempotencyKey:
            `provider:${providerRun.usageReceipt.usageId}`
        }
      );
  } catch (error) {
    broker.release(grant);
    throw error;
  }

  const providerUsageReceiptSha256 =
    sha256Json(
      providerRun
        .usageReceipt
    );

  const receiptPayload = {
    schema:
      "sponsorrail.receipt.v0.9",
    runId:
      randomUUID(),
    taskId:
      String(task.id),
    taskClass:
      String(
        task.taskClass ??
          "software-development"
      ),
    grantId:
      grant.grantId,
    grantIssuedAt:
      grant.issuedAt,
    grantExpiresAt:
      grant.expiresAt,
    computeUnitsAuthorized:
      authorization.computeUnits,
    computeUnitsUsed:
      providerRun
        .usageReceipt
        .computeUnitsUsed,
    computeUnitsRefunded:
      settlement.refundUnits,
    userCostCredits: 0,
    sponsorContributionCredits:
      providerRun
        .usageReceipt
        .computeUnitsUsed,
    sponsorDisclosure:
      grant
        .sponsorDisclosure,
    privacy: {
      promptDisclosedToSponsor:
        false,
      repositoryDisclosedToSponsor:
        false,
      outputDisclosedToSponsor:
        false,
      userIdentityDisclosedToSponsor:
        false
    },
    inference: {
      sponsorIdentityInModelContext:
        false,
      sponsorInstructionsInModelContext:
        false
    },
    routing:
      routingDecision
        ? {
            schema:
              String(
                routingDecision.schema
              ),
            selectedProviderId:
              String(
                routingDecision.selectedProviderId
              ),
            score:
              Number(
                routingDecision.score
              ),
            locality:
              String(
                routingDecision.locality
              ),
            costPerUnit:
              Number(
                routingDecision.costPerUnit
              ),
            priority:
              Number(
                routingDecision.priority
              ),
            requiredCapabilities:
              [
                ...routingDecision
                  .requiredCapabilities
              ],
            preferredLocality:
              routingDecision
                .preferredLocality ??
              null,
            candidateCount:
              Number(
                routingDecision.candidateCount
              ),
            eligibleCount:
              Number(
                routingDecision.eligibleCount
              ),
            selectedCircuitState:
              String(
                routingDecision.selectedCircuitState ??
                "CLOSED"
              ),
            attemptCount:
              Number(
                routingDecision.attemptCount ??
                1
              ),
            failoverUsed:
              routingDecision.failoverUsed ===
                true,
            failedProviderIds:
              Object.freeze([
                ...(
                  routingDecision
                    .failedProviderIds ??
                  []
                )
              ].map(String))
          }
        : null,
    provider: {
      providerId:
        providerRun
          .usageReceipt
          .providerId,
      usageId:
        providerRun
          .usageReceipt
          .usageId,
      usageMetric:
        providerRun
          .usageReceipt
          .usageMetric,
      modelClass:
        providerRun
          .usageReceipt
          .modelClass,
      usageReceiptSha256:
        providerUsageReceiptSha256,
      signatureVerified: true,
      executionContextShared:
        true,
      sponsorIdentityShared:
        false
    },
    evidence: {
      modelContextSha256:
        sha256Json(
          modelContext
        )
    },
    completed:
      providerRun
        .usageReceipt
        .completed === true
  };

  const receipt =
    typeof broker
      .commitReceiptPayload ===
      "function"
      ? broker
          .commitReceiptPayload(
            receiptPayload,
            receiptPrivateKey
          )
      : (() => {
          const chain =
            broker
              .prepareReceipt(
                receiptPayload
              );

          const chainedPayload = {
            ...receiptPayload,
            chain
          };

          const value =
            receiptPrivateKey
              ? signReceipt(
                  chainedPayload,
                  receiptPrivateKey
                )
              : Object.freeze(
                  chainedPayload
                );

          broker
            .commitReceipt(
              value
            );

          return value;
        })();

  return Object.freeze({
    status: "COMPLETED",
    funded: true,
    result:
      providerRun.result,
    providerUsageReceipt:
      providerRun
        .usageReceipt,
    receipt
  });
}
