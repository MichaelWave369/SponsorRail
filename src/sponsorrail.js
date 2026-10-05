import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign as cryptoSign,
  verify as cryptoVerify
} from "node:crypto";

const FORBIDDEN_FUNDING_KEYS = new Set([
  "prompt",
  "repositoryContext",
  "repository",
  "source",
  "sourceCode",
  "code",
  "files",
  "output",
  "userIdentity"
]);

const DEFAULT_POLICY = Object.freeze({
  eligibleTaskClasses: ["*"],
  allowedPrivacyModes: ["blind"],
  maxComputePerGrant: null
});

const DEFAULT_GRANT_TTL_MS =
  5 * 60 * 1000;

function assertPositiveInteger(
  value,
  name
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
            canonicalize(
              value[key]
            );

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

function containsForbiddenFundingKey(
  value
) {
  if (
    !value ||
    typeof value !== "object"
  ) {
    return false;
  }

  for (
    const [key, nested]
    of Object.entries(value)
  ) {
    if (
      FORBIDDEN_FUNDING_KEYS
        .has(key)
    ) {
      return true;
    }

    if (
      containsForbiddenFundingKey(
        nested
      )
    ) {
      return true;
    }
  }

  return false;
}

function normalizePolicy({
  eligibleTaskClasses =
    DEFAULT_POLICY
      .eligibleTaskClasses,
  allowedPrivacyModes =
    DEFAULT_POLICY
      .allowedPrivacyModes,
  maxComputePerGrant =
    DEFAULT_POLICY
      .maxComputePerGrant
} = {}) {
  const taskClasses = [
    ...new Set(
      eligibleTaskClasses
        .map(String)
    )
  ];

  const privacyModes = [
    ...new Set(
      allowedPrivacyModes
        .map(String)
    )
  ];

  if (
    taskClasses.length === 0
  ) {
    throw new TypeError(
      "eligibleTaskClasses cannot be empty"
    );
  }

  if (
    privacyModes.length === 0
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

  return Object.freeze({
    eligibleTaskClasses:
      Object.freeze(
        taskClasses
      ),
    allowedPrivacyModes:
      Object.freeze(
        privacyModes
      ),
    maxComputePerGrant
  });
}

function normalizeTime(
  value,
  name
) {
  const ms =
    value instanceof Date
      ? value.getTime()
      : Number(value);

  if (
    !Number.isFinite(ms) ||
    ms < 0
  ) {
    throw new TypeError(
      `${name} must be a valid time`
    );
  }

  return ms;
}

function toIso(ms) {
  return new Date(ms)
    .toISOString();
}

function isExpired(
  expiresAt,
  nowMs
) {
  if (!expiresAt) {
    return false;
  }

  const expiresMs =
    Date.parse(expiresAt);

  return (
    Number.isFinite(
      expiresMs
    ) &&
    expiresMs <= nowMs
  );
}

function computeReceiptHash(
  payload,
  previousReceiptHash,
  sequence
) {
  return sha256Json({
    previousReceiptHash:
      previousReceiptHash ??
      null,
    sequence,
    payload
  });
}

function settlementResult(
  record
) {
  return Object.freeze({
    reservedUnits:
      record.reservedUnits,
    usedUnits:
      record.usedUnits,
    refundUnits:
      record.refundUnits
  });
}

export function evaluatePolicy(
  request,
  policy
) {
  if (
    containsForbiddenFundingKey(
      request
    )
  ) {
    return Object.freeze({
      eligible: false,
      reason:
        "PRIVATE_DATA_REJECTED"
    });
  }

  const normalized =
    normalizePolicy(policy);

  const classAllowed =
    normalized
      .eligibleTaskClasses
      .includes("*") ||
    normalized
      .eligibleTaskClasses
      .includes(
        request.taskClass
      );

  if (!classAllowed) {
    return Object.freeze({
      eligible: false,
      reason:
        "TASK_CLASS_NOT_ELIGIBLE"
    });
  }

  if (
    !normalized
      .allowedPrivacyModes
      .includes(
        request.privacy
      )
  ) {
    return Object.freeze({
      eligible: false,
      reason:
        "PRIVACY_MODE_NOT_ELIGIBLE"
    });
  }

  if (
    normalized
      .maxComputePerGrant !==
        null &&
    request.computeRequested >
      normalized
        .maxComputePerGrant
  ) {
    return Object.freeze({
      eligible: false,
      reason:
        "GRANT_LIMIT_EXCEEDED"
    });
  }

  return Object.freeze({
    eligible: true,
    reason: "ELIGIBLE"
  });
}

export function sanitizeFundingRequest(
  task
) {
  if (
    !task ||
    typeof task !== "object"
  ) {
    throw new TypeError(
      "task is required"
    );
  }

  assertPositiveInteger(
    task.computeRequested,
    "computeRequested"
  );

  const request = {
    taskId: String(task.id),
    taskClass: String(
      task.taskClass ??
        "software-development"
    ),
    computeRequested:
      task.computeRequested,
    userMaxCost: Number(
      task.userMaxCost ?? 0
    ),
    privacy: String(
      task.privacy ?? "blind"
    )
  };

  if (
    containsForbiddenFundingKey(
      request
    )
  ) {
    throw new Error(
      "funding request contains private task data"
    );
  }

  return Object.freeze(
    request
  );
}

export function buildModelContext(
  task
) {
  if (!task?.prompt) {
    throw new TypeError(
      "task.prompt is required"
    );
  }

  return Object.freeze({
    taskId: String(task.id),
    prompt:
      String(task.prompt),
    repositoryContext:
      String(
        task.repositoryContext ??
          ""
      )
  });
}

export function buildExecutionAuthorization(
  grant
) {
  assertPositiveInteger(
    grant.computeUnits,
    "grant.computeUnits"
  );

  return Object.freeze({
    grantId:
      String(grant.grantId),
    computeUnits:
      grant.computeUnits
  });
}

export class BlindSponsorPool {
  #availableCredits;
  #reservedCredits;
  #spentCredits;
  #reservations;

  constructor({
    id,
    sponsorDisclosure,
    balanceCredits,
    eligibleTaskClasses = [
      "*"
    ],
    allowedPrivacyModes = [
      "blind"
    ],
    maxComputePerGrant =
      null,
    campaign = null,
    reservedCredits = 0,
    spentCredits = 0,
    reservations = []
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

    assertNonNegativeInteger(
      reservedCredits,
      "reservedCredits"
    );

    assertNonNegativeInteger(
      spentCredits,
      "spentCredits"
    );

    this.id = String(id);

    this.sponsorDisclosure =
      String(
        sponsorDisclosure
      );

    this.policy =
      normalizePolicy({
        eligibleTaskClasses,
        allowedPrivacyModes,
        maxComputePerGrant
      });

    this.campaign =
      campaign
        ? Object.freeze({
            schema:
              String(
                campaign.schema
              ),
            campaignId:
              String(
                campaign.campaignId
              ),
            capabilityType:
              String(
                campaign.capabilityType
              ),
            benefitDescription:
              String(
                campaign.benefitDescription
              ),
            disclosureLabel:
              String(
                campaign.disclosureLabel
              ),
            targetingMode:
              String(
                campaign.targetingMode
              ),
            interactionRequired:
              campaign.interactionRequired ===
                true,
            dismissible:
              campaign.dismissible ===
                true,
            dataShared:
              String(
                campaign.dataShared
              ),
            influence:
              String(
                campaign.influence
              )
          })
        : null;

    if (
      this.campaign &&
      (
        this.campaign
          .interactionRequired ||
        !this.campaign
          .dismissible ||
        this.campaign
          .dataShared !==
            "none" ||
        this.campaign
          .influence !==
            "none"
      )
    ) {
      throw new Error(
        "campaign violates SponsorRail funding contract"
      );
    }

    this.#availableCredits =
      balanceCredits;

    this.#reservedCredits =
      reservedCredits;

    this.#spentCredits =
      spentCredits;

    this.#reservations =
      new Map();

    for (
      const reservation
      of reservations
    ) {
      assertPositiveInteger(
        reservation
          .computeUnits,
        "reservation.computeUnits"
      );

      const normalized =
        Object.freeze({
          reservationId:
            String(
              reservation
                .reservationId
            ),
          taskId:
            String(
              reservation
                .taskId
            ),
          taskClass:
            String(
              reservation
                .taskClass
            ),
          privacy:
            String(
              reservation
                .privacy
            ),
          computeUnits:
            reservation
              .computeUnits,
          issuedAt:
            reservation
              .issuedAt ?? null,
          expiresAt:
            reservation
              .expiresAt ?? null
        });

      this.#reservations
        .set(
          normalized
            .reservationId,
          normalized
        );
    }

    const reservationTotal =
      [
        ...this.#reservations
          .values()
      ].reduce(
        (sum, item) =>
          sum +
          item.computeUnits,
        0
      );

    if (
      reservationTotal !==
      this.#reservedCredits
    ) {
      throw new Error(
        "reservedCredits does not match persisted reservations"
      );
    }
  }

  static fromSnapshot(
    snapshot
  ) {
    if (
      ![
        "sponsorrail.pool.v0.2",
        "sponsorrail.pool.v0.3",
        "sponsorrail.pool.v0.4",
        "sponsorrail.pool.v0.11"
      ].includes(
        snapshot?.schema
      )
    ) {
      throw new Error(
        "unsupported SponsorRail pool snapshot schema"
      );
    }

    return new BlindSponsorPool({
      id: snapshot.id,
      sponsorDisclosure:
        snapshot
          .sponsorDisclosure,
      balanceCredits:
        snapshot
          .availableCredits,
      reservedCredits:
        snapshot
          .reservedCredits,
      spentCredits:
        snapshot
          .spentCredits,
      reservations:
        snapshot
          .reservations ??
        [],
      campaign:
        snapshot.campaign ??
        null,
      ...snapshot.policy
    });
  }

  get balanceCredits() {
    return this
      .#availableCredits;
  }

  get availableCredits() {
    return this
      .#availableCredits;
  }

  get reservedCredits() {
    return this
      .#reservedCredits;
  }

  get spentCredits() {
    return this
      .#spentCredits;
  }

  get totalCredits() {
    return (
      this.#availableCredits +
      this.#reservedCredits +
      this.#spentCredits
    );
  }

  evaluate(request) {
    return evaluatePolicy(
      request,
      this.policy
    );
  }

  reserve(
    request,
    {
      issuedAt = null,
      expiresAt = null
    } = {}
  ) {
    if (
      containsForbiddenFundingKey(
        request
      )
    ) {
      throw new Error(
        "blind sponsor pool received forbidden private task data"
      );
    }

    const decision =
      this.evaluate(request);

    if (
      !decision.eligible ||
      this.#availableCredits <
        request
          .computeRequested
    ) {
      return null;
    }

    const reservation =
      Object.freeze({
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
        issuedAt,
        expiresAt
      });

    this.#availableCredits -=
      reservation
        .computeUnits;

    this.#reservedCredits +=
      reservation
        .computeUnits;

    this.#reservations.set(
      reservation
        .reservationId,
      reservation
    );

    return reservation;
  }

  getReservation(
    reservationId
  ) {
    return (
      this.#reservations
        .get(
          String(
            reservationId
          )
        ) ?? null
    );
  }

  listReservations() {
    return [
      ...this.#reservations
        .values()
    ];
  }

  renewReservation(
    reservationId,
    expiresAt
  ) {
    const key =
      String(
        reservationId
      );

    const reservation =
      this.#reservations
        .get(key);

    if (!reservation) {
      throw new Error(
        "unknown reservation"
      );
    }

    const renewed =
      Object.freeze({
        ...reservation,
        expiresAt:
          String(expiresAt)
      });

    this.#reservations
      .set(
        key,
        renewed
      );

    return renewed;
  }

  settle(
    reservationId,
    usedUnits
  ) {
    assertNonNegativeInteger(
      usedUnits,
      "usedUnits"
    );

    const reservation =
      this.#reservations
        .get(
          String(
            reservationId
          )
        );

    if (!reservation) {
      throw new Error(
        "unknown reservation"
      );
    }

    if (
      usedUnits >
      reservation
        .computeUnits
    ) {
      throw new Error(
        "settlement exceeds reserved compute"
      );
    }

    const refundUnits =
      reservation
        .computeUnits -
      usedUnits;

    this.#reservedCredits -=
      reservation
        .computeUnits;

    this.#spentCredits +=
      usedUnits;

    this.#availableCredits +=
      refundUnits;

    this.#reservations
      .delete(
        reservation
          .reservationId
      );

    return Object.freeze({
      reservedUnits:
        reservation
          .computeUnits,
      usedUnits,
      refundUnits
    });
  }

  release(
    reservationId
  ) {
    const reservation =
      this.#reservations
        .get(
          String(
            reservationId
          )
        );

    if (!reservation) {
      return false;
    }

    this.#reservedCredits -=
      reservation
        .computeUnits;

    this.#availableCredits +=
      reservation
        .computeUnits;

    this.#reservations
      .delete(
        reservation
          .reservationId
      );

    return true;
  }

  snapshot() {
    return Object.freeze({
      schema:
        "sponsorrail.pool.v0.11",
      id: this.id,
      sponsorDisclosure:
        this
          .sponsorDisclosure,
      campaign:
        this.campaign
          ? {
              ...this.campaign
            }
          : null,
      policy: {
        eligibleTaskClasses: [
          ...this.policy
            .eligibleTaskClasses
        ],
        allowedPrivacyModes: [
          ...this.policy
            .allowedPrivacyModes
        ],
        maxComputePerGrant:
          this.policy
            .maxComputePerGrant
      },
      availableCredits:
        this
          .#availableCredits,
      reservedCredits:
        this
          .#reservedCredits,
      spentCredits:
        this
          .#spentCredits,
      reservations: [
        ...this.#reservations
          .values()
      ].map(
        (item) => ({
          ...item
        })
      )
    });
  }
}

export class FundingBroker {
  #grants;
  #settlements;
  #now;
  #grantTtlMs;
  #receiptChain;
  #receiptJournal;

  constructor(
    pools = [],
    {
      store = null,
      grantTtlMs =
        DEFAULT_GRANT_TTL_MS,
      now =
        () => Date.now(),
      autoReconcile =
        true
    } = {}
  ) {
    assertPositiveInteger(
      grantTtlMs,
      "grantTtlMs"
    );

    if (
      typeof now !== "function"
    ) {
      throw new TypeError(
        "now must be a function"
      );
    }

    this.store = store;

    this.#grantTtlMs =
      grantTtlMs;

    this.#now = now;

    this.#grants =
      new Map();

    this.#settlements =
      new Map();

    this.#receiptChain = {
      sequence: 0,
      headHash: null
    };

    this.#receiptJournal =
      [];

    if (
      pools.length === 0 &&
      this.store
    ) {
      const state =
        this.store
          .loadState();

      this.pools =
        state.pools.map(
          BlindSponsorPool
            .fromSnapshot
        );

      for (
        const grant
        of state.grants
      ) {
        if (
          containsForbiddenFundingKey(
            grant
          )
        ) {
          throw new Error(
            "persisted grant contains private task data"
          );
        }

        this.#grants.set(
          String(
            grant.grantId
          ),
          Object.freeze({
            ...grant
          })
        );
      }

      for (
        const settlement
        of (
          state.settlements ??
          []
        )
      ) {
        this.#settlements
          .set(
            String(
              settlement
                .idempotencyKey
            ),
            Object.freeze({
              ...settlement
            })
          );
      }

      this.#receiptChain = {
        sequence:
          state.receiptChain
            ?.sequence ?? 0,
        headHash:
          state.receiptChain
            ?.headHash ??
          null
      };

      this.#receiptJournal =
        this.store
          .loadReceiptJournal();

      if (
        this.#receiptJournal
          .length > 0
      ) {
        if (
          !verifyReceiptChain(
            this.#receiptJournal
          )
        ) {
          throw new Error(
            "invalid receipt journal chain"
          );
        }

        const tail =
          this.#receiptJournal[
            this.#receiptJournal
              .length - 1
          ];

        if (
          tail.chain
            .sequence >
          this.#receiptChain
            .sequence
        ) {
          this.#receiptChain = {
            sequence:
              tail.chain
                .sequence,
            headHash:
              tail.chain
                .receiptHash
          };

          this.#persist();
        } else if (
          tail.chain
            .sequence ===
            this.#receiptChain
              .sequence &&
          tail.chain
            .receiptHash !==
            this.#receiptChain
              .headHash
        ) {
          throw new Error(
            "receipt journal conflicts with persisted chain head"
          );
        }
      }
    } else {
      this.pools = [
        ...pools
      ];
    }

    if (autoReconcile) {
      this.reconcile();
    }
  }

  #persist() {
    if (!this.store) {
      return;
    }

    this.store.saveState({
      pools:
        this.pools.map(
          (pool) =>
            pool.snapshot()
        ),
      grants: [
        ...this.#grants
          .values()
      ].map(
        (grant) => ({
          ...grant
        })
      ),
      settlements: [
        ...this.#settlements
          .values()
      ].map(
        (record) => ({
          ...record
        })
      ),
      receiptChain: {
        ...this
          .#receiptChain
      }
    });
  }

  #findPool(poolId) {
    return this.pools.find(
      (candidate) =>
        candidate.id ===
        poolId
    );
  }

  #findSettlementForGrant(
    grantId
  ) {
    return (
      [
        ...this.#settlements
          .values()
      ].find(
        (record) =>
          record.grantId ===
          String(grantId)
      ) ?? null
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

    let lastPolicyReason =
      "NO_ELIGIBLE_SPONSOR_POOL";

    const issuedAtMs =
      normalizeTime(
        this.#now(),
        "now"
      );

    const expiresAtMs =
      issuedAtMs +
      this.#grantTtlMs;

    const issuedAt =
      toIso(issuedAtMs);

    const expiresAt =
      toIso(expiresAtMs);

    for (
      const pool
      of this.pools
    ) {
      const decision =
        pool.evaluate(
          request
        );

      if (
        !decision.eligible
      ) {
        lastPolicyReason =
          decision.reason;

        continue;
      }

      const reservation =
        pool.reserve(
          request,
          {
            issuedAt,
            expiresAt
          }
        );

      if (!reservation) {
        lastPolicyReason =
          "INSUFFICIENT_SPONSOR_CREDITS";

        continue;
      }

      const grant =
        Object.freeze({
          funded: true,
          grantId:
            randomUUID(),
          poolId:
            pool.id,
          reservationId:
            reservation
              .reservationId,
          taskId:
            request.taskId,
          taskClass:
            request.taskClass,
          privacy:
            request.privacy,
          computeUnits:
            reservation
              .computeUnits,
          sponsorDisclosure:
            pool
              .sponsorDisclosure,
          campaign:
            pool.campaign
              ? {
                  ...pool.campaign
                }
              : null,
          issuedAt,
          expiresAt
        });

      this.#grants
        .set(
          grant.grantId,
          grant
        );

      this.#persist();

      return grant;
    }

    return Object.freeze({
      funded: false,
      reason:
        lastPolicyReason
    });
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

    const known =
      this.#grants
        .get(
          String(
            grant?.grantId
          )
        );

    if (!known) {
      throw new Error(
        "unknown grant"
      );
    }

    const nowMs =
      normalizeTime(
        this.#now(),
        "now"
      );

    if (
      isExpired(
        known.expiresAt,
        nowMs
      )
    ) {
      this.release(known);

      throw new Error(
        "grant expired"
      );
    }

    const currentExpiryMs =
      Date.parse(
        known.expiresAt
      );

    const renewedExpiryMs =
      Math.max(
        currentExpiryMs,
        nowMs + leaseMs
      );

    const expiresAt =
      toIso(
        renewedExpiryMs
      );

    const renewed =
      Object.freeze({
        ...known,
        expiresAt,
        lastHeartbeatAt:
          toIso(nowMs)
      });

    const pool =
      this.#findPool(
        known.poolId
      );

    if (!pool) {
      throw new Error(
        "grant pool unavailable"
      );
    }

    pool.renewReservation(
      known.reservationId,
      expiresAt
    );

    this.#grants.set(
      known.grantId,
      renewed
    );

    this.#persist();

    return renewed;
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

    const byKey =
      this.#settlements
        .get(key);

    if (byKey) {
      if (
        byKey.grantId !==
          String(
            grant?.grantId
          ) ||
        byKey.usedUnits !==
          usedUnits
      ) {
        throw new Error(
          "idempotency conflict"
        );
      }

      return settlementResult(
        byKey
      );
    }

    const byGrant =
      this
        .#findSettlementForGrant(
          grant?.grantId
        );

    if (byGrant) {
      if (
        byGrant.usedUnits !==
        usedUnits
      ) {
        throw new Error(
          "idempotency conflict"
        );
      }

      return settlementResult(
        byGrant
      );
    }

    const known =
      this.#grants
        .get(
          String(
            grant?.grantId
          )
        );

    if (!known) {
      throw new Error(
        "unknown grant"
      );
    }

    const nowMs =
      normalizeTime(
        this.#now(),
        "now"
      );

    if (
      isExpired(
        known.expiresAt,
        nowMs
      )
    ) {
      this.release(known);

      throw new Error(
        "grant expired"
      );
    }

    const pool =
      this.#findPool(
        known.poolId
      );

    if (!pool) {
      throw new Error(
        "grant pool unavailable"
      );
    }

    const settlement =
      pool.settle(
        known.reservationId,
        usedUnits
      );

    const record =
      Object.freeze({
        schema:
          "sponsorrail.settlement.v0.4",
        idempotencyKey:
          key,
        grantId:
          known.grantId,
        poolId:
          known.poolId,
        reservationId:
          known
            .reservationId,
        reservedUnits:
          settlement
            .reservedUnits,
        usedUnits:
          settlement
            .usedUnits,
        refundUnits:
          settlement
            .refundUnits,
        settledAt:
          toIso(nowMs)
      });

    this.#grants.delete(
      known.grantId
    );

    this.#settlements.set(
      key,
      record
    );

    this.#persist();

    return settlementResult(
      record
    );
  }

  release(grant) {
    const known =
      this.#grants
        .get(
          String(
            grant?.grantId
          )
        );

    if (!known) {
      return false;
    }

    const pool =
      this.#findPool(
        known.poolId
      );

    if (!pool) {
      throw new Error(
        "grant pool unavailable"
      );
    }

    const released =
      pool.release(
        known.reservationId
      );

    this.#grants.delete(
      known.grantId
    );

    this.#persist();

    return released;
  }

  reconcile({
    now = this.#now()
  } = {}) {
    const nowMs =
      normalizeTime(
        now,
        "now"
      );

    const report = {
      expiredGrants: [],
      staleGrants: [],
      orphanReservations: [],
      releasedOrphans: []
    };

    let changed = false;

    const referenced =
      new Set();

    for (
      const [grantId, grant]
      of this.#grants
    ) {
      const pool =
        this.#findPool(
          grant.poolId
        );

      if (
        !pool ||
        !pool.getReservation(
          grant.reservationId
        )
      ) {
        this.#grants
          .delete(
            grantId
          );

        report.staleGrants
          .push(
            grantId
          );

        changed = true;

        continue;
      }

      if (
        isExpired(
          grant.expiresAt,
          nowMs
        )
      ) {
        pool.release(
          grant
            .reservationId
        );

        this.#grants
          .delete(
            grantId
          );

        report.expiredGrants
          .push(
            grantId
          );

        changed = true;

        continue;
      }

      referenced.add(
        `${pool.id}:${grant.reservationId}`
      );
    }

    for (
      const pool
      of this.pools
    ) {
      for (
        const reservation
        of pool
          .listReservations()
      ) {
        const key =
          `${pool.id}:${reservation.reservationId}`;

        if (
          referenced.has(
            key
          )
        ) {
          continue;
        }

        const orphan = {
          poolId:
            pool.id,
          reservationId:
            reservation
              .reservationId,
          taskId:
            reservation
              .taskId,
          expiresAt:
            reservation
              .expiresAt ??
            null
        };

        if (
          isExpired(
            reservation
              .expiresAt,
            nowMs
          )
        ) {
          pool.release(
            reservation
              .reservationId
          );

          report
            .releasedOrphans
            .push(orphan);

          changed = true;
        } else {
          report
            .orphanReservations
            .push(orphan);
        }
      }
    }

    if (changed) {
      this.#persist();
    }

    return Object.freeze({
      expiredGrants:
        Object.freeze([
          ...report
            .expiredGrants
        ]),
      staleGrants:
        Object.freeze([
          ...report
            .staleGrants
        ]),
      orphanReservations:
        Object.freeze([
          ...report
            .orphanReservations
        ]),
      releasedOrphans:
        Object.freeze([
          ...report
            .releasedOrphans
        ])
    });
  }

  receiptChainState() {
    return Object.freeze({
      ...this
        .#receiptChain
    });
  }

  receiptJournal() {
    return Object.freeze([
      ...this
        .#receiptJournal
    ]);
  }

  prepareReceipt(payload) {
    if (
      !payload ||
      typeof payload !==
        "object"
    ) {
      throw new TypeError(
        "receipt payload is required"
      );
    }

    const sequence =
      this.#receiptChain
        .sequence + 1;

    const previousReceiptHash =
      this.#receiptChain
        .headHash;

    const receiptHash =
      computeReceiptHash(
        payload,
        previousReceiptHash,
        sequence
      );

    return Object.freeze({
      sequence,
      previousReceiptHash,
      receiptHash
    });
  }

  commitReceipt(receipt) {
    if (
      !verifyReceiptHash(
        receipt
      )
    ) {
      throw new Error(
        "invalid receipt hash"
      );
    }

    if (
      receipt.chain
        .sequence ===
        this.#receiptChain
          .sequence &&
      receipt.chain
        .receiptHash ===
        this.#receiptChain
          .headHash
    ) {
      return Object.freeze({
        ...receipt.chain
      });
    }

    if (
      receipt.chain
        .sequence !==
      this.#receiptChain
        .sequence + 1
    ) {
      throw new Error(
        "receipt sequence conflict"
      );
    }

    if (
      (
        receipt.chain
          .previousReceiptHash ??
        null
      ) !==
      this.#receiptChain
        .headHash
    ) {
      throw new Error(
        "receipt chain conflict"
      );
    }

    if (this.store) {
      this.store
        .appendReceipt(
          receipt
        );
    }

    this.#receiptJournal
      .push(receipt);

    this.#receiptChain = {
      sequence:
        receipt.chain
          .sequence,
      headHash:
        receipt.chain
          .receiptHash
    };

    this.#persist();

    return Object.freeze({
      ...receipt.chain
    });
  }

  linkReceipt(payload) {
    return this.prepareReceipt(
      payload
    );
  }

  commitReceiptPayload(payload, privateKey = null) {
    const chain = this.prepareReceipt(payload);
    const chainedPayload = {
      ...payload,
      chain
    };

    const receipt = privateKey
      ? signReceipt(chainedPayload, privateKey)
      : Object.freeze(chainedPayload);

    this.commitReceipt(receipt);
    return receipt;
  }
}

