function normalizeNow(value) {
  const ms =
    value instanceof Date
      ? value.getTime()
      : Number(value);

  if (
    !Number.isFinite(ms) ||
    ms < 0
  ) {
    throw new TypeError(
      "health clock must return milliseconds"
    );
  }

  return ms;
}

function freezeStatus(value) {
  return Object.freeze({
    providerId:
      value.providerId,
    state:
      value.state,
    successes:
      value.successes,
    failures:
      value.failures,
    consecutiveFailures:
      value.consecutiveFailures,
    lastFailureCode:
      value.lastFailureCode,
    lastFailureAt:
      value.lastFailureAt,
    lastSuccessAt:
      value.lastSuccessAt,
    circuitOpenUntil:
      value.circuitOpenUntil,
    halfOpenLeaseUntil:
      value.halfOpenLeaseUntil
  });
}

export class ProviderHealthTracker {
  #states;
  #failureThreshold;
  #cooldownMs;
  #now;

  constructor({
    failureThreshold = 2,
    cooldownMs = 30_000,
    now = () => Date.now()
  } = {}) {
    if (
      !Number.isInteger(
        failureThreshold
      ) ||
      failureThreshold <= 0
    ) {
      throw new TypeError(
        "failureThreshold must be a positive integer"
      );
    }

    if (
      !Number.isInteger(
        cooldownMs
      ) ||
      cooldownMs <= 0
    ) {
      throw new TypeError(
        "cooldownMs must be a positive integer"
      );
    }

    if (
      typeof now !== "function"
    ) {
      throw new TypeError(
        "now must be a function"
      );
    }

    this.#failureThreshold =
      failureThreshold;

    this.#cooldownMs =
      cooldownMs;

    this.#now = now;

    this.#states =
      new Map();
  }

  #state(providerId) {
    const id =
      String(providerId);

    if (
      !this.#states.has(id)
    ) {
      this.#states.set(
        id,
        {
          providerId: id,
          successes: 0,
          failures: 0,
          consecutiveFailures: 0,
          lastFailureCode: null,
          lastFailureAt: null,
          lastSuccessAt: null,
          circuitOpenUntil: null,
          halfOpenLeaseUntil: null
        }
      );
    }

    return this.#states.get(id);
  }

  status(providerId) {
    const state =
      this.#state(
        providerId
      );

    const nowMs =
      normalizeNow(
        this.#now()
      );

    let circuitState =
      "CLOSED";

    if (
      state
        .circuitOpenUntil !==
        null
    ) {
      const openUntil =
        Date.parse(
          state
            .circuitOpenUntil
        );

      if (
        Number.isFinite(
          openUntil
        ) &&
        nowMs < openUntil
      ) {
        circuitState =
          "OPEN";
      } else if (
        state
          .consecutiveFailures >=
        this.#failureThreshold
      ) {
        circuitState =
          "HALF_OPEN";
      }
    }

    return freezeStatus({
      ...state,
      state:
        circuitState
    });
  }

  recordSuccess(
    providerId
  ) {
    const state =
      this.#state(
        providerId
      );

    const nowMs =
      normalizeNow(
        this.#now()
      );

    state.successes += 1;
    state.consecutiveFailures =
      0;
    state.lastSuccessAt =
      new Date(nowMs)
        .toISOString();
    state.circuitOpenUntil =
      null;
    state.halfOpenLeaseUntil =
      null;
    state.lastFailureCode =
      null;

    return this.status(
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
    const state =
      this.#state(
        providerId
      );

    const nowMs =
      normalizeNow(
        this.#now()
      );

    state.failures += 1;
    state.consecutiveFailures += 1;
    state.lastFailureCode =
      String(code);
    state.lastFailureAt =
      new Date(nowMs)
        .toISOString();

    if (
      state
        .consecutiveFailures >=
      this.#failureThreshold
    ) {
      state.circuitOpenUntil =
        new Date(
          nowMs +
          this.#cooldownMs
        ).toISOString();

      state.halfOpenLeaseUntil =
        null;
    }

    return this.status(
      providerId
    );
  }

  tryAcquireHalfOpen(
    providerId,
    {
      leaseMs = 10_000
    } = {}
  ) {
    if (
      !Number.isInteger(
        leaseMs
      ) ||
      leaseMs <= 0
    ) {
      throw new TypeError(
        "leaseMs must be a positive integer"
      );
    }

    const state =
      this.#state(
        providerId
      );

    const status =
      this.status(
        providerId
      );

    if (
      status.state !==
      "HALF_OPEN"
    ) {
      return false;
    }

    const nowMs =
      normalizeNow(
        this.#now()
      );

    const leaseUntilMs =
      state
        .halfOpenLeaseUntil
        ? Date.parse(
            state
              .halfOpenLeaseUntil
          )
        : NaN;

    if (
      Number.isFinite(
        leaseUntilMs
      ) &&
      leaseUntilMs > nowMs
    ) {
      return false;
    }

    state.halfOpenLeaseUntil =
      new Date(
        nowMs + leaseMs
      ).toISOString();

    return true;
  }

  releaseHalfOpen(
    providerId
  ) {
    const state =
      this.#state(
        providerId
      );

    state.halfOpenLeaseUntil =
      null;

    return this.status(
      providerId
    );
  }

  reset(providerId) {
    this.#states.delete(
      String(providerId)
    );

    return this.status(
      providerId
    );
  }

  snapshot() {
    return Object.freeze(
      [...this.#states.keys()]
        .sort()
        .map(
          (providerId) =>
            this.status(
              providerId
            )
        )
    );
  }
}
