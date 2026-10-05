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

import {
  campaignFundingMetadata,
  validateSponsorCampaign
} from "./campaign.js";

import {
  verifyFundingDeposit,
  verifyFundingHold,
  verifyFundingHoldResolution,
  verifyFundingReversal,
  verifyFundingStatement
} from "./funding.js";

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

function parseJsonOrNull(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  return JSON.parse(
    String(value)
  );
}

function publicCampaign(
  campaign
) {
  return Object.freeze({
    campaignId:
      campaign.campaignId,
    sponsorDisclosure:
      campaign.sponsorDisclosure,
    capabilityType:
      campaign.capabilityType,
    benefitDescription:
      campaign.benefitDescription,
    disclosureLabel:
      campaign.disclosureLabel,
    targetingMode:
      campaign.targetingMode,
    priority:
      campaign.priority,
    experience:
      campaign.experience
  });
}

function normalizeCampaignPreferences({
  allowContextual = false,
  allowedCapabilityTypes = ["*"],
  blockedCampaignIds = []
} = {}) {
  if (
    !Array.isArray(
      allowedCapabilityTypes
    ) ||
    !Array.isArray(
      blockedCampaignIds
    )
  ) {
    throw new TypeError(
      "campaign preference lists must be arrays"
    );
  }

  return Object.freeze({
    allowContextual:
      allowContextual === true,
    allowedCapabilityTypes:
      Object.freeze(
        [...new Set(
          allowedCapabilityTypes
            .map(String)
        )]
      ),
    blockedCampaignIds:
      Object.freeze(
        [...new Set(
          blockedCampaignIds
            .map(String)
        )]
      )
  });
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
    campaign:
      parseJsonOrNull(
        row.campaign_json
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
  #campaignPreferences;

  constructor(
    filePath,
    {
      grantTtlMs =
        DEFAULT_GRANT_TTL_MS,
      now =
        () => Date.now(),
      busyTimeoutMs = 5000,
      autoReconcile = true,
      campaignPreferences = null
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

    this.#campaignPreferences =
      campaignPreferences === null
        ? null
        : normalizeCampaignPreferences(
            campaignPreferences
          );

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

CREATE TABLE IF NOT EXISTS sponsor_campaigns (
  campaign_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL UNIQUE REFERENCES sponsor_pools(id) ON DELETE RESTRICT,
  sponsor_disclosure TEXT NOT NULL,
  capability_type TEXT NOT NULL,
  benefit_description TEXT NOT NULL,
  disclosure_label TEXT NOT NULL,
  targeting_mode TEXT NOT NULL CHECK (targeting_mode IN ('universal', 'contextual')),
  budget_credits INTEGER NOT NULL CHECK (budget_credits > 0),
  eligible_task_classes TEXT NOT NULL,
  allowed_privacy_modes TEXT NOT NULL,
  max_compute_per_grant INTEGER,
  priority REAL NOT NULL,
  experience_json TEXT NOT NULL
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
  last_heartbeat_at TEXT,
  campaign_json TEXT
);

CREATE TABLE IF NOT EXISTS funding_deposits (
  deposit_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES sponsor_campaigns(campaign_id) ON DELETE RESTRICT,
  asset TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  external_reference TEXT,
  occurred_at TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_reversals (
  reversal_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  original_deposit_id TEXT NOT NULL REFERENCES funding_deposits(deposit_id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES sponsor_campaigns(campaign_id) ON DELETE RESTRICT,
  asset TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  reason TEXT NOT NULL,
  external_reference TEXT,
  occurred_at TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_funding_liabilities (
  campaign_id TEXT PRIMARY KEY REFERENCES sponsor_campaigns(campaign_id) ON DELETE RESTRICT,
  outstanding_credits INTEGER NOT NULL CHECK (outstanding_credits >= 0)
);

CREATE TABLE IF NOT EXISTS funding_holds (
  hold_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  original_deposit_id TEXT NOT NULL REFERENCES funding_deposits(deposit_id) ON DELETE RESTRICT,
  campaign_id TEXT NOT NULL REFERENCES sponsor_campaigns(campaign_id) ON DELETE RESTRICT,
  asset TEXT NOT NULL,
  credits INTEGER NOT NULL CHECK (credits > 0),
  held_credits INTEGER NOT NULL CHECK (held_credits >= 0),
  unfunded_credits INTEGER NOT NULL CHECK (unfunded_credits >= 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'reversed')),
  external_reference TEXT,
  placed_at TEXT NOT NULL,
  place_receipt_hash TEXT NOT NULL UNIQUE,
  place_receipt_json TEXT NOT NULL,
  CHECK (held_credits + unfunded_credits = credits)
);

CREATE TABLE IF NOT EXISTS funding_hold_resolutions (
  resolution_id TEXT PRIMARY KEY,
  hold_id TEXT NOT NULL UNIQUE REFERENCES funding_holds(hold_id) ON DELETE RESTRICT,
  source_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('release', 'reverse')),
  reason TEXT NOT NULL,
  external_reference TEXT,
  occurred_at TEXT NOT NULL,
  receipt_hash TEXT NOT NULL UNIQUE,
  receipt_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS funding_reconciliations (
  statement_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES sponsor_campaigns(campaign_id) ON DELETE RESTRICT,
  asset TEXT NOT NULL,
  as_of TEXT NOT NULL,
  matched INTEGER NOT NULL CHECK (matched IN (0, 1)),
  statement_hash TEXT NOT NULL UNIQUE,
  report_hash TEXT NOT NULL UNIQUE,
  report_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL
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

CREATE INDEX IF NOT EXISTS idx_campaigns_pool
  ON sponsor_campaigns(pool_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_targeting
  ON sponsor_campaigns(targeting_mode);

CREATE INDEX IF NOT EXISTS idx_grants_expiry
  ON grants(expires_at);

CREATE INDEX IF NOT EXISTS idx_settlements_grant
  ON settlements(grant_id);

CREATE INDEX IF NOT EXISTS idx_funding_deposits_campaign
  ON funding_deposits(campaign_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_deposits_external_reference
  ON funding_deposits(source_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funding_reversals_campaign
  ON funding_reversals(campaign_id);

CREATE INDEX IF NOT EXISTS idx_funding_reversals_deposit
  ON funding_reversals(original_deposit_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_reversals_external_reference
  ON funding_reversals(source_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funding_holds_campaign
  ON funding_holds(campaign_id, status);

CREATE INDEX IF NOT EXISTS idx_funding_holds_deposit
  ON funding_holds(original_deposit_id, status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_holds_external_reference
  ON funding_holds(source_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_funding_hold_resolutions_external_reference
  ON funding_hold_resolutions(source_id, external_reference)
  WHERE external_reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_funding_reconciliations_campaign
  ON funding_reconciliations(campaign_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_funding_reconciliations_source
  ON funding_reconciliations(source_id, recorded_at);

INSERT OR IGNORE INTO meta(key, value)
  VALUES ('receipt_sequence', '0');

INSERT OR IGNORE INTO meta(key, value)
  VALUES ('receipt_head', '');
`);

    const grantColumns =
      this.#db
        .prepare(
          "PRAGMA table_info(grants)"
        )
        .all()
        .map(
          (row) =>
            String(row.name)
        );

    if (
      !grantColumns.includes(
        "campaign_json"
      )
    ) {
      this.#db.exec(
        "ALTER TABLE grants ADD COLUMN campaign_json TEXT"
      );
    }
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

  #campaignIdForPool(
    poolId
  ) {
    const row =
      this.#db
        .prepare(
          "SELECT campaign_id FROM sponsor_campaigns WHERE pool_id = ?"
        )
        .get(
          String(poolId)
        );

    return row
      ? String(
          row.campaign_id
        )
      : null;
  }

  #liabilityCredits(
    campaignId
  ) {
    const row =
      this.#db
        .prepare(
          "SELECT outstanding_credits FROM campaign_funding_liabilities WHERE campaign_id = ?"
        )
        .get(
          String(campaignId)
        );

    return row
      ? Number(
          row.outstanding_credits
        )
      : 0;
  }

  #setLiabilityCredits(
    campaignId,
    credits
  ) {
    assertNonNegativeInteger(
      credits,
      "liability credits"
    );

    this.#db
      .prepare(`
INSERT INTO campaign_funding_liabilities (
  campaign_id,
  outstanding_credits
) VALUES (?, ?)
ON CONFLICT(campaign_id)
DO UPDATE SET
  outstanding_credits =
    excluded.outstanding_credits
`)
      .run(
        String(campaignId),
        credits
      );
  }

  #holdDeficitCredits(
    campaignId
  ) {
    const row =
      this.#db
        .prepare(`
SELECT COALESCE(SUM(unfunded_credits), 0) AS credits
FROM funding_holds
WHERE campaign_id = ?
  AND status = 'active'
`)
        .get(
          String(campaignId)
        );

    return Number(
      row.credits
    );
  }

  #heldCredits(
    campaignId
  ) {
    const row =
      this.#db
        .prepare(`
SELECT COALESCE(SUM(held_credits), 0) AS credits
FROM funding_holds
WHERE campaign_id = ?
  AND status = 'active'
`)
        .get(
          String(campaignId)
        );

    return Number(
      row.credits
    );
  }

  #coverHoldDeficits(
    campaignId,
    credits
  ) {
    let remaining =
      credits;

    let covered = 0;

    const rows =
      this.#db
        .prepare(`
SELECT hold_id, held_credits, unfunded_credits
FROM funding_holds
WHERE campaign_id = ?
  AND status = 'active'
  AND unfunded_credits > 0
ORDER BY placed_at, hold_id
`)
        .all(
          String(campaignId)
        );

    for (
      const row
      of rows
    ) {
      if (remaining <= 0) {
        break;
      }

      const pay =
        Math.min(
          remaining,
          Number(
            row.unfunded_credits
          )
        );

      this.#db
        .prepare(`
UPDATE funding_holds
SET held_credits =
      held_credits + ?,
    unfunded_credits =
      unfunded_credits - ?
WHERE hold_id = ?
  AND status = 'active'
`)
        .run(
          pay,
          pay,
          String(
            row.hold_id
          )
        );

      remaining -= pay;
      covered += pay;
    }

    return Object.freeze({
      covered,
      remaining,
      outstandingHoldCredits:
        this.#holdDeficitCredits(
          campaignId
        )
    });
  }

  #creditPool(
    poolId,
    credits
  ) {
    assertNonNegativeInteger(
      credits,
      "credits"
    );

    const campaignId =
      this.#campaignIdForPool(
        poolId
      );

    if (!campaignId) {
      if (credits > 0) {
        this.#db
          .prepare(
            "UPDATE sponsor_pools SET available_credits = available_credits + ? WHERE id = ?"
          )
          .run(
            credits,
            String(poolId)
          );
      }

      return Object.freeze({
        availableAdded:
          credits,
        liabilityPaid: 0,
        holdCoverageAdded: 0,
        outstandingLiabilityCredits:
          0,
        outstandingHoldCredits:
          0
      });
    }

    const liability =
      this.#liabilityCredits(
        campaignId
      );

    const liabilityPaid =
      Math.min(
        credits,
        liability
      );

    this.#setLiabilityCredits(
      campaignId,
      liability -
        liabilityPaid
    );

    const afterLiability =
      credits -
      liabilityPaid;

    const holdCoverage =
      this.#coverHoldDeficits(
        campaignId,
        afterLiability
      );

    const availableAdded =
      holdCoverage.remaining;

    if (availableAdded > 0) {
      this.#db
        .prepare(
          "UPDATE sponsor_pools SET available_credits = available_credits + ? WHERE id = ?"
        )
        .run(
          availableAdded,
          String(poolId)
        );
    }

    return Object.freeze({
      availableAdded,
      liabilityPaid,
      holdCoverageAdded:
        holdCoverage.covered,
      outstandingLiabilityCredits:
        liability -
        liabilityPaid,
      outstandingHoldCredits:
        holdCoverage
          .outstandingHoldCredits
    });
  }

  #releaseGrantRow(row) {
    this.#db
      .prepare(`
UPDATE sponsor_pools
SET reserved_credits =
      reserved_credits - ?
WHERE id = ?
`)
      .run(
        row.compute_units,
        row.pool_id
      );

    this.#creditPool(
      row.pool_id,
      Number(
        row.compute_units
      )
    );

    this.#db
      .prepare(
        "DELETE FROM grants WHERE grant_id = ?"
      )
      .run(row.grant_id);
  }

  #campaignRow(
    campaignId
  ) {
    return this.#db
      .prepare(
        "SELECT * FROM sponsor_campaigns WHERE campaign_id = ?"
      )
      .get(
        String(campaignId)
      );
  }

  #campaignForPool(
    poolId
  ) {
    const row =
      this.#db
        .prepare(
          "SELECT * FROM sponsor_campaigns WHERE pool_id = ?"
        )
        .get(
          String(poolId)
        );

    if (!row) {
      return null;
    }

    return validateSponsorCampaign({
      campaignId:
        row.campaign_id,
      sponsorDisclosure:
        row.sponsor_disclosure,
      capabilityType:
        row.capability_type,
      benefitDescription:
        row.benefit_description,
      disclosureLabel:
        row.disclosure_label,
      targetingMode:
        row.targeting_mode,
      budgetCredits:
        Number(
          row.budget_credits
        ),
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
            ),
      priority:
        Number(row.priority),
      experience:
        JSON.parse(
          row.experience_json
        )
    });
  }

  #mintGrant(
    row,
    request,
    issuedAt,
    expiresAt,
    campaign = null
  ) {
    const metadata =
      campaign
        ? campaignFundingMetadata(
            campaign
          )
        : null;

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
          request.computeRequested,
        sponsorDisclosure:
          String(
            row.sponsor_disclosure
          ),
        campaign:
          metadata,
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
  expires_at,
  campaign_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
      .run(
        grant.grantId,
        grant.poolId,
        grant.reservationId,
        grant.taskId,
        grant.taskClass,
        grant.privacy,
        grant.computeUnits,
        grant.sponsorDisclosure,
        grant.issuedAt,
        grant.expiresAt,
        metadata
          ? JSON.stringify(
              metadata
            )
          : null
      );

    return grant;
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

  createCampaign(campaign) {
    const normalized =
      validateSponsorCampaign(
        campaign
      );

    const poolId =
      `campaign:${normalized.campaignId}`;

    return this.#transaction(
      () => {
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
            poolId,
            normalized
              .sponsorDisclosure,
            normalized
              .budgetCredits,
            JSON.stringify(
              normalized
                .eligibleTaskClasses
            ),
            JSON.stringify(
              normalized
                .allowedPrivacyModes
            ),
            normalized
              .maxComputePerGrant
          );

        this.#db
          .prepare(`
INSERT INTO sponsor_campaigns (
  campaign_id,
  pool_id,
  sponsor_disclosure,
  capability_type,
  benefit_description,
  disclosure_label,
  targeting_mode,
  budget_credits,
  eligible_task_classes,
  allowed_privacy_modes,
  max_compute_per_grant,
  priority,
  experience_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
          .run(
            normalized.campaignId,
            poolId,
            normalized
              .sponsorDisclosure,
            normalized
              .capabilityType,
            normalized
              .benefitDescription,
            normalized
              .disclosureLabel,
            normalized
              .targetingMode,
            normalized
              .budgetCredits,
            JSON.stringify(
              normalized
                .eligibleTaskClasses
            ),
            JSON.stringify(
              normalized
                .allowedPrivacyModes
            ),
            normalized
              .maxComputePerGrant,
            normalized.priority,
            JSON.stringify(
              normalized.experience
            )
          );

        this.#setLiabilityCredits(
          normalized.campaignId,
          0
        );

        return this.campaignSnapshot(
          normalized.campaignId
        );
      }
    );
  }

  campaignSnapshot(
    campaignId
  ) {
    const row =
      this.#campaignRow(
        campaignId
      );

    if (!row) {
      return null;
    }

    const campaign =
      this.#campaignForPool(
        row.pool_id
      );

    return Object.freeze({
      ...publicCampaign(
        campaign
      ),
      schema:
        "sponsorrail.sqlite-campaign.v0.12",
      budgetCredits:
        campaign.budgetCredits,
      eligibleTaskClasses:
        campaign
          .eligibleTaskClasses,
      allowedPrivacyModes:
        campaign
          .allowedPrivacyModes,
      maxComputePerGrant:
        campaign
          .maxComputePerGrant,
      pool:
        this.poolSnapshot(
          row.pool_id
        )
    });
  }

  listCampaigns() {
    return Object.freeze(
      this.#db
        .prepare(
          "SELECT campaign_id FROM sponsor_campaigns ORDER BY priority DESC, campaign_id"
        )
        .all()
        .map(
          (row) =>
            this.campaignSnapshot(
              row.campaign_id
            )
        )
    );
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

    const campaign =
      this.#campaignForPool(
        row.id
      );

    const heldCredits =
      campaign
        ? this.#heldCredits(
            campaign.campaignId
          )
        : 0;

    return Object.freeze({
      schema:
        "sponsorrail.sqlite-pool.v0.16",
      id:
        String(row.id),
      sponsorDisclosure:
        String(
          row.sponsor_disclosure
        ),
      campaign:
        campaign
          ? campaignFundingMetadata(
              campaign
            )
          : null,
      policy:
        rowPolicy(row),
      availableCredits,
      reservedCredits,
      spentCredits,
      heldCredits,
      totalCredits:
        availableCredits +
        reservedCredits +
        spentCredits +
        heldCredits
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

  matchCampaigns(
    task,
    preferences = {}
  ) {
    if (
      task?.allowSponsorship ===
      false
    ) {
      return Object.freeze([]);
    }

    const request =
      sanitizeFundingRequest(
        task
      );

    const normalized =
      normalizeCampaignPreferences(
        preferences
      );

    const allowedCapabilities =
      new Set(
        normalized
          .allowedCapabilityTypes
      );

    const blocked =
      new Set(
        normalized
          .blockedCampaignIds
      );

    const rows =
      this.#db
        .prepare(`
SELECT
  c.*,
  p.available_credits,
  p.reserved_credits,
  p.spent_credits
FROM sponsor_campaigns c
JOIN sponsor_pools p
  ON p.id = c.pool_id
LEFT JOIN campaign_funding_liabilities l
  ON l.campaign_id = c.campaign_id
WHERE COALESCE(l.outstanding_credits, 0) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM funding_holds h
    WHERE h.campaign_id = c.campaign_id
      AND h.status = 'active'
      AND h.unfunded_credits > 0
  )
ORDER BY c.priority DESC, c.campaign_id
`)
        .all();

    const matches = [];

    for (const row of rows) {
      if (
        blocked.has(
          String(
            row.campaign_id
          )
        )
      ) {
        continue;
      }

      if (
        !allowedCapabilities
          .has("*") &&
        !allowedCapabilities
          .has(
            String(
              row.capability_type
            )
          )
      ) {
        continue;
      }

      if (
        row.targeting_mode ===
          "contextual" &&
        normalized
          .allowContextual !==
          true
      ) {
        continue;
      }

      const policy =
        {
          eligibleTaskClasses:
            JSON.parse(
              row
                .eligible_task_classes
            ),
          allowedPrivacyModes:
            JSON.parse(
              row
                .allowed_privacy_modes
            ),
          maxComputePerGrant:
            row.max_compute_per_grant ===
              null
              ? null
              : Number(
                  row
                    .max_compute_per_grant
                )
        };

      if (
        !evaluatePolicy(
          request,
          policy
        ).eligible
      ) {
        continue;
      }

      if (
        Number(
          row.available_credits
        ) <
        request.computeRequested
      ) {
        continue;
      }

      const campaign =
        this.#campaignForPool(
          row.pool_id
        );

      matches.push(
        Object.freeze({
          campaign:
            publicCampaign(
              campaign
            ),
          poolId:
            String(
              row.pool_id
            ),
          availableCredits:
            Number(
              row.available_credits
            )
        })
      );
    }

    return Object.freeze(
      matches
    );
  }

  authorize(task) {
    if (
      this.#campaignPreferences
    ) {
      return this.authorizeCampaign(
        task,
        this.#campaignPreferences
      );
    }

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
            .prepare(`
SELECT p.*
FROM sponsor_pools p
LEFT JOIN sponsor_campaigns c
  ON c.pool_id = p.id
WHERE c.pool_id IS NULL
ORDER BY p.id
`)
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

          return this.#mintGrant(
            row,
            request,
            issuedAt,
            expiresAt
          );
        }

        return Object.freeze({
          funded: false,
          reason:
            lastReason
        });
      }
    );
  }

  depositCampaign(
    receipt,
    fundingSourceRegistry
  ) {
    if (
      !verifyFundingDeposit(
        receipt,
        fundingSourceRegistry
      )
    ) {
      throw new Error(
        "funding deposit verification failed"
      );
    }

    const receiptJson =
      canonicalJson(
        receipt
      );

    const receiptHash =
      createHash("sha256")
        .update(
          receiptJson
        )
        .digest("hex");

    return this.#transaction(
      () => {
        const existing =
          this.#db
            .prepare(
              "SELECT * FROM funding_deposits WHERE deposit_id = ?"
            )
            .get(
              String(
                receipt.depositId
              )
            );

        if (existing) {
          if (
            String(
              existing.receipt_hash
            ) !==
            receiptHash
          ) {
            throw new Error(
              "funding deposit idempotency conflict"
            );
          }

          return Object.freeze({
            applied: false,
            idempotent: true,
            depositId:
              String(
                existing.deposit_id
              ),
            sourceId:
              String(
                existing.source_id
              ),
            campaignId:
              String(
                existing.campaign_id
              ),
            credits:
              Number(
                existing.credits
              ),
            receiptHash:
              String(
                existing.receipt_hash
              )
          });
        }

        const campaignRow =
          this.#campaignRow(
            receipt.campaignId
          );

        if (!campaignRow) {
          throw new Error(
            "unknown campaign"
          );
        }

        const duplicateReference =
          receipt.externalReference ===
            null
            ? null
            : this.#db
                .prepare(
                  "SELECT * FROM funding_deposits WHERE source_id = ? AND external_reference = ?"
                )
                .get(
                  String(
                    receipt.sourceId
                  ),
                  String(
                    receipt.externalReference
                  )
                );

        if (duplicateReference) {
          throw new Error(
            "funding external reference already deposited"
          );
        }

        const allocation =
          this.#creditPool(
            campaignRow.pool_id,
            receipt.credits
          );

        this.#db
          .prepare(`
INSERT INTO funding_deposits (
  deposit_id,
  source_id,
  campaign_id,
  asset,
  credits,
  external_reference,
  occurred_at,
  receipt_hash,
  receipt_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
          .run(
            String(
              receipt.depositId
            ),
            String(
              receipt.sourceId
            ),
            String(
              receipt.campaignId
            ),
            String(
              receipt.asset
            ),
            receipt.credits,
            receipt.externalReference ===
              null
              ? null
              : String(
                  receipt.externalReference
                ),
            String(
              receipt.occurredAt
            ),
            receiptHash,
            receiptJson
          );

        return Object.freeze({
          applied: true,
          idempotent: false,
          depositId:
            String(
              receipt.depositId
            ),
          sourceId:
            String(
              receipt.sourceId
            ),
          campaignId:
            String(
              receipt.campaignId
            ),
          credits:
            receipt.credits,
          availableAdded:
            allocation
              .availableAdded,
          liabilityPaid:
            allocation
              .liabilityPaid,
          holdCoverageAdded:
            allocation
              .holdCoverageAdded,
          outstandingLiabilityCredits:
            allocation
              .outstandingLiabilityCredits,
          outstandingHoldCredits:
            allocation
              .outstandingHoldCredits,
          receiptHash
        });
      }
    );
  }

  placeFundingHold(
    receipt,
    fundingSourceRegistry
  ) {
    if (
      !verifyFundingHold(
        receipt,
        fundingSourceRegistry
      )
    ) {
      throw new Error(
        "funding hold verification failed"
      );
    }

    const receiptJson =
      canonicalJson(
        receipt
      );

    const receiptHash =
      createHash("sha256")
        .update(
          receiptJson
        )
        .digest("hex");

    return this.#transaction(
      () => {
        const existing =
          this.#db
            .prepare(
              "SELECT * FROM funding_holds WHERE hold_id = ?"
            )
            .get(
              String(
                receipt.holdId
              )
            );

        if (existing) {
          if (
            String(
              existing
                .place_receipt_hash
            ) !==
            receiptHash
          ) {
            throw new Error(
              "funding hold idempotency conflict"
            );
          }

          return Object.freeze({
            applied: false,
            idempotent: true,
            holdId:
              String(
                existing.hold_id
              ),
            status:
              String(
                existing.status
              ),
            credits:
              Number(
                existing.credits
              ),
            heldCredits:
              Number(
                existing.held_credits
              ),
            unfundedCredits:
              Number(
                existing.unfunded_credits
              ),
            outstandingHoldCredits:
              this.#holdDeficitCredits(
                existing.campaign_id
              )
          });
        }

        const deposit =
          this.#db
            .prepare(
              "SELECT * FROM funding_deposits WHERE deposit_id = ?"
            )
            .get(
              String(
                receipt
                  .originalDepositId
              )
            );

        if (!deposit) {
          throw new Error(
            "unknown original funding deposit"
          );
        }

        if (
          String(
            deposit.source_id
          ) !==
            String(
              receipt.sourceId
            ) ||
          String(
            deposit.campaign_id
          ) !==
            String(
              receipt.campaignId
            ) ||
          String(
            deposit.asset
          ) !==
            String(
              receipt.asset
            )
        ) {
          throw new Error(
            "funding hold does not match original deposit"
          );
        }

        const reversed =
          this.#db
            .prepare(`
SELECT COALESCE(SUM(credits), 0) AS credits
FROM funding_reversals
WHERE original_deposit_id = ?
`)
            .get(
              String(
                receipt
                  .originalDepositId
              )
            );

        const active =
          this.#db
            .prepare(`
SELECT COALESCE(SUM(credits), 0) AS credits
FROM funding_holds
WHERE original_deposit_id = ?
  AND status = 'active'
`)
            .get(
              String(
                receipt
                  .originalDepositId
              )
            );

        if (
          Number(
            reversed.credits
          ) +
            Number(
              active.credits
            ) +
            receipt.credits >
          Number(
            deposit.credits
          )
        ) {
          throw new Error(
            "funding hold exceeds remaining deposit credits"
          );
        }

        const duplicateReference =
          receipt.externalReference ===
            null
            ? null
            : this.#db
                .prepare(
                  "SELECT * FROM funding_holds WHERE source_id = ? AND external_reference = ?"
                )
                .get(
                  String(
                    receipt.sourceId
                  ),
                  String(
                    receipt
                      .externalReference
                  )
                );

        if (duplicateReference) {
          throw new Error(
            "funding hold external reference already applied"
          );
        }

        const campaignRow =
          this.#campaignRow(
            receipt.campaignId
          );

        if (!campaignRow) {
          throw new Error(
            "unknown campaign"
          );
        }

        const pool =
          this.#poolRow(
            campaignRow.pool_id
          );

        const heldCredits =
          Math.min(
            Number(
              pool.available_credits
            ),
            receipt.credits
          );

        const unfundedCredits =
          receipt.credits -
          heldCredits;

        if (heldCredits > 0) {
          this.#db
            .prepare(
              "UPDATE sponsor_pools SET available_credits = available_credits - ? WHERE id = ?"
            )
            .run(
              heldCredits,
              campaignRow.pool_id
            );
        }

        this.#db
          .prepare(`
INSERT INTO funding_holds (
  hold_id,
  source_id,
  original_deposit_id,
  campaign_id,
  asset,
  credits,
  held_credits,
  unfunded_credits,
  reason,
  status,
  external_reference,
  placed_at,
  place_receipt_hash,
  place_receipt_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)
`)
          .run(
            String(
              receipt.holdId
            ),
            String(
              receipt.sourceId
            ),
            String(
              receipt
                .originalDepositId
            ),
            String(
              receipt.campaignId
            ),
            String(
              receipt.asset
            ),
            receipt.credits,
            heldCredits,
            unfundedCredits,
            String(
              receipt.reason
            ),
            receipt.externalReference ===
              null
              ? null
              : String(
                  receipt
                    .externalReference
                ),
            String(
              receipt.occurredAt
            ),
            receiptHash,
            receiptJson
          );

        return Object.freeze({
          applied: true,
          idempotent: false,
          holdId:
            String(
              receipt.holdId
            ),
          status: "active",
          credits:
            receipt.credits,
          heldCredits,
          unfundedCredits,
          outstandingHoldCredits:
            this.#holdDeficitCredits(
              receipt.campaignId
            ),
          receiptHash
        });
      }
    );
  }

  findFundingHoldByExternalReference(
    sourceId,
    externalReference
  ) {
    const row =
      this.#db
        .prepare(
          "SELECT * FROM funding_holds WHERE source_id = ? AND external_reference = ?"
        )
        .get(
          String(sourceId),
          String(
            externalReference
          )
        );

    if (!row) {
      return null;
    }

    return Object.freeze({
      holdId:
        String(
          row.hold_id
        ),
      sourceId:
        String(
          row.source_id
        ),
      originalDepositId:
        String(
          row.original_deposit_id
        ),
      campaignId:
        String(
          row.campaign_id
        ),
      asset:
        String(
          row.asset
        ),
      credits:
        Number(
          row.credits
        ),
      heldCredits:
        Number(
          row.held_credits
        ),
      unfundedCredits:
        Number(
          row.unfunded_credits
        ),
      reason:
        String(
          row.reason
        ),
      status:
        String(
          row.status
        ),
      externalReference:
        row.external_reference ??
        null,
      placedAt:
        String(
          row.placed_at
        ),
      receiptHash:
        String(
          row.place_receipt_hash
        ),
      receipt:
        JSON.parse(
          row.place_receipt_json
        )
    });
  }

  resolveFundingHold(
    receipt,
    fundingSourceRegistry
  ) {
    if (
      !verifyFundingHoldResolution(
        receipt,
        fundingSourceRegistry
      )
    ) {
      throw new Error(
        "funding hold resolution verification failed"
      );
    }

    const receiptJson =
      canonicalJson(
        receipt
      );

    const receiptHash =
      createHash("sha256")
        .update(
          receiptJson
        )
        .digest("hex");

    return this.#transaction(
      () => {
        const existingResolution =
          this.#db
            .prepare(
              "SELECT * FROM funding_hold_resolutions WHERE resolution_id = ?"
            )
            .get(
              String(
                receipt
                  .resolutionId
              )
            );

        if (existingResolution) {
          if (
            String(
              existingResolution
                .receipt_hash
            ) !==
            receiptHash
          ) {
            throw new Error(
              "funding hold resolution idempotency conflict"
            );
          }

          const hold =
            this.#db
              .prepare(
                "SELECT * FROM funding_holds WHERE hold_id = ?"
              )
              .get(
                String(
                  existingResolution
                    .hold_id
                )
              );

          return Object.freeze({
            applied: false,
            idempotent: true,
            resolutionId:
              String(
                existingResolution
                  .resolution_id
              ),
            holdId:
              String(
                existingResolution
                  .hold_id
              ),
            outcome:
              String(
                existingResolution
                  .outcome
              ),
            status:
              String(
                hold.status
              ),
            outstandingLiabilityCredits:
              this.#liabilityCredits(
                hold.campaign_id
              ),
            outstandingHoldCredits:
              this.#holdDeficitCredits(
                hold.campaign_id
              )
          });
        }

        const hold =
          this.#db
            .prepare(
              "SELECT * FROM funding_holds WHERE hold_id = ?"
            )
            .get(
              String(
                receipt.holdId
              )
            );

        if (!hold) {
          throw new Error(
            "unknown funding hold"
          );
        }

        if (
          hold.status !==
            "active"
        ) {
          throw new Error(
            "funding hold is already resolved"
          );
        }

        if (
          String(
            hold.source_id
          ) !==
            String(
              receipt.sourceId
            ) ||
          String(
            hold
              .original_deposit_id
          ) !==
            String(
              receipt
                .originalDepositId
            ) ||
          String(
            hold.campaign_id
          ) !==
            String(
              receipt.campaignId
            ) ||
          String(
            hold.asset
          ) !==
            String(
              receipt.asset
            )
        ) {
          throw new Error(
            "funding hold resolution does not match hold"
          );
        }

        const byHold =
          this.#db
            .prepare(
              "SELECT * FROM funding_hold_resolutions WHERE hold_id = ?"
            )
            .get(
              String(
                receipt.holdId
              )
            );

        if (byHold) {
          throw new Error(
            "funding hold already has a resolution"
          );
        }

        const duplicateReference =
          receipt.externalReference ===
            null
            ? null
            : this.#db
                .prepare(
                  "SELECT * FROM funding_hold_resolutions WHERE source_id = ? AND external_reference = ?"
                )
                .get(
                  String(
                    receipt.sourceId
                  ),
                  String(
                    receipt
                      .externalReference
                  )
                );

        if (duplicateReference) {
          throw new Error(
            "funding hold resolution external reference already applied"
          );
        }

        this.#db
          .prepare(`
INSERT INTO funding_hold_resolutions (
  resolution_id,
  hold_id,
  source_id,
  outcome,
  reason,
  external_reference,
  occurred_at,
  receipt_hash,
  receipt_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
          .run(
            String(
              receipt
                .resolutionId
            ),
            String(
              receipt.holdId
            ),
            String(
              receipt.sourceId
            ),
            String(
              receipt.outcome
            ),
            String(
              receipt.reason
            ),
            receipt.externalReference ===
              null
              ? null
              : String(
                  receipt
                    .externalReference
                ),
            String(
              receipt.occurredAt
            ),
            receiptHash,
            receiptJson
          );

        if (
          receipt.outcome ===
            "release"
        ) {
          this.#db
            .prepare(
              "UPDATE funding_holds SET status = 'released' WHERE hold_id = ?"
            )
            .run(
              String(
                receipt.holdId
              )
            );

          const campaignRow =
            this.#campaignRow(
              hold.campaign_id
            );

          const allocation =
            this.#creditPool(
              campaignRow.pool_id,
              Number(
                hold.held_credits
              )
            );

          return Object.freeze({
            applied: true,
            idempotent: false,
            resolutionId:
              String(
                receipt
                  .resolutionId
              ),
            holdId:
              String(
                receipt.holdId
              ),
            outcome: "release",
            releasedHeldCredits:
              Number(
                hold.held_credits
              ),
            clearedUnfundedCredits:
              Number(
                hold
                  .unfunded_credits
              ),
            availableAdded:
              allocation
                .availableAdded,
            liabilityPaid:
              allocation
                .liabilityPaid,
            holdCoverageAdded:
              allocation
                .holdCoverageAdded,
            outstandingLiabilityCredits:
              allocation
                .outstandingLiabilityCredits,
            outstandingHoldCredits:
              allocation
                .outstandingHoldCredits,
            receiptHash
          });
        }

        const reversalId =
          `hold-resolution:${receipt.resolutionId}`;

        const reversalReference =
          receipt.externalReference ===
            null
            ? null
            : String(
                receipt
                  .externalReference
              );

        if (
          reversalReference !==
            null
        ) {
          const existingReversalReference =
            this.#db
              .prepare(
                "SELECT reversal_id FROM funding_reversals WHERE source_id = ? AND external_reference = ?"
              )
              .get(
                String(
                  receipt.sourceId
                ),
                reversalReference
              );

          if (
            existingReversalReference
          ) {
            throw new Error(
              "funding reversal external reference already applied"
            );
          }
        }

        this.#db
          .prepare(
            "UPDATE funding_holds SET status = 'reversed' WHERE hold_id = ?"
          )
          .run(
            String(
              receipt.holdId
            )
          );

        const outstanding =
          this.#liabilityCredits(
            hold.campaign_id
          ) +
          Number(
            hold.unfunded_credits
          );

        this.#setLiabilityCredits(
          hold.campaign_id,
          outstanding
        );

        this.#db
          .prepare(`
INSERT INTO funding_reversals (
  reversal_id,
  source_id,
  original_deposit_id,
  campaign_id,
  asset,
  credits,
  reason,
  external_reference,
  occurred_at,
  receipt_hash,
  receipt_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
          .run(
            reversalId,
            String(
              receipt.sourceId
            ),
            String(
              hold
                .original_deposit_id
            ),
            String(
              hold.campaign_id
            ),
            String(
              hold.asset
            ),
            Number(
              hold.credits
            ),
            "dispute_loss",
            reversalReference,
            String(
              receipt.occurredAt
            ),
            receiptHash,
            receiptJson
          );

        return Object.freeze({
          applied: true,
          idempotent: false,
          resolutionId:
            String(
              receipt
                .resolutionId
            ),
          holdId:
            String(
              receipt.holdId
            ),
          outcome: "reverse",
          reversalId,
          credits:
            Number(
              hold.credits
            ),
          consumedHeldCredits:
            Number(
              hold.held_credits
            ),
          liabilityAdded:
            Number(
              hold.unfunded_credits
            ),
          outstandingLiabilityCredits:
            outstanding,
          outstandingHoldCredits:
            this.#holdDeficitCredits(
              hold.campaign_id
            ),
          receiptHash
        });
      }
    );
  }

  listFundingHolds({
    campaignId = null,
    sourceId = null,
    status = null
  } = {}) {
    const clauses = [];
    const params = [];

    if (campaignId !== null) {
      clauses.push(
        "campaign_id = ?"
      );
      params.push(
        String(campaignId)
      );
    }

    if (sourceId !== null) {
      clauses.push(
        "source_id = ?"
      );
      params.push(
        String(sourceId)
      );
    }

    if (status !== null) {
      clauses.push(
        "status = ?"
      );
      params.push(
        String(status)
      );
    }

    const where =
      clauses.length > 0
        ? ` WHERE ${clauses.join(" AND ")}`
        : "";

    return Object.freeze(
      this.#db
        .prepare(
          `SELECT * FROM funding_holds${where} ORDER BY placed_at, hold_id`
        )
        .all(...params)
        .map(
          (row) =>
            Object.freeze({
              holdId:
                String(
                  row.hold_id
                ),
              sourceId:
                String(
                  row.source_id
                ),
              originalDepositId:
                String(
                  row
                    .original_deposit_id
                ),
              campaignId:
                String(
                  row.campaign_id
                ),
              asset:
                String(
                  row.asset
                ),
              credits:
                Number(
                  row.credits
                ),
              heldCredits:
                Number(
                  row.held_credits
                ),
              unfundedCredits:
                Number(
                  row
                    .unfunded_credits
                ),
              reason:
                String(
                  row.reason
                ),
              status:
                String(
                  row.status
                ),
              externalReference:
                row.external_reference ??
                null,
              placedAt:
                String(
                  row.placed_at
                ),
              receiptHash:
                String(
                  row
                    .place_receipt_hash
                )
            })
        )
    );
  }

  findFundingDepositByExternalReference(
    sourceId,
    externalReference
  ) {
    const row =
      this.#db
        .prepare(
          "SELECT * FROM funding_deposits WHERE source_id = ? AND external_reference = ?"
        )
        .get(
          String(sourceId),
          String(
            externalReference
          )
        );

    if (!row) {
      return null;
    }

    return Object.freeze({
      depositId:
        String(
          row.deposit_id
        ),
      sourceId:
        String(
          row.source_id
        ),
      campaignId:
        String(
          row.campaign_id
        ),
      asset:
        String(
          row.asset
        ),
      credits:
        Number(
          row.credits
        ),
      externalReference:
        row.external_reference ??
        null,
      occurredAt:
        String(
          row.occurred_at
        ),
      receiptHash:
        String(
          row.receipt_hash
        ),
      receipt:
        JSON.parse(
          row.receipt_json
        )
    });
  }

  applyFundingReversal(
    receipt,
    fundingSourceRegistry
  ) {
    if (
      !verifyFundingReversal(
        receipt,
        fundingSourceRegistry
      )
    ) {
      throw new Error(
        "funding reversal verification failed"
      );
    }

    const receiptJson =
      canonicalJson(
        receipt
      );

    const receiptHash =
      createHash("sha256")
        .update(
          receiptJson
        )
        .digest("hex");

    return this.#transaction(
      () => {
        const existing =
          this.#db
            .prepare(
              "SELECT * FROM funding_reversals WHERE reversal_id = ?"
            )
            .get(
              String(
                receipt.reversalId
              )
            );

        if (existing) {
          if (
            String(
              existing.receipt_hash
            ) !==
            receiptHash
          ) {
            throw new Error(
              "funding reversal idempotency conflict"
            );
          }

          return Object.freeze({
            applied: false,
            idempotent: true,
            reversalId:
              String(
                existing.reversal_id
              ),
            originalDepositId:
              String(
                existing.original_deposit_id
              ),
            campaignId:
              String(
                existing.campaign_id
              ),
            credits:
              Number(
                existing.credits
              ),
            receiptHash:
              String(
                existing.receipt_hash
              ),
            outstandingLiabilityCredits:
              this.#liabilityCredits(
                existing.campaign_id
              )
          });
        }

        const deposit =
          this.#db
            .prepare(
              "SELECT * FROM funding_deposits WHERE deposit_id = ?"
            )
            .get(
              String(
                receipt.originalDepositId
              )
            );

        if (!deposit) {
          throw new Error(
            "unknown original funding deposit"
          );
        }

        if (
          String(
            deposit.source_id
          ) !==
            String(
              receipt.sourceId
            ) ||
          String(
            deposit.campaign_id
          ) !==
            String(
              receipt.campaignId
            ) ||
          String(
            deposit.asset
          ) !==
            String(
              receipt.asset
            )
        ) {
          throw new Error(
            "funding reversal does not match original deposit"
          );
        }

        const prior =
          this.#db
            .prepare(`
SELECT COALESCE(SUM(credits), 0) AS reversed
FROM funding_reversals
WHERE original_deposit_id = ?
`)
            .get(
              String(
                receipt.originalDepositId
              )
            );

        const priorReversed =
          Number(
            prior.reversed
          );

        const activeHolds =
          this.#db
            .prepare(`
SELECT COALESCE(SUM(credits), 0) AS held
FROM funding_holds
WHERE original_deposit_id = ?
  AND status = 'active'
`)
            .get(
              String(
                receipt.originalDepositId
              )
            );

        const activeHeldCredits =
          Number(
            activeHolds.held
          );

        if (
          priorReversed +
            activeHeldCredits +
            receipt.credits >
          Number(
            deposit.credits
          )
        ) {
          throw new Error(
            "funding reversal exceeds unheld deposit credits"
          );
        }

        const duplicateReference =
          receipt.externalReference ===
            null
            ? null
            : this.#db
                .prepare(
                  "SELECT * FROM funding_reversals WHERE source_id = ? AND external_reference = ?"
                )
                .get(
                  String(
                    receipt.sourceId
                  ),
                  String(
                    receipt.externalReference
                  )
                );

        if (duplicateReference) {
          throw new Error(
            "funding reversal external reference already applied"
          );
        }

        const campaignRow =
          this.#campaignRow(
            receipt.campaignId
          );

        if (!campaignRow) {
          throw new Error(
            "unknown campaign"
          );
        }

        const pool =
          this.#poolRow(
            campaignRow.pool_id
          );

        const available =
          Number(
            pool.available_credits
          );

        const availableDebited =
          Math.min(
            available,
            receipt.credits
          );

        const liabilityAdded =
          receipt.credits -
          availableDebited;

        if (
          availableDebited > 0
        ) {
          this.#db
            .prepare(
              "UPDATE sponsor_pools SET available_credits = available_credits - ? WHERE id = ?"
            )
            .run(
              availableDebited,
              campaignRow.pool_id
            );
        }

        const outstanding =
          this.#liabilityCredits(
            receipt.campaignId
          ) +
          liabilityAdded;

        this.#setLiabilityCredits(
          receipt.campaignId,
          outstanding
        );

        this.#db
          .prepare(`
INSERT INTO funding_reversals (
  reversal_id,
  source_id,
  original_deposit_id,
  campaign_id,
  asset,
  credits,
  reason,
  external_reference,
  occurred_at,
  receipt_hash,
  receipt_json
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
          .run(
            String(
              receipt.reversalId
            ),
            String(
              receipt.sourceId
            ),
            String(
              receipt.originalDepositId
            ),
            String(
              receipt.campaignId
            ),
            String(
              receipt.asset
            ),
            receipt.credits,
            String(
              receipt.reason
            ),
            receipt.externalReference ===
              null
              ? null
              : String(
                  receipt.externalReference
                ),
            String(
              receipt.occurredAt
            ),
            receiptHash,
            receiptJson
          );

        return Object.freeze({
          applied: true,
          idempotent: false,
          reversalId:
            String(
              receipt.reversalId
            ),
          originalDepositId:
            String(
              receipt.originalDepositId
            ),
          campaignId:
            String(
              receipt.campaignId
            ),
          credits:
            receipt.credits,
          reason:
            String(
              receipt.reason
            ),
          availableDebited,
          liabilityAdded,
          outstandingLiabilityCredits:
            outstanding,
          receiptHash
        });
      }
    );
  }

  listFundingReversals({
    campaignId = null,
    sourceId = null,
    originalDepositId = null
  } = {}) {
    const clauses = [];
    const params = [];

    if (campaignId !== null) {
      clauses.push(
        "campaign_id = ?"
      );
      params.push(
        String(campaignId)
      );
    }

    if (sourceId !== null) {
      clauses.push(
        "source_id = ?"
      );
      params.push(
        String(sourceId)
      );
    }

    if (
      originalDepositId !==
      null
    ) {
      clauses.push(
        "original_deposit_id = ?"
      );
      params.push(
        String(
          originalDepositId
        )
      );
    }

    const where =
      clauses.length > 0
        ? ` WHERE ${clauses.join(" AND ")}`
        : "";

    return Object.freeze(
      this.#db
        .prepare(
          `SELECT * FROM funding_reversals${where} ORDER BY occurred_at, reversal_id`
        )
        .all(...params)
        .map(
          (row) =>
            Object.freeze({
              reversalId:
                String(
                  row.reversal_id
                ),
              sourceId:
                String(
                  row.source_id
                ),
              originalDepositId:
                String(
                  row.original_deposit_id
                ),
              campaignId:
                String(
                  row.campaign_id
                ),
              asset:
                String(
                  row.asset
                ),
              credits:
                Number(
                  row.credits
                ),
              reason:
                String(
                  row.reason
                ),
              externalReference:
                row.external_reference ??
                null,
              occurredAt:
                String(
                  row.occurred_at
                ),
              receiptHash:
                String(
                  row.receipt_hash
                ),
              receipt:
                JSON.parse(
                  row.receipt_json
                )
            })
        )
    );
  }

  listFundingDeposits({
    campaignId = null,
    sourceId = null
  } = {}) {
    const clauses = [];
    const params = [];

    if (campaignId !== null) {
      clauses.push(
        "campaign_id = ?"
      );
      params.push(
        String(campaignId)
      );
    }

    if (sourceId !== null) {
      clauses.push(
        "source_id = ?"
      );
      params.push(
        String(sourceId)
      );
    }

    const where =
      clauses.length > 0
        ? ` WHERE ${clauses.join(" AND ")}`
        : "";

    return Object.freeze(
      this.#db
        .prepare(
          `SELECT * FROM funding_deposits${where} ORDER BY occurred_at, deposit_id`
        )
        .all(...params)
        .map(
          (row) =>
            Object.freeze({
              depositId:
                String(
                  row.deposit_id
                ),
              sourceId:
                String(
                  row.source_id
                ),
              campaignId:
                String(
                  row.campaign_id
                ),
              asset:
                String(
                  row.asset
                ),
              credits:
                Number(
                  row.credits
                ),
              externalReference:
                row.external_reference ??
                null,
              occurredAt:
                String(
                  row.occurred_at
                ),
              receiptHash:
                String(
                  row.receipt_hash
                ),
              receipt:
                JSON.parse(
                  row.receipt_json
                )
            })
        )
    );
  }

  fundingSnapshot(
    campaignId
  ) {
    const campaign =
      this.campaignSnapshot(
        campaignId
      );

    if (!campaign) {
      return null;
    }

    const deposits =
      this.#db
        .prepare(`
SELECT
  COUNT(*) AS deposit_count,
  COALESCE(SUM(credits), 0) AS verified_credits
FROM funding_deposits
WHERE campaign_id = ?
`)
        .get(
          String(
            campaignId
          )
        );

    const reversals =
      this.#db
        .prepare(`
SELECT
  COUNT(*) AS reversal_count,
  COALESCE(SUM(credits), 0) AS reversed_credits
FROM funding_reversals
WHERE campaign_id = ?
`)
        .get(
          String(
            campaignId
          )
        );

    const liability =
      this.#liabilityCredits(
        campaignId
      );

    const holds =
      this.#db
        .prepare(`
SELECT
  COUNT(*) AS active_hold_count,
  COALESCE(SUM(held_credits), 0) AS held_credits,
  COALESCE(SUM(unfunded_credits), 0) AS unfunded_credits
FROM funding_holds
WHERE campaign_id = ?
  AND status = 'active'
`)
        .get(
          String(
            campaignId
          )
        );

    return Object.freeze({
      schema:
        "sponsorrail.funding-snapshot.v0.16",
      campaignId:
        String(
          campaignId
        ),
      operatorSeedCredits:
        campaign.budgetCredits,
      verifiedDepositCount:
        Number(
          deposits.deposit_count
        ),
      verifiedDepositCredits:
        Number(
          deposits.verified_credits
        ),
      verifiedReversalCount:
        Number(
          reversals.reversal_count
        ),
      verifiedReversalCredits:
        Number(
          reversals.reversed_credits
        ),
      netVerifiedFundingCredits:
        Number(
          deposits.verified_credits
        ) -
        Number(
          reversals.reversed_credits
        ),
      outstandingLiabilityCredits:
        liability,
      activeHoldCount:
        Number(
          holds.active_hold_count
        ),
      activeHeldCredits:
        Number(
          holds.held_credits
        ),
      outstandingHoldCredits:
        Number(
          holds.unfunded_credits
        ),
      currentAvailableCredits:
        campaign.pool
          .availableCredits,
      currentReservedCredits:
        campaign.pool
          .reservedCredits,
      currentSpentCredits:
        campaign.pool
          .spentCredits
    });
  }

  auditCampaignFunding(
    campaignId
  ) {
    const snapshot =
      this.fundingSnapshot(
        campaignId
      );

    if (!snapshot) {
      return null;
    }

    const economicFundingCredits =
      snapshot.operatorSeedCredits +
      snapshot.verifiedDepositCredits -
      snapshot.verifiedReversalCredits;

    const bookCredits =
      snapshot.currentAvailableCredits +
      snapshot.currentReservedCredits +
      snapshot.currentSpentCredits +
      snapshot.activeHeldCredits;

    const liabilityAdjustedBookCredits =
      bookCredits -
      snapshot
        .outstandingLiabilityCredits;

    const balanceDelta =
      liabilityAdjustedBookCredits -
      economicFundingCredits;

    const exposures =
      this.#db
        .prepare(`
SELECT
  d.deposit_id,
  d.credits,
  COALESCE((
    SELECT SUM(r.credits)
    FROM funding_reversals r
    WHERE r.original_deposit_id =
      d.deposit_id
  ), 0) AS reversed_credits,
  COALESCE((
    SELECT SUM(h.credits)
    FROM funding_holds h
    WHERE h.original_deposit_id =
      d.deposit_id
      AND h.status = 'active'
  ), 0) AS active_hold_credits
FROM funding_deposits d
WHERE d.campaign_id = ?
ORDER BY d.deposit_id
`)
        .all(
          String(
            campaignId
          )
        )
        .map(
          (row) => {
            const depositCredits =
              Number(
                row.credits
              );

            const reversedCredits =
              Number(
                row.reversed_credits
              );

            const activeHoldCredits =
              Number(
                row.active_hold_credits
              );

            return Object.freeze({
              depositId:
                String(
                  row.deposit_id
                ),
              depositCredits,
              reversedCredits,
              activeHoldCredits,
              remainingCredits:
                depositCredits -
                reversedCredits -
                activeHoldCredits,
              valid:
                reversedCredits +
                  activeHoldCredits <=
                depositCredits
            });
          }
        );

    const violations =
      exposures.filter(
        (entry) =>
          !entry.valid
      );

    return Object.freeze({
      schema:
        "sponsorrail.funding-audit.v0.17",
      campaignId:
        String(
          campaignId
        ),
      economicFundingCredits,
      bookCredits,
      outstandingLiabilityCredits:
        snapshot
          .outstandingLiabilityCredits,
      liabilityAdjustedBookCredits,
      balanceDelta,
      exposureCount:
        exposures.length,
      exposureViolationCount:
        violations.length,
      exposures:
        Object.freeze(
          exposures
        ),
      healthy:
        balanceDelta === 0 &&
        violations.length === 0
    });
  }

  reconcileFundingStatement(
    statement,
    fundingSourceRegistry
  ) {
    if (
      !verifyFundingStatement(
        statement,
        fundingSourceRegistry
      )
    ) {
      throw new Error(
        "funding statement verification failed"
      );
    }

    if (
      !this.#campaignRow(
        statement.campaignId
      )
    ) {
      throw new Error(
        "unknown campaign"
      );
    }

    const statementJson =
      canonicalJson(
        statement
      );

    const statementHash =
      createHash("sha256")
        .update(
          statementJson
        )
        .digest("hex");

    const existing =
      this.#db
        .prepare(
          "SELECT * FROM funding_reconciliations WHERE statement_id = ?"
        )
        .get(
          String(
            statement.statementId
          )
        );

    if (existing) {
      if (
        String(
          existing
            .statement_hash
        ) !==
        statementHash
      ) {
        throw new Error(
          "funding statement idempotency conflict"
        );
      }

      return Object.freeze({
        ...JSON.parse(
          existing.report_json
        ),
        idempotent: true
      });
    }

    const asOf =
      String(
        statement.asOf
      );

    const deposits =
      this.#db
        .prepare(`
SELECT
  COUNT(*) AS count,
  COALESCE(SUM(credits), 0) AS credits
FROM funding_deposits
WHERE source_id = ?
  AND campaign_id = ?
  AND occurred_at <= ?
`)
        .get(
          String(
            statement.sourceId
          ),
          String(
            statement.campaignId
          ),
          asOf
        );

    const reversals =
      this.#db
        .prepare(`
SELECT
  COUNT(*) AS count,
  COALESCE(SUM(credits), 0) AS credits
FROM funding_reversals
WHERE source_id = ?
  AND campaign_id = ?
  AND occurred_at <= ?
`)
        .get(
          String(
            statement.sourceId
          ),
          String(
            statement.campaignId
          ),
          asOf
        );

    const holds =
      this.#db
        .prepare(`
SELECT
  COUNT(*) AS count,
  COALESCE(SUM(h.credits), 0) AS credits
FROM funding_holds h
WHERE h.source_id = ?
  AND h.campaign_id = ?
  AND h.placed_at <= ?
  AND NOT EXISTS (
    SELECT 1
    FROM funding_hold_resolutions r
    WHERE r.hold_id = h.hold_id
      AND r.occurred_at <= ?
  )
`)
        .get(
          String(
            statement.sourceId
          ),
          String(
            statement.campaignId
          ),
          asOf,
          asOf
        );

    const local =
      Object.freeze({
        depositedCredits:
          Number(
            deposits.credits
          ),
        reversedCredits:
          Number(
            reversals.credits
          ),
        activeHoldCredits:
          Number(
            holds.credits
          ),
        depositCount:
          Number(
            deposits.count
          ),
        reversalCount:
          Number(
            reversals.count
          ),
        activeHoldCount:
          Number(
            holds.count
          )
      });

    const external =
      Object.freeze({
        depositedCredits:
          statement
            .depositedCredits,
        reversedCredits:
          statement
            .reversedCredits,
        activeHoldCredits:
          statement
            .activeHoldCredits
      });

    const deltas =
      Object.freeze({
        depositedCredits:
          local.depositedCredits -
          external
            .depositedCredits,
        reversedCredits:
          local.reversedCredits -
          external
            .reversedCredits,
        activeHoldCredits:
          local.activeHoldCredits -
          external
            .activeHoldCredits
      });

    const matched =
      deltas.depositedCredits ===
        0 &&
      deltas.reversedCredits ===
        0 &&
      deltas.activeHoldCredits ===
        0;

    const recordedAt =
      toIso(
        normalizeTime(
          this.#now(),
          "reconciliation time"
        )
      );

    const reportBase = {
      schema:
        "sponsorrail.funding-reconciliation.v0.17",
      statementId:
        String(
          statement.statementId
        ),
      sourceId:
        String(
          statement.sourceId
        ),
      campaignId:
        String(
          statement.campaignId
        ),
      asset:
        String(
          statement.asset
        ),
      asOf,
      statementHash,
      external,
      local,
      deltas,
      matched,
      recordedAt
    };

    const reportHash =
      createHash("sha256")
        .update(
          canonicalJson(
            reportBase
          )
        )
        .digest("hex");

    const report =
      Object.freeze({
        ...reportBase,
        reportHash
      });

    this.#transaction(
      () => {
        this.#db
          .prepare(`
INSERT INTO funding_reconciliations (
  statement_id,
  source_id,
  campaign_id,
  asset,
  as_of,
  matched,
  statement_hash,
  report_hash,
  report_json,
  recorded_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
          .run(
            report.statementId,
            report.sourceId,
            report.campaignId,
            report.asset,
            report.asOf,
            report.matched
              ? 1
              : 0,
            report.statementHash,
            report.reportHash,
            canonicalJson(
              report
            ),
            report.recordedAt
          );
      }
    );

    return Object.freeze({
      ...report,
      idempotent: false
    });
  }

  listFundingReconciliations({
    campaignId = null,
    sourceId = null,
    matched = null
  } = {}) {
    const clauses = [];
    const params = [];

    if (campaignId !== null) {
      clauses.push(
        "campaign_id = ?"
      );
      params.push(
        String(campaignId)
      );
    }

    if (sourceId !== null) {
      clauses.push(
        "source_id = ?"
      );
      params.push(
        String(sourceId)
      );
    }

    if (matched !== null) {
      clauses.push(
        "matched = ?"
      );
      params.push(
        matched === true
          ? 1
          : 0
      );
    }

    const where =
      clauses.length > 0
        ? ` WHERE ${clauses.join(" AND ")}`
        : "";

    return Object.freeze(
      this.#db
        .prepare(
          `SELECT report_json FROM funding_reconciliations${where} ORDER BY recorded_at, statement_id`
        )
        .all(...params)
        .map(
          (row) =>
            Object.freeze(
              JSON.parse(
                row.report_json
              )
            )
        )
    );
  }

  authorizeCampaign(
    task,
    preferences = {}
  ) {
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

    const normalized =
      normalizeCampaignPreferences(
        preferences
      );

    const allowedCapabilities =
      new Set(
        normalized
          .allowedCapabilityTypes
      );

    const blocked =
      new Set(
        normalized
          .blockedCampaignIds
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
            .prepare(`
SELECT
  p.*,
  c.campaign_id,
  c.capability_type,
  c.benefit_description,
  c.disclosure_label,
  c.targeting_mode,
  c.priority,
  c.budget_credits,
  c.experience_json
FROM sponsor_pools p
JOIN sponsor_campaigns c
  ON c.pool_id = p.id
LEFT JOIN campaign_funding_liabilities l
  ON l.campaign_id = c.campaign_id
WHERE COALESCE(l.outstanding_credits, 0) = 0
  AND NOT EXISTS (
    SELECT 1
    FROM funding_holds h
    WHERE h.campaign_id = c.campaign_id
      AND h.status = 'active'
      AND h.unfunded_credits > 0
  )
ORDER BY c.priority DESC, c.campaign_id
`)
            .all();

        for (const row of rows) {
          if (
            blocked.has(
              String(
                row.campaign_id
              )
            )
          ) {
            continue;
          }

          if (
            !allowedCapabilities
              .has("*") &&
            !allowedCapabilities
              .has(
                String(
                  row.capability_type
                )
              )
          ) {
            continue;
          }

          if (
            row.targeting_mode ===
              "contextual" &&
            normalized
              .allowContextual !==
              true
          ) {
            continue;
          }

          const decision =
            evaluatePolicy(
              request,
              rowPolicy(row)
            );

          if (!decision.eligible) {
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
            continue;
          }

          const campaign =
            this.#campaignForPool(
              row.id
            );

          return this.#mintGrant(
            row,
            request,
            issuedAt,
            expiresAt,
            campaign
          );
        }

        return Object.freeze({
          funded: false,
          reason:
            "NO_ELIGIBLE_SPONSOR_CAMPAIGN"
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
SET reserved_credits =
      reserved_credits - ?,
    spent_credits =
      spent_credits + ?
WHERE id = ?
`)
            .run(
              row.compute_units,
              usedUnits,
              row.pool_id
            );

          this.#creditPool(
            row.pool_id,
            refundUnits
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
