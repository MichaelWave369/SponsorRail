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

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
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
  #balance;

  constructor({
    id,
    sponsorDisclosure,
    balanceCredits,
    eligibleTaskClasses = ["*"]
  }) {
    if (!id || !sponsorDisclosure) {
      throw new TypeError("pool id and sponsorDisclosure are required");
    }

    assertPositiveInteger(balanceCredits, "balanceCredits");

    this.id = String(id);
    this.sponsorDisclosure = String(sponsorDisclosure);
    this.eligibleTaskClasses = Object.freeze([...eligibleTaskClasses]);
    this.#balance = balanceCredits;
  }

  get balanceCredits() {
    return this.#balance;
  }

  approve(request) {
    if (containsForbiddenFundingKey(request)) {
      throw new Error("blind sponsor pool received forbidden private task data");
    }

    const eligible =
      this.eligibleTaskClasses.includes("*") ||
      this.eligibleTaskClasses.includes(request.taskClass);

    if (!eligible || this.#balance < request.computeRequested) {
      return null;
    }

    this.#balance -= request.computeRequested;

    return Object.freeze({
      poolId: this.id,
      computeUnits: request.computeRequested
    });
  }
}

export class FundingBroker {
  constructor(pools = []) {
    this.pools = [...pools];
  }

  authorize(task) {
    if (task.allowSponsorship === false) {
      return Object.freeze({
        funded: false,
        reason: "SPONSORSHIP_DECLINED"
      });
    }

    const request = sanitizeFundingRequest(task);

    for (const pool of this.pools) {
      const approval = pool.approve(request);
      if (!approval) continue;

      return Object.freeze({
        funded: true,
        grantId: randomUUID(),
        poolId: approval.poolId,
        computeUnits: approval.computeUnits,
        sponsorDisclosure: pool.sponsorDisclosure
      });
    }

    return Object.freeze({
      funded: false,
      reason: "NO_ELIGIBLE_SPONSOR_POOL"
    });
  }
}

export function createReceiptKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");

  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" })
  };
}

export function signReceipt(payload, privateKey) {
  const canonical = canonicalJson(payload);
  const signature = cryptoSign(null, Buffer.from(canonical), privateKey);

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
  if (!broker || typeof broker.authorize !== "function") {
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
  const authorization = buildExecutionAuthorization(grant);

  const result = await runner(
    Object.freeze({
      modelContext,
      authorization
    })
  );

  const computeUnitsUsed = Number(result?.computeUnitsUsed ?? 0);
  if (
    !Number.isInteger(computeUnitsUsed) ||
    computeUnitsUsed < 0 ||
    computeUnitsUsed > authorization.computeUnits
  ) {
    throw new Error("runner reported invalid compute usage");
  }

  const receiptPayload = {
    schema: "sponsorrail.receipt.v0.1",
    runId: randomUUID(),
    taskId: String(task.id),
    taskClass: String(task.taskClass ?? "software-development"),
    computeUnitsAuthorized: authorization.computeUnits,
    computeUnitsUsed,
    userCostCredits: 0,
    sponsorContributionCredits: computeUnitsUsed,
    sponsorDisclosure: grant.sponsorDisclosure,
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
    ? signReceipt(receiptPayload, receiptPrivateKey)
    : Object.freeze(receiptPayload);

  return Object.freeze({
    status: "COMPLETED",
    funded: true,
    result,
    receipt
  });
}