export function createReceiptKeyPair() {
  const {
    publicKey,
    privateKey
  } =
    generateKeyPairSync(
      "ed25519"
    );

  return {
    publicKey:
      publicKey.export({
        type: "spki",
        format: "pem"
      }),
    privateKey:
      privateKey.export({
        type: "pkcs8",
        format: "pem"
      })
  };
}

export function signReceipt(
  payload,
  privateKey
) {
  const canonical =
    canonicalJson(payload);

  const signature =
    cryptoSign(
      null,
      Buffer.from(
        canonical
      ),
      privateKey
    );

  return Object.freeze({
    ...payload,
    signature:
      Object.freeze({
        algorithm:
          "Ed25519",
        value:
          signature
            .toString(
              "base64"
            )
      })
  });
}

export function verifyReceipt(
  receipt,
  publicKey
) {
  if (
    receipt?.signature
      ?.algorithm !==
    "Ed25519"
  ) {
    return false;
  }

  const {
    signature,
    ...payload
  } = receipt;

  return cryptoVerify(
    null,
    Buffer.from(
      canonicalJson(
        payload
      )
    ),
    publicKey,
    Buffer.from(
      signature.value,
      "base64"
    )
  );
}

export function verifyReceiptHash(
  receipt
) {
  if (
    !receipt?.chain ||
    !Number.isInteger(
      receipt.chain
        .sequence
    ) ||
    !receipt.chain
      .receiptHash
  ) {
    return false;
  }

  const {
    signature:
      _signature,
    chain,
    ...payload
  } = receipt;

  const expected =
    computeReceiptHash(
      payload,
      chain
        .previousReceiptHash ??
        null,
      chain.sequence
    );

  return (
    expected ===
    chain.receiptHash
  );
}

