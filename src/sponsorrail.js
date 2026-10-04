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

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }

  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function containsForbiddenFundingKey(value) {
  if (!value || typeof value !== "object") {
    return false;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FUNDING_KEYS.has(key)) {
      return true;
    }

    if (containsForbiddenFundingKey(nested)) {
      return true;
    }
  }

  return false;
}

function normalizePolicy({
  eligibleTaskClasses = DEFAULT_POLICY.eligibleTaskClasses,
  allowedPrivacyModes = DEFAULT_POLICY.allowedPrivacyModes,
  maxComputePerGrant = DEFAULT_POLICY.maxComputePerGrant
} = {}) {
  const taskClasses = [...new Set(eligibleTaskClasses.map(String))];
  const privacyModes = [...new Set(allowedPrivacyModes.map(String))];

  if (taskClasses.length === 0) {
    throw new TypeError("eligibleTaskClasses cannot be empty");
  }

  if (privacyModes.length === 0) {
    throw new TypeError("allowedPrivacyModes cannot be empty");
  }

  if (maxComputePerGrant !== null) {
    assertPositiveInteger(maxComputePerGrant, "maxComputePerGrant");
  }

  return Object.freeze({
    eligibleTaskClasses: Object.freeze(taskClasses),
    allowedPrivacyModes: Object.freeze(privacyModes),
    maxComputePerGrant
  });
}

export function evaluatePolicy(request, policy) {
  if (containsForbiddenFundingKey(request)) {
    return Object.freeze({
      eligible: false,
      reason: "PRIVATE_DATA_REJECTED"
    });
  }

  const normalized = normalizePolicy(policy);

  const classAllowed =
    normalized.eligibleTaskClasses.includes("*") ||
    normalized.eligibleTaskClasses.includes(request.taskClass);

  if (!classAllowed) {
    return Object.freeze({
      eligible: false,
      reason: "TASK_CLASS_NOT_ELIGIBLE"
    });
  }

  if (!normalized.allowedPrivacyModes.includes(request.privacy)) {
    return Object.freeze({
      eligible: false,
      reason: "PRIVACY_MODE_NOT_ELIGIBLE"
    });
  }

  if (
    normalized.maxComputePerGrant !== null &&
    request.computeRequested > normalized.maxComputePerGrant
  ) {
    return Object.freeze({
      eligible: false,
      reason: "GRANT_LIMIT_EXCEEDED"
    });
  }

  return Object.freeze({
    eligible: true,
    reason: "ELIGIBLE"
  });
}

export function sanitizeFundingRequest(task) {
  if (!task || typeof task !== "object") {
    throw new TypeError("task is required");
  }

  assertPositiveInteger(task.computeRequested, "computeRequested");

  const request = {
    taskId: String(task.id),
    taskClass: String(task.taskClass ?? "software-development"),
    computeRequested: task.computeRequested,
    userMaxCost: Number(task.userMaxCost ?? 0),
    privacy: String(task.privacy ?? "blind")
  };

  if (containsForbiddenFundingKey(request)) {
    throw new Error("funding request contains private task data");
  }

  return Object.freeze(request);
}

export function buildModelContext(task) {
  if (!task?.prompt) {
    throw new TypeError("task.prompt is required");
  }

  return Object.freeze({
    taskId: String(task.id),
    prompt: String(task.prompt),
    repositoryContext: String(task.repositoryContext ?? "")
  });
}

