import {
  createHash,
  randomUUID
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import {
  evaluatePolicy,
  sanitizeFundingRequest,
  signReceipt
} from "./sponsorrail.js";

const DEFAULT_GRANT_TTL_MS =
  5 * 60 * 1000;

function assertPositiveInteger(value, name) {
  if (
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(
      `${name} must be a positive integer`
    );
  }
}

function assertNonNegativeInteger(
  value,
  name
) {
  if (
    !Number.isInteger(value) ||
    value < 0
  ) {
    throw new TypeError(
      `${name} must be a non-negative integer`
    );
  }
}

function normalizeTime(value, name) {
  const milliseconds =
    value instanceof Date
      ? value.getTime()
      : Number(value);

  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0
  ) {
    throw new TypeError(
      `${name} must be a valid time`
    );
  }

  return milliseconds;
}

function toIso(milliseconds) {
  return new Date(milliseconds)
    .toISOString();
}

function isExpired(expiresAt, nowMs) {
  const expiresMs =
    Date.parse(expiresAt);

  return (
    Number.isFinite(expiresMs) &&
    expiresMs <= nowMs
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

function computeReceiptHash(
  payload,
  previousReceiptHash,
  sequence
) {
  return createHash("sha256")
    .update(
      canonicalJson({
        previousReceiptHash:
          previousReceiptHash ??
          null,
        sequence,
        payload
      })
    )
    .digest("hex");
}

function settlementResult(row) {
  return Object.freeze({
    reservedUnits:
      Number(row.reserved_units),
    usedUnits:
      Number(row.used_units),
    refundUnits:
      Number(row.refund_units)
  });
}

function normalizePolicy({
  eligibleTaskClasses = ["*"],
  allowedPrivacyModes = ["blind"],
  maxComputePerGrant = null
} = {}) {
  if (
    !Array.isArray(
      eligibleTaskClasses
    ) ||
    eligibleTaskClasses.length === 0
  ) {
    throw new TypeError(
      "eligibleTaskClasses cannot be empty"
    );
  }

  if (
    !Array.isArray(
      allowedPrivacyModes
    ) ||
    allowedPrivacyModes.length === 0
  ) {
    throw new TypeError(
      "allowedPrivacyModes cannot be empty"
    );
  }

  if (
    maxComputePerGrant !== null
  ) {
    assertPositiveInteger(
      maxComputePerGrant,
      "maxComputePerGrant"
    );
  }

  return {
    eligibleTaskClasses:
      [...new Set(
        eligibleTaskClasses.map(String)
      )],
    allowedPrivacyModes:
      [...new Set(
        allowedPrivacyModes.map(String)
      )],
    maxComputePerGrant
  };
}

function rowPolicy(row) {
  return {
    eligibleTaskClasses:
      JSON.parse(
        row.eligible_task_classes
      ),
    allowedPrivacyModes:
      JSON.parse(
        row.allowed_privacy_modes
      ),
    maxComputePerGrant:
      row.max_compute_per_grant ===
        null
        ? null
        : Number(
            row.max_compute_per_grant
          )
  };
}

function mapGrant(row) {
  if (!row) {
    return null;
  }

  return Object.freeze({
    funded: true,
    grantId:
      String(row.grant_id),
    poolId:
      String(row.pool_id),
    reservationId:
      String(row.reservation_id),
    taskId:
      String(row.task_id),
    taskClass:
      String(row.task_class),
    privacy:
      String(row.privacy),
    computeUnits:
      Number(row.compute_units),
    sponsorDisclosure:
      String(
        row.sponsor_disclosure
      ),
    issuedAt:
      String(row.issued_at),
    expiresAt:
      String(row.expires_at),
    lastHeartbeatAt:
      row.last_heartbeat_at ??
      null
  });
}

export class SqliteFundingBroker {
  #db;
  #now;
  #grantTtlMs;

  constructor(
    filePath,
    {
      grantTtlMs =
        DEFAULT_GRANT_TTL_MS,
      now =
        () => Date.now(),
      busyTimeoutMs = 5000,
      autoReconcile = true
    } = {}
  ) {
    if (!filePath) {
      throw new TypeError(
        "filePath is required"
      );
    }

    assertPositiveInteger(
      grantTtlMs,
      "grantTtlMs"
    );

    assertPositiveInteger(
      busyTimeoutMs,
      "busyTimeoutMs"
    );

    if (
      typeof now !== "function"
    ) {
      throw new TypeError(
        "now must be a function"
      );
    }

    this.#grantTtlMs =
      grantTtlMs;

    this.#now = now;

    this.#db =
      new DatabaseSync(
        String(filePath)
      );

    this.#db.exec(
      `PRAGMA busy_timeout = ${busyTimeoutMs};
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;`
    );

    this.#initialize();

    if (autoReconcile) {
      this.reconcile();
    }
  }

  #initialize() {
    this.#db.exec(`
CREATE TABLE IF NOT EXISTS sponsor_pools (
  id TEXT PRIMARY KEY,
  sponsor_disclosure TEXT NOT NULL,
  available_credits INTEGER NOT NULL CHECK (available_credits >= 0),
  reserved_credits INTEGER NOT NULL CHECK (reserved_credits >= 0),
  spent_credits INTEGER NOT NULL CHECK (spent_credits >= 0),
  eligible_task_classes TEXT NOT NULL,
  allowed_privacy_modes TEXT NOT NULL,
  max_compute_per_grant INTEGER
);

CREATE TABLE IF NOT EXISTS grants (
  grant_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES sponsor_pools(id) ON DELETE RESTRICT,
  reservation_id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL,
  task_class TEXT NOT NULL,
  privacy TEXT NOT NULL,
  compute_units INTEGER NOT NULL CHECK (compute_units > 0),
  sponsor_disclosure TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT
);

CREATE TABLE IF NOT EXISTS settlements (
  idempotency_key TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL UNIQUE,
  pool_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  reserved_units INTEGER NOT NULL,
  used_units INTEGER NOT NULL,
  refund_units INTEGER NOT NULL,
  settled_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipts (
  sequence INTEGER PRIMARY KEY,
  receipt_hash TEXT NOT NULL UNIQUE,
  previous_receipt_hash TEXT,
  receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grants_pool
  ON grants(pool_id);

CREATE INDEX IF NOT EXISTS idx_grants_expiry
  ON grants(expires_at);

CREATE INDEX IF NOT EXISTS idx_settlements_grant
  ON settlements(grant_id);

INSERT OR IGNORE INTO meta(key, value)
  VALUES ('receipt_sequence', '0');

INSERT OR IGNORE INTO meta(key, value)
  VALUES ('receipt_head', '');
`);
  }

  #transaction(fn) {
    this.#db.exec(
      "BEGIN IMMEDIATE"
    );

    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // The original failure is more useful.
      }

      throw error;
    }
  }

  #poolRow(poolId) {
    return this.#db
      .prepare(
        "SELECT * FROM sponsor_pools WHERE id = ?"
      )
      .get(String(poolId));
  }

  #grantRow(grantId) {
    return this.#db
      .prepare(
        "SELECT * FROM grants WHERE grant_id = ?"
      )
      .get(String(grantId));
  }

  #releaseGrantRow(row) {
    this.#db
      .prepare(`
UPDATE sponsor_pools
SET available_credits =
      available_credits + ?,
    reserved_credits =
      reserved_credits - ?
WHERE id = ?
`)
      .run(
        row.compute_units,
        row.compute_units,
        row.pool_id
      );

    this.#db
      .prepare(
        "DELETE FROM grants WHERE grant_id = ?"
      )
      .run(row.grant_id);
  }

  createPool({
    id,
    sponsorDisclosure,
    balanceCredits,
    eligibleTaskClasses = ["*"],
    allowedPrivacyModes = ["blind"],
    maxComputePerGrant = null
  }) {
    if (
      !id ||
      !sponsorDisclosure
    ) {
      throw new TypeError(
        "pool id and sponsorDisclosure are required"
      );
    }

    assertNonNegativeInteger(
      balanceCredits,
      "balanceCredits"
    );

    const policy =
      normalizePolicy({
        eligibleTaskClasses,
        allowedPrivacyModes,
        maxComputePerGrant
      });

    this.#db
      .prepare(`
INSERT INTO sponsor_pools (
  id,
  sponsor_disclosure,
  available_credits,
  reserved_credits,
  spent_credits,
  eligible_task_classes,
  allowed_privacy_modes,
  max_compute_per_grant
) VALUES (?, ?, ?, 0, 0, ?, ?, ?)
`)
      .run(
        String(id),
        String(
          sponsorDisclosure
        ),
        balanceCredits,
        JSON.stringify(
          policy
            .eligibleTaskClasses
        ),
        JSON.stringify(
          policy
            .allowedPrivacyModes
        ),
        policy
          .maxComputePerGrant
      );

    return this.poolSnapshot(id);
  }

  poolSnapshot(poolId) {
    const row =
      this.#poolRow(poolId);

    if (!row) {
      return null;
    }

    const availableCredits =
      Number(
        row.available_credits
      );

    const reservedCredits =
      Number(
        row.reserved_credits
      );

    const spentCredits =
      Number(
        row.spent_credits
      );

    return Object.freeze({
      schema:
        "sponsorrail.sqlite-pool.v0.5",
      id:
        String(row.id),
      sponsorDisclosure:
        String(
          row.sponsor_disclosure
        ),
      policy:
        rowPolicy(row),
      availableCredits,
      reservedCredits,
      spentCredits,
      totalCredits:
        availableCredits +
        reservedCredits +
        spentCredits
    });
  }

  listPools() {
    return this.#db
      .prepare(
        "SELECT id FROM sponsor_pools ORDER BY id"
      )
      .all()
      .map(
        (row) =>
          this.poolSnapshot(
            row.id
          )
      );
  }

  authorize(task) {
    if (
      task
        .allowSponsorship ===
      false
    ) {
      return Object.freeze({
        funded: false,
        reason:
          "SPONSORSHIP_DECLINED"
      });
    }

    const request =
      sanitizeFundingRequest(
        task
      );

    const nowMs =
      normalizeTime(
        this.#now(),
        "now"
      );

    const issuedAt =
      toIso(nowMs);

    const expiresAt =
      toIso(
        nowMs +
        this.#grantTtlMs
      );

    return this.#transaction(
      () => {
        const rows =
          this.#db
            .prepare(
              "SELECT * FROM sponsor_pools ORDER BY id"
            )
            .all();

        let lastReason =
          "NO_ELIGIBLE_SPONSOR_POOL";

        for (const row of rows) {
          const decision =
            evaluatePolicy(
              request,
              rowPolicy(row)
            );

          if (
            !decision.eligible
          ) {
            lastReason =
              decision.reason;

            continue;
          }

          const update =
            this.#db
              .prepare(`
UPDATE sponsor_pools
SET available_credits =
      available_credits - ?,
    reserved_credits =
      reserved_credits + ?
WHERE id = ?
  AND available_credits >= ?
`)
              .run(
                request
                  .computeRequested,
                request
                  .computeRequested,
                row.id,
                request
                  .computeRequested
              );

          if (
            Number(
              update.changes
            ) !== 1
          ) {
            lastReason =
              "INSUFFICIENT_SPONSOR_CREDITS";

            continue;
          }

          const grant =
            Object.freeze({
              funded: true,
              grantId:
                randomUUID(),
              poolId:
                String(row.id),
              reservationId:
                randomUUID(),
              taskId:
                request.taskId,
              taskClass:
                request.taskClass,
              privacy:
                request.privacy,
              computeUnits:
                request
                  .computeRequested,
              sponsorDisclosure:
                String(
                  row.sponsor_disclosure
                ),
              issuedAt,
              expiresAt
            });

          this.#db
            .prepare(`
INSERT INTO grants (
  grant_id,
  pool_id,
  reservation_id,
  task_id,
  task_class,
  privacy,
  compute_units,
  sponsor_disclosure,
  issued_at,
  expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
            .run(
              grant.grantId,
              grant.poolId,
              grant
                .reservationId,
              grant.taskId,
              grant.taskClass,
              grant.privacy,
              grant.computeUnits,
              grant
                .sponsorDisclosure,
              grant.issuedAt,
              grant.expiresAt
            );

          return grant;
        }

        return Object.freeze({
          funded: false,
          reason:
            lastReason
        });
      }
    );
  }

  heartbeat(
    grant,
    {
      leaseMs =
        this.#grantTtlMs
    } = {}
  ) {
    assertPositiveInteger(
      leaseMs,
      "leaseMs"
    );

    const nowMs =
      normalizeTime(
        this.#now(),
        "now"
      );

    const outcome =
      this.#transaction(
        () => {
          const row =
            this.#grantRow(
              grant?.grantId
            );

          if (!row) {
            return {
              unknown: true
            };
          }

          if (
            isExpired(
              row.expires_at,
              nowMs
            )
          ) {
            this.#releaseGrantRow(
              row
            );

            return {
              expired: true
            };
          }

          const renewedExpiry =
            toIso(
              Math.max(
                Date.parse(
                  row.expires_at
                ),
                nowMs + leaseMs
              )
            );

          const heartbeatAt =
            toIso(nowMs);

          this.#db
            .prepare(`
UPDATE grants
SET expires_at = ?,
    last_heartbeat_at = ?
WHERE grant_id = ?
`)
            .run(
              renewedExpiry,
              heartbeatAt,
              row.grant_id
            );

          return mapGrant(
            this.#grantRow(
              row.grant_id
            )
          );
        }
      );

    if (outcome.unknown) {
      throw new Error(
        "unknown grant"
      );
    }

    if (outcome.expired) {
      throw new Error(
        "grant expired"
      );
    }

    return outcome;
  }

  settle(
    grant,
    usedUnits,
    {
      idempotencyKey =
        grant?.grantId
    } = {}
  ) {
    assertNonNegativeInteger(
      usedUnits,
      "usedUnits"
    );

    if (!idempotencyKey) {
      throw new TypeError(
        "idempotencyKey is required"
      );
    }

    const key =
      String(
        idempotencyKey
      );

    const nowMs =
      normalizeTime(
        this.#now(),
        "now"
      );

    const outcome =
      this.#transaction(
        () => {
          const existing =
            this.#db
              .prepare(
                "SELECT * FROM settlements WHERE idempotency_key = ?"
              )
              .get(key);

          if (existing) {
            if (
              String(
                existing.grant_id
              ) !==
                String(
                  grant?.grantId
                ) ||
              Number(
                existing.used_units
              ) !==
                usedUnits
            ) {
              return {
                conflict: true
              };
            }

            return {
              settlement:
                settlementResult(
                  existing
                )
            };
          }

          const byGrant =
            this.#db
              .prepare(
                "SELECT * FROM settlements WHERE grant_id = ?"
              )
              .get(
                String(
                  grant?.grantId
                )
              );

          if (byGrant) {
            if (
              Number(
                byGrant.used_units
              ) !==
              usedUnits
            ) {
              return {
                conflict: true
              };
            }

            return {
              settlement:
                settlementResult(
                  byGrant
                )
            };
          }

          const row =
            this.#grantRow(
              grant?.grantId
            );

          if (!row) {
            return {
              unknown: true
            };
          }

          if (
            isExpired(
              row.expires_at,
              nowMs
            )
          ) {
            this.#releaseGrantRow(
              row
            );

            return {
              expired: true
            };
          }

          if (
            usedUnits >
            Number(
              row.compute_units
            )
          ) {
            return {
              invalidUsage: true
            };
          }

          const refundUnits =
            Number(
              row.compute_units
            ) -
            usedUnits;

          this.#db
            .prepare(`
UPDATE sponsor_pools
SET available_credits =
      available_credits + ?,
    reserved_credits =
      reserved_credits - ?,
    spent_credits =
      spent_credits + ?
WHERE id = ?
`)
            .run(
              refundUnits,
              row.compute_units,
              usedUnits,
              row.pool_id
            );

          this.#db
            .prepare(
              "DELETE FROM grants WHERE grant_id = ?"
            )
            .run(
              row.grant_id
            );

          const record = {
            idempotencyKey:
              key,
            grantId:
              String(
                row.grant_id
              ),
            poolId:
              String(
                row.pool_id
              ),
            reservationId:
              String(
                row.reservation_id
              ),
            reservedUnits:
              Number(
                row.compute_units
              ),
            usedUnits,
            refundUnits,
            settledAt:
              toIso(nowMs)
          };

          this.#db
            .prepare(`
INSERT INTO settlements (
  idempotency_key,
  grant_id,
  pool_id,
  reservation_id,
  reserved_units,
  used_units,
  refund_units,
  settled_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
            .run(
              record
                .idempotencyKey,
              record.grantId,
              record.poolId,
              record
                .reservationId,
              record
                .reservedUnits,
              record.usedUnits,
              record
                .refundUnits,
              record.settledAt
            );

          return {
            settlement:
              Object.freeze({
                reservedUnits:
                  record
                    .reservedUnits,
                usedUnits:
                  record
                    .usedUnits,
                refundUnits:
                  record
                    .refundUnits
              })
          };
        }
      );

    if (outcome.conflict) {
      throw new Error(
        "idempotency conflict"
      );
    }

    if (outcome.unknown) {
      throw new Error(
        "unknown grant"
      );
    }

    if (outcome.expired) {
      throw new Error(
        "grant expired"
      );
    }

    if (
      outcome.invalidUsage
    ) {
      throw new Error(
        "settlement exceeds reserved compute"
      );
    }

    return outcome.settlement;
  }

  release(grant) {
    return this.#transaction(
      () => {
        const row =
          this.#grantRow(
            grant?.grantId
          );

        if (!row) {
          return false;
        }

        this.#releaseGrantRow(
          row
        );

        return true;
      }
    );
  }

  reconcile({
    now = this.#now()
  } = {}) {
    const nowMs =
      normalizeTime(
        now,
        "now"
      );

    const expired = [];

    this.#transaction(
      () => {
        const rows =
          this.#db
            .prepare(
              "SELECT * FROM grants ORDER BY grant_id"
            )
            .all();

        for (const row of rows) {
          if (
            !isExpired(
              row.expires_at,
              nowMs
            )
          ) {
            continue;
          }

          expired.push(
            String(
              row.grant_id
            )
          );

          this.#releaseGrantRow(
            row
          );
        }
      }
    );

    return Object.freeze({
      expiredGrants:
        Object.freeze(
          expired
        ),
      staleGrants:
        Object.freeze([]),
      orphanReservations:
        Object.freeze([]),
      releasedOrphans:
        Object.freeze([])
    });
  }

  receiptChainState() {
    const sequence =
      Number(
        this.#db
          .prepare(
            "SELECT value FROM meta WHERE key = 'receipt_sequence'"
          )
          .get()
          .value
      );

    const headValue =
      String(
        this.#db
          .prepare(
            "SELECT value FROM meta WHERE key = 'receipt_head'"
          )
          .get()
          .value
      );

    return Object.freeze({
      sequence,
      headHash:
        headValue || null
    });
  }

  receiptJournal() {
    return Object.freeze(
      this.#db
        .prepare(
          "SELECT receipt_json FROM receipts ORDER BY sequence"
        )
        .all()
        .map(
          (row) =>
            JSON.parse(
              row.receipt_json
            )
        )
    );
  }

  commitReceiptPayload(
    payload,
    privateKey = null
  ) {
    if (
      !payload ||
      typeof payload !==
        "object"
    ) {
      throw new TypeError(
        "receipt payload is required"
      );
    }

    return this.#transaction(
      () => {
        const state =
          this.receiptChainState();

        const sequence =
          state.sequence + 1;

        const previousReceiptHash =
          state.headHash;

        const receiptHash =
          computeReceiptHash(
            payload,
            previousReceiptHash,
            sequence
          );

        const chainedPayload = {
          ...payload,
          chain: {
            sequence,
            previousReceiptHash,
            receiptHash
          }
        };

        const receipt =
          privateKey
            ? signReceipt(
                chainedPayload,
                privateKey
              )
            : Object.freeze(
                chainedPayload
              );

        this.#db
          .prepare(`
INSERT INTO receipts (
  sequence,
  receipt_hash,
  previous_receipt_hash,
  receipt_json
) VALUES (?, ?, ?, ?)
`)
          .run(
            sequence,
            receiptHash,
            previousReceiptHash,
            JSON.stringify(
              receipt
            )
          );

        this.#db
          .prepare(
            "UPDATE meta SET value = ? WHERE key = 'receipt_sequence'"
          )
          .run(
            String(sequence)
          );

        this.#db
          .prepare(
            "UPDATE meta SET value = ? WHERE key = 'receipt_head'"
          )
          .run(
            receiptHash
          );

        return receipt;
      }
    );
  }

  close() {
    this.#db.close();
  }
}
