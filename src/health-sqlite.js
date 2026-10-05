import {
  DatabaseSync
} from "node:sqlite";

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

function toIso(ms) {
  return new Date(ms)
    .toISOString();
}

function rowStatus(
  row,
  nowMs,
  failureThreshold
) {
  if (!row) {
    return null;
  }

  let state = "CLOSED";

  if (
    row.circuit_open_until !==
    null
  ) {
    const openUntil =
      Date.parse(
        row.circuit_open_until
      );

    if (
      Number.isFinite(openUntil) &&
      nowMs < openUntil
    ) {
      state = "OPEN";
    } else if (
      Number(
        row.consecutive_failures
      ) >= failureThreshold
    ) {
      state = "HALF_OPEN";
    }
  }

  return Object.freeze({
    providerId:
      String(row.provider_id),
    state,
    successes:
      Number(row.successes),
    failures:
      Number(row.failures),
    consecutiveFailures:
      Number(
        row.consecutive_failures
      ),
    lastFailureCode:
      row.last_failure_code ??
      null,
    lastFailureAt:
      row.last_failure_at ??
      null,
    lastSuccessAt:
      row.last_success_at ??
      null,
    circuitOpenUntil:
      row.circuit_open_until ??
      null,
    halfOpenLeaseUntil:
      row.half_open_lease_until ??
      null
  });
}

export class SqliteProviderHealthTracker {
  #db;
  #failureThreshold;
  #cooldownMs;
  #halfOpenLeaseMs;
  #now;

