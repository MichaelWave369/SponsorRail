import {
  ProviderHealthTracker
} from "./health.js";

function clamp(
  value,
  min,
  max
) {
  return Math.min(
    max,
    Math.max(min, value)
  );
}

function normalizeStringList(
  value,
  fallback
) {
  const source =
    value ?? fallback;

  if (
    !Array.isArray(source) ||
    source.length === 0
  ) {
    throw new TypeError(
      "routing lists must be non-empty arrays"
    );
  }

  return Object.freeze([
    ...new Set(
      source.map(String)
    )
  ]);
}

function sanitizeRoutingRequest(
  task,
  preferences = {}
) {
  if (
    !task ||
    typeof task !== "object"
  ) {
    throw new TypeError(
      "task is required"
    );
  }

  if (
    !Number.isInteger(
      task.computeRequested
    ) ||
    task.computeRequested <= 0
  ) {
    throw new TypeError(
      "computeRequested must be a positive integer"
    );
  }

  const requiredCapabilities =
    normalizeStringList(
      preferences.requiredCapabilities,
      ["chat"]
    );

  const preferredLocality =
    preferences.preferredLocality ??
    null;

  if (
    preferredLocality !== null &&
    !["local", "remote"]
      .includes(
        preferredLocality
      )
  ) {
    throw new TypeError(
      "preferredLocality must be local or remote"
    );
  }

  const maxCostPerUnit =
    preferences.maxCostPerUnit ??
    null;

  if (
    maxCostPerUnit !== null &&
    (
      !Number.isFinite(
        maxCostPerUnit
      ) ||
      maxCostPerUnit < 0
    )
  ) {
    throw new TypeError(
      "maxCostPerUnit must be a non-negative number"
    );
  }

  return Object.freeze({
    taskId:
      String(task.id),
    taskClass:
      String(
        task.taskClass ??
        "software-development"
      ),
    privacy:
      String(
        task.privacy ??
        "blind"
      ),
    computeRequested:
      task.computeRequested,
    requiredCapabilities,
    preferredLocality,
    maxCostPerUnit
  });
}

function publicCandidate(
  result
) {
  return Object.freeze({
    providerId:
      result.providerId,
    eligible:
      result.eligible,
    available:
      result.available,
    score:
      result.score,
    locality:
      result.locality,
    costPerUnit:
      result.costPerUnit,
    priority:
      result.priority,
    capabilities:
      result.capabilities,
    circuitState:
      result.circuitState,
    consecutiveFailures:
      result.consecutiveFailures,
    reasons:
      Object.freeze([
        ...result.reasons
      ])
  });
}

function sortCandidates(
  candidates
) {
  candidates.sort(
    (a, b) => {
      if (
        a.eligible !==
        b.eligible
      ) {
        return a.eligible
          ? -1
          : 1;
      }

      if (
        a.score !== b.score
      ) {
        return (
          (b.score ?? -Infinity) -
          (a.score ?? -Infinity)
        );
      }

      if (
        a.costPerUnit !==
        b.costPerUnit
      ) {
        return (
          a.costPerUnit -
          b.costPerUnit
        );
      }

      return a.providerId
        .localeCompare(
          b.providerId
        );
    }
  );

  return candidates;
}

function routingDecision(
  candidate,
  request,
  candidates,
  {
    attemptCount = 1,
    failedProviderIds = []
  } = {}
) {
  return Object.freeze({
    schema:
      "sponsorrail.routing.v0.10",
    selectedProviderId:
      candidate.providerId,
    score:
      candidate.score,
    locality:
      candidate.locality,
    costPerUnit:
      candidate.costPerUnit,
    priority:
      candidate.priority,
    selectedCircuitState:
      candidate.circuitState,
    requiredCapabilities:
      request
        .requiredCapabilities,
    preferredLocality:
      request
        .preferredLocality,
    candidateCount:
      candidates.length,
    eligibleCount:
      candidates.filter(
        (item) =>
          item.eligible
      ).length,
    attemptCount,
    failoverUsed:
      attemptCount > 1,
    failedProviderIds:
      Object.freeze([
        ...failedProviderIds
      ])
  });
}

export class ProviderRouter {
  #providers;

