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
    reasons:
      Object.freeze([
        ...result.reasons
      ])
  });
}

export class ProviderRouter {
  #providers;

  constructor(entries = []) {
    this.#providers =
      new Map();

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

  async #evaluate(
    entry,
    request
  ) {
    const reasons = [];

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
    let probeEvidence = null;

    if (
      reasons.length === 0 &&
      entry.probe
    ) {
      try {
        probeEvidence =
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

    const score =
      eligible
        ? Number(
            (
              70 +
              localityScore +
              costScore +
              priorityScore
            ).toFixed(4)
          )
        : null;

    return {
      providerId:
        entry.providerId,
      provider:
        entry.provider,
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
      reasons,
      probeEvidence
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

    evaluated.sort(
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

    const eligible =
      evaluated
        .filter(
          (candidate) =>
            candidate.eligible
        )
        .sort(
          (a, b) => {
            if (
              a.score !== b.score
            ) {
              return (
                b.score -
                a.score
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

    if (
      eligible.length === 0
    ) {
      return Object.freeze({
        selected: false,
        reason:
          "NO_ELIGIBLE_PROVIDER",
        request,
        candidates:
          Object.freeze(
            evaluated.map(
              publicCandidate
            )
          )
      });
    }

    const selected =
      eligible[0];

    const decision =
      Object.freeze({
        schema:
          "sponsorrail.routing.v0.8",
        selectedProviderId:
          selected.providerId,
        score:
          selected.score,
        locality:
          selected.locality,
        costPerUnit:
          selected.costPerUnit,
        priority:
          selected.priority,
        requiredCapabilities:
          request
            .requiredCapabilities,
        preferredLocality:
          request
            .preferredLocality,
        candidateCount:
          evaluated.length,
        eligibleCount:
          eligible.length
      });

    return Object.freeze({
      selected: true,
      provider:
        selected.provider,
      decision,
      request,
      candidates:
        Object.freeze(
          evaluated.map(
            publicCandidate
          )
        )
    });
  }
}

export async function executeRoutedSponsoredTask({
  task,
  broker,
  router,
  providerRegistry,
  routingPreferences = {},
  receiptPrivateKey = null
}) {
  if (
    !router ||
    typeof router.route !==
      "function"
  ) {
    throw new TypeError(
      "router is required"
    );
  }

  const route =
    await router.route(
      task,
      routingPreferences
    );

  if (!route.selected) {
    return Object.freeze({
      status:
        route.reason,
      funded: false,
      routing: {
        request:
          route.request,
        candidates:
          route.candidates
      }
    });
  }

  const {
    executeSponsoredProviderTask
  } =
    await import(
      "./provider.js"
    );

  const execution =
    await executeSponsoredProviderTask({
      task,
      broker,
      provider:
        route.provider,
      providerRegistry,
      receiptPrivateKey,
      routingDecision:
        route.decision
    });

  return Object.freeze({
    ...execution,
    routing:
      Object.freeze({
        decision:
          route.decision,
        candidates:
          route.candidates
      })
  });
}