  constructor(
    filePath,
    {
      failureThreshold = 2,
      cooldownMs = 30_000,
      halfOpenLeaseMs = 10_000,
      busyTimeoutMs = 5000,
      now = () => Date.now()
    } = {}
  ) {
    if (!filePath) {
      throw new TypeError(
        "filePath is required"
      );
    }

    for (
      const [name, value]
      of [
        [
          "failureThreshold",
          failureThreshold
        ],
        [
          "cooldownMs",
          cooldownMs
        ],
        [
          "halfOpenLeaseMs",
          halfOpenLeaseMs
        ],
        [
          "busyTimeoutMs",
          busyTimeoutMs
        ]
      ]
    ) {
      if (
        !Number.isInteger(value) ||
        value <= 0
      ) {
        throw new TypeError(
          `${name} must be a positive integer`
        );
      }
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

    this.#halfOpenLeaseMs =
      halfOpenLeaseMs;

    this.#now = now;

    this.#db =
      new DatabaseSync(
        String(filePath)
      );

    this.#db.exec(
      `PRAGMA busy_timeout = ${busyTimeoutMs};
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;`
    );

    this.#db.exec(`
CREATE TABLE IF NOT EXISTS provider_health (
  provider_id TEXT PRIMARY KEY,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_failure_code TEXT,
  last_failure_at TEXT,
  last_success_at TEXT,
  circuit_open_until TEXT,
  half_open_lease_until TEXT
);
`);
  }

  #transaction(fn) {
    this.#db.exec(
      "BEGIN IMMEDIATE"
    );

    try {
      const result = fn();
      this.#db.exec(
        "COMMIT"
      );

      return result;
    } catch (error) {
      try {
        this.#db.exec(
          "ROLLBACK"
        );
      } catch {
        // Preserve original error.
      }

      throw error;
    }
  }

  #ensure(providerId) {
    const id =
      String(providerId);

    this.#db
      .prepare(`
INSERT OR IGNORE INTO provider_health (
  provider_id
) VALUES (?)
`)
      .run(id);

    return id;
  }

  #row(providerId) {
    return this.#db
      .prepare(
        "SELECT * FROM provider_health WHERE provider_id = ?"
      )
      .get(
        String(providerId)
      );
  }

  status(providerId) {
    const id =
      this.#transaction(
        () =>
          this.#ensure(
            providerId
          )
      );

    return rowStatus(
      this.#row(id),
      normalizeNow(
        this.#now()
      ),
      this.#failureThreshold
    );
  }

  recordSuccess(
    providerId
  ) {
    return this.#transaction(
      () => {
        const id =
          this.#ensure(
            providerId
          );

        const nowMs =
          normalizeNow(
            this.#now()
          );

        this.#db
          .prepare(`
UPDATE provider_health
SET successes = successes + 1,
    consecutive_failures = 0,
    last_success_at = ?,
    last_failure_code = NULL,
    circuit_open_until = NULL,
    half_open_lease_until = NULL
WHERE provider_id = ?
`)
          .run(
            toIso(nowMs),
            id
          );

        return rowStatus(
          this.#row(id),
          nowMs,
          this.#failureThreshold
        );
      }
    );
  }

  recordFailure(
    providerId,
    {
      code =
        "PROVIDER_FAILURE"
    } = {}
  ) {
    return this.#transaction(
      () => {
        const id =
          this.#ensure(
            providerId
          );

        const nowMs =
          normalizeNow(
            this.#now()
          );

        const row =
          this.#row(id);

        const consecutive =
          Number(
            row
              .consecutive_failures
          ) + 1;

        const circuitOpenUntil =
          consecutive >=
            this.#failureThreshold
            ? toIso(
                nowMs +
                this.#cooldownMs
              )
            : row
                .circuit_open_until;

        this.#db
          .prepare(`
UPDATE provider_health
SET failures = failures + 1,
    consecutive_failures = ?,
    last_failure_code = ?,
    last_failure_at = ?,
    circuit_open_until = ?,
    half_open_lease_until = NULL
WHERE provider_id = ?
`)
          .run(
            consecutive,
            String(code),
            toIso(nowMs),
            circuitOpenUntil,
            id
          );

        return rowStatus(
          this.#row(id),
          nowMs,
          this.#failureThreshold
        );
      }
    );
  }

  tryAcquireHalfOpen(
    providerId,
    {
      leaseMs =
        this.#halfOpenLeaseMs
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

    return this.#transaction(
      () => {
        const id =
          this.#ensure(
            providerId
          );

        const nowMs =
          normalizeNow(
            this.#now()
          );

        const row =
          this.#row(id);

        const status =
          rowStatus(
            row,
            nowMs,
            this.#failureThreshold
          );

        if (
          status.state !==
          "HALF_OPEN"
        ) {
          return false;
        }

        const leaseUntilMs =
          row
            .half_open_lease_until
            ? Date.parse(
                row
                  .half_open_lease_until
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

        const newLease =
          toIso(
            nowMs + leaseMs
          );

        const result =
          this.#db
            .prepare(`
UPDATE provider_health
SET half_open_lease_until = ?
WHERE provider_id = ?
  AND (
    half_open_lease_until IS NULL
    OR half_open_lease_until <= ?
  )
`)
            .run(
              newLease,
              id,
              toIso(nowMs)
            );

        return (
          Number(
            result.changes
          ) === 1
        );
      }
    );
  }

  releaseHalfOpen(
    providerId
  ) {
    return this.#transaction(
      () => {
        const id =
          this.#ensure(
            providerId
          );

        this.#db
          .prepare(`
UPDATE provider_health
SET half_open_lease_until = NULL
WHERE provider_id = ?
`)
          .run(id);

        return rowStatus(
          this.#row(id),
          normalizeNow(
            this.#now()
          ),
          this.#failureThreshold
        );
      }
    );
  }

  reset(providerId) {
    return this.#transaction(
      () => {
        const id =
          String(providerId);

        this.#db
          .prepare(
            "DELETE FROM provider_health WHERE provider_id = ?"
          )
          .run(id);

        this.#ensure(id);

        return rowStatus(
          this.#row(id),
          normalizeNow(
            this.#now()
          ),
          this.#failureThreshold
        );
      }
    );
  }

  snapshot() {
    const nowMs =
      normalizeNow(
        this.#now()
      );

    return Object.freeze(
      this.#db
        .prepare(
          "SELECT * FROM provider_health ORDER BY provider_id"
        )
        .all()
        .map(
          (row) =>
            rowStatus(
              row,
              nowMs,
              this.#failureThreshold
            )
        )
    );
  }

  close() {
    this.#db.close();
  }
}