export function verifyReceiptChain(
  receipts
) {
  if (
    !Array.isArray(
      receipts
    ) ||
    receipts.length === 0
  ) {
    return false;
  }

  let previous =
    receipts[0].chain
      ?.previousReceiptHash ??
    null;

  let sequence =
    receipts[0].chain
      ?.sequence ??
    null;

  if (
    !Number.isInteger(
      sequence
    )
  ) {
    return false;
  }

  for (
    const receipt
    of receipts
  ) {
    if (
      !verifyReceiptHash(
        receipt
      ) ||
      receipt.chain
        .sequence !==
        sequence ||
      (
        receipt.chain
          .previousReceiptHash ??
        null
      ) !== previous
    ) {
      return false;
    }

    previous =
      receipt.chain
        .receiptHash;

    sequence += 1;
  }

  return true;
}

export async function executeSponsoredTask({
  task,
  broker,
  runner,
  receiptPrivateKey
}) {
  if (
    !broker ||
    typeof broker
      .authorize !==
      "function"
  ) {
    throw new TypeError(
      "broker is required"
    );
  }

  if (
    typeof runner !==
    "function"
  ) {
    throw new TypeError(
      "runner is required"
    );
  }

  const grant =
    broker.authorize(
      task
    );

  if (!grant.funded) {
    return Object.freeze({
      status: grant.reason,
      funded: false
    });
  }

  const modelContext =
    buildModelContext(
      task
    );

  const authorization =
    buildExecutionAuthorization(
      grant
    );

  let result;
  let computeUnitsUsed;
  let settlement;

  try {
    result =
      await runner(
        Object.freeze({
          modelContext,
          authorization
        })
      );

    computeUnitsUsed =
      Number(
        result
          ?.computeUnitsUsed ??
        0
      );

    if (
      !Number.isInteger(
        computeUnitsUsed
      ) ||
      computeUnitsUsed < 0 ||
      computeUnitsUsed >
        authorization
          .computeUnits
    ) {
      throw new Error(
        "runner reported invalid compute usage"
      );
    }

    settlement =
      broker.settle(
        grant,
        computeUnitsUsed,
        {
          idempotencyKey:
            `run:${grant.grantId}`
        }
      );
  } catch (error) {
    broker.release(grant);

    throw error;
  }

  const receiptPayload = {
    schema:
      "sponsorrail.receipt.v0.17",
    runId: randomUUID(),
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
      authorization
        .computeUnits,
    computeUnitsUsed,
    computeUnitsRefunded:
      settlement
        .refundUnits,
    userCostCredits: 0,
    sponsorContributionCredits:
      computeUnitsUsed,
    sponsorDisclosure:
      grant
        .sponsorDisclosure,
    campaign:
      grant.campaign
        ? {
            ...grant.campaign
          }
        : null,
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
    evidence: {
      modelContextSha256:
        sha256Json(
          modelContext
        )
    },
    completed:
      result?.completed ===
      true
  };

  const receipt =
    typeof broker.commitReceiptPayload === "function"
      ? broker.commitReceiptPayload(
          receiptPayload,
          receiptPrivateKey ?? null
        )
      : (() => {
          const chain = broker.prepareReceipt(
            receiptPayload
          );
          const chainedPayload = {
            ...receiptPayload,
            chain
          };
          const fallbackReceipt = receiptPrivateKey
            ? signReceipt(
                chainedPayload,
                receiptPrivateKey
              )
            : Object.freeze(
                chainedPayload
              );
          broker.commitReceipt(
            fallbackReceipt
          );
          return fallbackReceipt;
        })();

  return Object.freeze({
    status: "COMPLETED",
    funded: true,
    result,
    receipt
  });
}