export function buildExecutionAuthorization(grant) {
  assertPositiveInteger(grant.computeUnits, "grant.computeUnits");

  return Object.freeze({
    grantId: String(grant.grantId),
    computeUnits: grant.computeUnits
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
    eligibleTaskClasses = ["*"],
    allowedPrivacyModes = ["blind"],
    maxComputePerGrant = null,
    reservedCredits = 0,
    spentCredits = 0,
    reservations = []
  }) {
    if (!id || !sponsorDisclosure) {
      throw new TypeError("pool id and sponsorDisclosure are required");
    }

    assertNonNegativeInteger(balanceCredits, "balanceCredits");
    assertNonNegativeInteger(reservedCredits, "reservedCredits");
    assertNonNegativeInteger(spentCredits, "spentCredits");

    this.id = String(id);
    this.sponsorDisclosure = String(sponsorDisclosure);
    this.policy = normalizePolicy({
      eligibleTaskClasses,
      allowedPrivacyModes,
      maxComputePerGrant
    });

    this.#availableCredits = balanceCredits;
    this.#reservedCredits = reservedCredits;
    this.#spentCredits = spentCredits;
    this.#reservations = new Map();

    for (const reservation of reservations) {
      assertPositiveInteger(
        reservation.computeUnits,
        "reservation.computeUnits"
      );

      this.#reservations.set(
        String(reservation.reservationId),
        Object.freeze({
          reservationId: String(reservation.reservationId),
          taskId: String(reservation.taskId),
          taskClass: String(reservation.taskClass),
          privacy: String(reservation.privacy),
          computeUnits: reservation.computeUnits
        })
      );
    }

    const reservationTotal = [...this.#reservations.values()].reduce(
      (sum, item) => sum + item.computeUnits,
      0
    );

    if (reservationTotal !== this.#reservedCredits) {
      throw new Error(
        "reservedCredits does not match persisted reservations"
      );
    }
  }

  static fromSnapshot(snapshot) {
    if (snapshot?.schema !== "sponsorrail.pool.v0.2") {
      throw new Error("unsupported SponsorRail pool snapshot schema");
    }

    return new BlindSponsorPool({
      id: snapshot.id,
      sponsorDisclosure: snapshot.sponsorDisclosure,
      balanceCredits: snapshot.availableCredits,
      reservedCredits: snapshot.reservedCredits,
      spentCredits: snapshot.spentCredits,
      reservations: snapshot.reservations ?? [],
      ...snapshot.policy
    });
  }

  get balanceCredits() {
    return this.#availableCredits;
  }

  get availableCredits() {
    return this.#availableCredits;
  }

  get reservedCredits() {
    return this.#reservedCredits;
  }

  get spentCredits() {
    return this.#spentCredits;
  }

  get totalCredits() {
    return (
      this.#availableCredits +
      this.#reservedCredits +
      this.#spentCredits
    );
  }

  evaluate(request) {
    return evaluatePolicy(request, this.policy);
  }

  reserve(request) {
    if (containsForbiddenFundingKey(request)) {
      throw new Error(
        "blind sponsor pool received forbidden private task data"
      );
    }

    const decision = this.evaluate(request);

    if (
      !decision.eligible ||
      this.#availableCredits < request.computeRequested
    ) {
      return null;
    }

    const reservation = Object.freeze({
      reservationId: randomUUID(),
      taskId: request.taskId,
      taskClass: request.taskClass,
      privacy: request.privacy,
      computeUnits: request.computeRequested
    });

    this.#availableCredits -= reservation.computeUnits;
    this.#reservedCredits += reservation.computeUnits;
    this.#reservations.set(
      reservation.reservationId,
      reservation
    );

    return reservation;
  }

  settle(reservationId, usedUnits) {
    assertNonNegativeInteger(usedUnits, "usedUnits");

    const reservation = this.#reservations.get(
      String(reservationId)
    );

    if (!reservation) {
      throw new Error("unknown reservation");
    }

    if (usedUnits > reservation.computeUnits) {
      throw new Error("settlement exceeds reserved compute");
    }

    const refundUnits =
      reservation.computeUnits - usedUnits;

    this.#reservedCredits -= reservation.computeUnits;
    this.#spentCredits += usedUnits;
    this.#availableCredits += refundUnits;
    this.#reservations.delete(
      reservation.reservationId
    );

    return Object.freeze({
      reservedUnits: reservation.computeUnits,
      usedUnits,
      refundUnits
    });
  }

  release(reservationId) {
    const reservation = this.#reservations.get(
      String(reservationId)
    );

    if (!reservation) {
      return false;
    }

    this.#reservedCredits -= reservation.computeUnits;
    this.#availableCredits += reservation.computeUnits;
    this.#reservations.delete(
      reservation.reservationId
    );

    return true;
  }

  snapshot() {
    return Object.freeze({
      schema: "sponsorrail.pool.v0.2",
      id: this.id,
      sponsorDisclosure: this.sponsorDisclosure,
      policy: {
        eligibleTaskClasses: [
          ...this.policy.eligibleTaskClasses
        ],
        allowedPrivacyModes: [
          ...this.policy.allowedPrivacyModes
        ],
        maxComputePerGrant:
          this.policy.maxComputePerGrant
      },
      availableCredits: this.#availableCredits,
      reservedCredits: this.#reservedCredits,
      spentCredits: this.#spentCredits,
      reservations: [
        ...this.#reservations.values()
      ].map((item) => ({ ...item }))
    });
  }
}

export class FundingBroker {
  #grants;

  constructor(pools = [], { store = null } = {}) {
    this.store = store;
    this.pools = [...pools];
    this.#grants = new Map();

    if (this.pools.length === 0 && this.store) {
      this.pools = this.store
        .loadSnapshots()
        .map(BlindSponsorPool.fromSnapshot);
    }
  }