  constructor(
    entries = [],
    {
      healthTracker =
        new ProviderHealthTracker()
    } = {}
  ) {
    if (
      !healthTracker ||
      typeof healthTracker.status !==
        "function"
    ) {
      throw new TypeError(
        "healthTracker is required"
      );
    }

    this.#providers =
      new Map();

    this.healthTracker =
      healthTracker;

    for (const entry of entries) {
      this.register(entry);
    }
  }

  register({
    providerId,
    provider,
    locality = "remote",
    capabilities = ["chat"],
    taskClasses = ["*"],
    privacyModes = ["blind"],
    maxComputeUnits = null,
    costPerUnit = 0,
    priority = 0,
    probe = null,
    replace = false
  }) {
    if (
      !providerId ||
      !provider ||
      typeof provider.execute !==
        "function"
    ) {
      throw new TypeError(
        "providerId and executable provider are required"
      );
    }

    const id =
      String(providerId);

    if (
      provider.providerId &&
      String(provider.providerId) !==
        id
    ) {
      throw new Error(
        "providerId does not match provider adapter identity"
      );
    }

    if (
      this.#providers.has(id) &&
      !replace
    ) {
      throw new Error(
        "provider already registered"
      );
    }

    if (
      !["local", "remote"]
        .includes(locality)
    ) {
      throw new TypeError(
        "locality must be local or remote"
      );
    }

    if (
      maxComputeUnits !== null &&
      (
        !Number.isInteger(
          maxComputeUnits
        ) ||
        maxComputeUnits <= 0
      )
    ) {
      throw new TypeError(
        "maxComputeUnits must be a positive integer"
      );
    }

    if (
      !Number.isFinite(
        costPerUnit
      ) ||
      costPerUnit < 0
    ) {
      throw new TypeError(
        "costPerUnit must be non-negative"
      );
    }

    if (
      !Number.isFinite(priority)
    ) {
      throw new TypeError(
        "priority must be finite"
      );
    }

    const record =
      Object.freeze({
        providerId: id,
        provider,
        locality,
        capabilities:
          normalizeStringList(
            capabilities,
            ["chat"]
          ),
        taskClasses:
          normalizeStringList(
            taskClasses,
            ["*"]
          ),
        privacyModes:
          normalizeStringList(
            privacyModes,
            ["blind"]
          ),
        maxComputeUnits,
        costPerUnit,
        priority,
        probe:
          probe ??
          (
            typeof provider.probe ===
              "function"
              ? () =>
                  provider.probe()
              : null
          )
      });

    this.#providers.set(
      id,
      record
    );

    return record;
  }

  getProvider(providerId) {
    return (
      this.#providers.get(
        String(providerId)
      )?.provider ??
      null
    );
  }

  recordSuccess(providerId) {
    return this.healthTracker
      .recordSuccess(
        providerId
      );
  }

  recordFailure(
    providerId,
    {
      code =
        "PROVIDER_FAILURE"
    } = {}
  ) {
    return this.healthTracker
      .recordFailure(
        providerId,
        { code }
      );
  }

  healthSnapshot() {
    return this.healthTracker
      .snapshot();
  }

  tryAcquireHalfOpen(
    providerId,
    options = {}
  ) {
    if (
      typeof this.healthTracker
        .tryAcquireHalfOpen !==
      "function"
    ) {
      return true;
    }

    return this.healthTracker
      .tryAcquireHalfOpen(
        providerId,
        options
      );
  }

  releaseHalfOpen(
    providerId
  ) {
    if (
      typeof this.healthTracker
        .releaseHalfOpen !==
      "function"
    ) {
      return null;
    }

    return this.healthTracker
      .releaseHalfOpen(
        providerId
      );
  }

  async #evaluate(
    entry,
    request
  ) {
    const reasons = [];

    const health =
      this.healthTracker
        .status(
          entry.providerId
        );

    if (
      health.state ===
      "OPEN"
    ) {
      reasons.push(
        "CIRCUIT_OPEN"
      );
    }

    const taskEligible =
      entry.taskClasses
        .includes("*") ||
      entry.taskClasses
        .includes(
          request.taskClass
        );

    if (!taskEligible) {
      reasons.push(
        "TASK_CLASS_MISMATCH"
      );
    }

    const privacyEligible =
      entry.privacyModes
        .includes(
          request.privacy
        );

    if (!privacyEligible) {
      reasons.push(
        "PRIVACY_MISMATCH"
      );
    }

    const capabilityEligible =
      request.requiredCapabilities
        .every(
          (capability) =>
            entry.capabilities
              .includes(
                capability
              )
        );

    if (!capabilityEligible) {
      reasons.push(
        "CAPABILITY_MISMATCH"
      );
    }

    const computeEligible =
      entry.maxComputeUnits ===
        null ||
      request.computeRequested <=
        entry.maxComputeUnits;

    if (!computeEligible) {
      reasons.push(
        "COMPUTE_LIMIT"
      );
    }

    const costEligible =
      request.maxCostPerUnit ===
        null ||
      entry.costPerUnit <=
        request.maxCostPerUnit;

    if (!costEligible) {
      reasons.push(
        "COST_LIMIT"
      );
    }

    let available = true;

    if (
      reasons.length === 0 &&
      entry.probe
    ) {
      try {
        const probeEvidence =
          await entry.probe();

        available =
          probeEvidence === true ||
          probeEvidence?.available ===
            true;
      } catch {
        available = false;
      }

      if (!available) {
        reasons.push(
          "UNAVAILABLE"
        );
      }
    } else if (
      health.state ===
      "OPEN"
    ) {
      available = false;
    }

    const eligible =
      reasons.length === 0 &&
      available;

    const localityScore =
      request.preferredLocality ===
        null
        ? 5
        : request
              .preferredLocality ===
            entry.locality
          ? 10
          : 0;

    const costScore =
      request.maxCostPerUnit !==
        null &&
      request.maxCostPerUnit > 0
        ? clamp(
            10 *
              (
                1 -
                entry.costPerUnit /
                  request
                    .maxCostPerUnit
              ),
            0,
            10
          )
        : clamp(
            10 /
              (
                1 +
                entry.costPerUnit
              ),
            0,
            10
          );

    const priorityScore =
      clamp(
        entry.priority,
        -10,
        10
      );

    const halfOpenPenalty =
      health.state ===
        "HALF_OPEN"
        ? 5
        : 0;

    const score =
      eligible
        ? Number(
            (
              70 +
              localityScore +
              costScore +
              priorityScore -
              halfOpenPenalty
            ).toFixed(4)
          )
        : null;

    return {
      providerId:
        entry.providerId,
      eligible,
      available,
      score,
      locality:
        entry.locality,
      costPerUnit:
        entry.costPerUnit,
      priority:
        entry.priority,
      capabilities:
        entry.capabilities,
      circuitState:
        health.state,
      consecutiveFailures:
        health
          .consecutiveFailures,
      reasons
    };
  }

  async discover(
    task,
    preferences = {}
  ) {
    const request =
      sanitizeRoutingRequest(
        task,
        preferences
      );

    const evaluated =
      await Promise.all(
        [
          ...this.#providers
            .values()
        ].map(
          (entry) =>
            this.#evaluate(
              entry,
              request
            )
        )
      );

    sortCandidates(
      evaluated
    );

    return Object.freeze({
      request,
      candidates:
        Object.freeze(
          evaluated.map(
            publicCandidate
          )
        )
    });
  }

  async route(
    task,
    preferences = {}
  ) {
    const discovery =
      await this.discover(
        task,
        preferences
      );

    const selected =
      discovery.candidates.find(
        (candidate) =>
          candidate.eligible
      );

    if (!selected) {
      return Object.freeze({
        selected: false,
        reason:
          "NO_ELIGIBLE_PROVIDER",
        request:
          discovery.request,
        candidates:
          discovery.candidates
      });
    }

    const provider =
      this.getProvider(
        selected.providerId
      );

    if (!provider) {
      throw new Error(
        "selected provider disappeared"
      );
    }

    const decision =
      routingDecision(
        selected,
        discovery.request,
        discovery.candidates
      );

    return Object.freeze({
      selected: true,
      provider,
      decision,
      request:
        discovery.request,
      candidates:
        discovery.candidates
    });
  }
}