  #persist() {
    if (this.store) {
      this.store.saveSnapshots(
        this.pools.map((pool) => pool.snapshot())
      );
    }
  }

  authorize(task) {
    if (task.allowSponsorship === false) {
      return Object.freeze({
        funded: false,
        reason: "SPONSORSHIP_DECLINED"
      });
    }

    const request = sanitizeFundingRequest(task);
    let lastPolicyReason =
      "NO_ELIGIBLE_SPONSOR_POOL";

    for (const pool of this.pools) {
      const decision = pool.evaluate(request);

      if (!decision.eligible) {
        lastPolicyReason = decision.reason;
        continue;
      }

      const reservation = pool.reserve(request);

      if (!reservation) {
        lastPolicyReason =
          "INSUFFICIENT_SPONSOR_CREDITS";
        continue;
      }

      const grant = Object.freeze({
        funded: true,
        grantId: randomUUID(),
        poolId: pool.id,
        reservationId:
          reservation.reservationId,
        computeUnits:
          reservation.computeUnits,
        sponsorDisclosure:
          pool.sponsorDisclosure
      });

      this.#grants.set(grant.grantId, grant);
      this.#persist();

      return grant;
    }

    return Object.freeze({
      funded: false,
      reason: lastPolicyReason
    });
  }

  settle(grant, usedUnits) {
    const known = this.#grants.get(
      String(grant?.grantId)
    );

    if (!known) {
      throw new Error("unknown grant");
    }

    const pool = this.pools.find(
      (candidate) => candidate.id === known.poolId
    );

    if (!pool) {
      throw new Error("grant pool unavailable");
    }

    const settlement = pool.settle(
      known.reservationId,
      usedUnits
    );

    this.#grants.delete(known.grantId);
    this.#persist();

    return settlement;
  }

  release(grant) {
    const known = this.#grants.get(
      String(grant?.grantId)
    );

    if (!known) {
      return false;
    }

    const pool = this.pools.find(
      (candidate) => candidate.id === known.poolId
    );

    if (!pool) {
      throw new Error("grant pool unavailable");
    }

    const released = pool.release(
      known.reservationId
    );

    this.#grants.delete(known.grantId);
    this.#persist();

    return released;
  }
}

export function createReceiptKeyPair() {
  const { publicKey, privateKey } =
    generateKeyPairSync("ed25519");

  return {
    publicKey: publicKey.export({
      type: "spki",
      format: "pem"
    }),
    privateKey: privateKey.export({
      type: "pkcs8",
      format: "pem"
    })
  };
}

export function signReceipt(payload, privateKey) {
  const canonical = canonicalJson(payload);
  const signature = cryptoSign(
    null,
    Buffer.from(canonical),
    privateKey
  );

  return Object.freeze({
    ...payload,
    signature: Object.freeze({
      algorithm: "Ed25519",
      value: signature.toString("base64")
    })
  });
}

export function verifyReceipt(receipt, publicKey) {
  if (receipt?.signature?.algorithm !== "Ed25519") {
    return false;
  }

  const { signature, ...payload } = receipt;
  const canonical = canonicalJson(payload);

  return cryptoVerify(
    null,
    Buffer.from(canonical),
    publicKey,
    Buffer.from(signature.value, "base64")
  );
}

export async function executeSponsoredTask({
  task,
  broker,
  runner,
  receiptPrivateKey
}) {
  if (
    !broker ||
    typeof broker.authorize !== "function"
  ) {
    throw new TypeError("broker is required");
  }

  if (typeof runner !== "function") {
    throw new TypeError("runner is required");
  }

  const grant = broker.authorize(task);

  if (!grant.funded) {
    return Object.freeze({
      status: grant.reason,
      funded: false
    });
  }

  const modelContext = buildModelContext(task);
  const authorization =
    buildExecutionAuthorization(grant);

  let result;
  let computeUnitsUsed;
  let settlement;

  try {
    result = await runner(
      Object.freeze({
        modelContext,
        authorization
      })
    );

    computeUnitsUsed = Number(
      result?.computeUnitsUsed ?? 0
    );

    if (
      !Number.isInteger(computeUnitsUsed) ||
      computeUnitsUsed < 0 ||
      computeUnitsUsed >
        authorization.computeUnits
    ) {
      throw new Error(
        "runner reported invalid compute usage"
      );
    }

    settlement = broker.settle(
      grant,
      computeUnitsUsed
    );
  } catch (error) {
    broker.release(grant);
    throw error;
  }

  const receiptPayload = {
    schema: "sponsorrail.receipt.v0.2",
    runId: randomUUID(),
    taskId: String(task.id),
    taskClass: String(
      task.taskClass ?? "software-development"
    ),
    computeUnitsAuthorized:
      authorization.computeUnits,
    computeUnitsUsed,
    computeUnitsRefunded:
      settlement.refundUnits,
    userCostCredits: 0,
    sponsorContributionCredits:
      computeUnitsUsed,
    sponsorDisclosure:
      grant.sponsorDisclosure,
    privacy: {
      promptDisclosedToSponsor: false,
      repositoryDisclosedToSponsor: false,
      outputDisclosedToSponsor: false,
      userIdentityDisclosedToSponsor: false
    },
    inference: {
      sponsorIdentityInModelContext: false,
      sponsorInstructionsInModelContext: false
    },
    evidence: {
      modelContextSha256: createHash("sha256")
        .update(canonicalJson(modelContext))
        .digest("hex")
    },
    completed: result?.completed === true
  };

  const receipt = receiptPrivateKey
    ? signReceipt(
        receiptPayload,
        receiptPrivateKey
      )
    : Object.freeze(receiptPayload);

  return Object.freeze({
    status: "COMPLETED",
    funded: true,
    result,
    receipt
  });
}