export async function executeRoutedSponsoredTask({
  task,
  broker,
  router,
  providerRegistry,
  routingPreferences = {},
  receiptPrivateKey = null,
  maxAttempts = 3
}) {
  if (
    !router ||
    typeof router.discover !==
      "function" ||
    typeof router.getProvider !==
      "function"
  ) {
    throw new TypeError(
      "router is required"
    );
  }

  if (
    !Number.isInteger(
      maxAttempts
    ) ||
    maxAttempts <= 0
  ) {
    throw new TypeError(
      "maxAttempts must be a positive integer"
    );
  }

  const discovery =
    await router.discover(
      task,
      routingPreferences
    );

  const eligible =
    discovery.candidates.filter(
      (candidate) =>
        candidate.eligible
    );

  if (
    eligible.length === 0
  ) {
    return Object.freeze({
      status:
        "NO_ELIGIBLE_PROVIDER",
      funded: false,
      routing: {
        request:
          discovery.request,
        candidates:
          discovery.candidates,
        attempts:
          Object.freeze([])
      }
    });
  }

  const {
    executeSponsoredProviderTask,
    isSafeProviderRetry
  } =
    await import(
      "./provider.js"
    );

  const attempts = [];

  let executionAttempts = 0;

  for (
    let index = 0;
    index < eligible.length;
    index += 1
  ) {
    if (
      executionAttempts >=
      maxAttempts
    ) {
      break;
    }

    const candidate =
      eligible[index];

    if (
      candidate.circuitState ===
        "HALF_OPEN" &&
      !router.tryAcquireHalfOpen(
        candidate.providerId
      )
    ) {
      attempts.push(
        Object.freeze({
          providerId:
            candidate.providerId,
          outcome:
            "SKIPPED",
          code:
            "HALF_OPEN_BUSY",
          safeToRetry:
            false
        })
      );

      continue;
    }

    const provider =
      router.getProvider(
        candidate.providerId
      );

    if (!provider) {
      router.releaseHalfOpen(
        candidate.providerId
      );

      continue;
    }

    executionAttempts += 1;

    const failedProviderIds =
      attempts
        .filter(
          (attempt) =>
            attempt.outcome ===
            "FAILED"
        )
        .map(
          (attempt) =>
            attempt.providerId
        );

    const decision =
      routingDecision(
        candidate,
        discovery.request,
        discovery.candidates,
        {
          attemptCount:
            executionAttempts,
          failedProviderIds
        }
      );

    try {
      const execution =
        await executeSponsoredProviderTask({
          task,
          broker,
          provider,
          providerRegistry,
          receiptPrivateKey,
          routingDecision:
            decision
        });

      if (!execution.funded) {
        router.releaseHalfOpen(
          candidate.providerId
        );

        return Object.freeze({
          ...execution,
          routing:
            Object.freeze({
              decision,
              candidates:
                discovery.candidates,
              attempts:
                Object.freeze([
                  ...attempts
                ])
            })
        });
      }

      router.recordSuccess(
        candidate.providerId
      );

      const completedAttempts =
        Object.freeze([
          ...attempts,
          Object.freeze({
            providerId:
              candidate.providerId,
            outcome:
              "COMPLETED",
            code: null,
            safeToRetry:
              false
          })
        ]);

      return Object.freeze({
        ...execution,
        routing:
          Object.freeze({
            decision,
            candidates:
              discovery.candidates,
            attempts:
              completedAttempts
          })
      });
    } catch (error) {
      const safeToRetry =
        isSafeProviderRetry(
          error
        );

      const code =
        String(
          error?.code ??
          error?.name ??
          "PROVIDER_FAILURE"
        );

      router.recordFailure(
        candidate.providerId,
        { code }
      );

      attempts.push(
        Object.freeze({
          providerId:
            candidate.providerId,
          outcome:
            "FAILED",
          code,
          safeToRetry
        })
      );

      const hasNext =
        executionAttempts <
          maxAttempts &&
        index + 1 <
          eligible.length;

      if (
        !safeToRetry ||
        !hasNext
      ) {
        error.routing =
          Object.freeze({
            candidates:
              discovery.candidates,
            attempts:
              Object.freeze([
                ...attempts
              ])
          });

        throw error;
      }
    }
  }

  return Object.freeze({
    status:
      "NO_ELIGIBLE_PROVIDER",
    funded: false,
    routing: {
      request:
        discovery.request,
      candidates:
        discovery.candidates,
      attempts:
        Object.freeze([
          ...attempts
        ])
    }
  });
}
