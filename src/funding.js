import {
  randomUUID
} from "node:crypto";

import {
  createReceiptKeyPair,
  signReceipt,
  verifyReceipt
} from "./sponsorrail.js";

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

function isoNow(now) {
  const value =
    Number(now());

  if (
    !Number.isFinite(value) ||
    value < 0
  ) {
    throw new TypeError(
      "funding clock must return milliseconds"
    );
  }

  return new Date(value)
    .toISOString();
}

function normalizeOccurredAt(
  occurredAt,
  now
) {
  if (
    occurredAt === null ||
    occurredAt === undefined
  ) {
    return isoNow(now);
  }

  if (
    typeof occurredAt ===
      "string"
  ) {
    const parsed =
      Date.parse(
        occurredAt
      );

    if (
      !Number.isFinite(
        parsed
      )
    ) {
      throw new TypeError(
        "occurredAt must be a valid time"
      );
    }

    return new Date(parsed)
      .toISOString();
  }

  const milliseconds =
    occurredAt instanceof Date
      ? occurredAt.getTime()
      : Number(occurredAt);

  if (
    !Number.isFinite(
      milliseconds
    ) ||
    milliseconds < 0
  ) {
    throw new TypeError(
      "occurredAt must be a valid time"
    );
  }

  return new Date(
    milliseconds
  ).toISOString();
}

export function createFundingSourceKeyPair() {
  return createReceiptKeyPair();
}

export class FundingSourceRegistry {
  #sources;

  constructor(entries = []) {
    this.#sources =
      new Map();

    for (const entry of entries) {
      this.register(entry);
    }
  }

  register({
    sourceId,
    publicKey,
    asset =
      "compute-credits",
    enabled = true,
    replace = false
  }) {
    if (
      !sourceId ||
      !publicKey
    ) {
      throw new TypeError(
        "sourceId and publicKey are required"
      );
    }

    const id =
      String(sourceId);

    if (
      this.#sources.has(id) &&
      !replace
    ) {
      throw new Error(
        "funding source already registered"
      );
    }

    const record =
      Object.freeze({
        sourceId: id,
        publicKey:
          String(publicKey),
        asset:
          String(asset),
        enabled:
          enabled === true
      });

    this.#sources.set(
      id,
      record
    );

    return record;
  }

  get(sourceId) {
    return (
      this.#sources.get(
        String(sourceId)
      ) ??
      null
    );
  }

  #verifySourceAndSignature(
    receipt
  ) {
    const source =
      this.get(
        receipt?.sourceId
      );

    if (
      !source ||
      !source.enabled
    ) {
      return false;
    }

    if (
      receipt.asset !==
      source.asset
    ) {
      return false;
    }

    return verifyReceipt(
      receipt,
      source.publicKey
    );
  }

  verify(receipt) {
    if (
      receipt?.schema !==
      "sponsorrail.funding-deposit.v0.13"
    ) {
      return false;
    }

    if (
      !receipt.depositId ||
      !receipt.campaignId
    ) {
      return false;
    }

    if (
      !Number.isInteger(
        receipt.credits
      ) ||
      receipt.credits <= 0
    ) {
      return false;
    }

    return this
      .#verifySourceAndSignature(
        receipt
      );
  }

  verifyReversal(receipt) {
    if (
      receipt?.schema !==
      "sponsorrail.funding-reversal.v0.15"
    ) {
      return false;
    }

    if (
      !receipt.reversalId ||
      !receipt.originalDepositId ||
      !receipt.campaignId
    ) {
      return false;
    }

    if (
      ![
        "refund",
        "dispute_loss",
        "chargeback",
        "adjustment"
      ].includes(
        receipt.reason
      )
    ) {
      return false;
    }

    if (
      !Number.isInteger(
        receipt.credits
      ) ||
      receipt.credits <= 0
    ) {
      return false;
    }

    return this
      .#verifySourceAndSignature(
        receipt
      );
  }

  verifyHold(receipt) {
    if (
      receipt?.schema !==
      "sponsorrail.funding-hold.v0.16"
    ) {
      return false;
    }

    if (
      !receipt.holdId ||
      !receipt.originalDepositId ||
      !receipt.campaignId
    ) {
      return false;
    }

    if (
      ![
        "dispute",
        "review",
        "risk"
      ].includes(
        receipt.reason
      )
    ) {
      return false;
    }

    if (
      !Number.isInteger(
        receipt.credits
      ) ||
      receipt.credits <= 0
    ) {
      return false;
    }

    return this
      .#verifySourceAndSignature(
        receipt
      );
  }

  verifyHoldResolution(receipt) {
    if (
      receipt?.schema !==
      "sponsorrail.funding-hold-resolution.v0.16"
    ) {
      return false;
    }

    if (
      !receipt.resolutionId ||
      !receipt.holdId ||
      !receipt.originalDepositId ||
      !receipt.campaignId
    ) {
      return false;
    }

    if (
      ![
        "release",
        "reverse"
      ].includes(
        receipt.outcome
      )
    ) {
      return false;
    }

    if (
      receipt.outcome ===
        "reverse" &&
      receipt.reason !==
        "dispute_loss"
    ) {
      return false;
    }

    if (
      receipt.outcome ===
        "release" &&
      receipt.reason !==
        "dispute_won"
    ) {
      return false;
    }

    return this
      .#verifySourceAndSignature(
        receipt
      );
  }

  verifyStatement(receipt) {
    if (
      receipt?.schema !==
      "sponsorrail.funding-statement.v0.17"
    ) {
      return false;
    }

    if (
      !receipt.statementId ||
      !receipt.campaignId ||
      !receipt.asOf ||
      !Number.isFinite(
        Date.parse(
          String(
            receipt.asOf
          )
        )
      )
    ) {
      return false;
    }

    for (
      const value
      of [
        receipt.depositedCredits,
        receipt.reversedCredits,
        receipt.activeHoldCredits
      ]
    ) {
      if (
        !Number.isInteger(value) ||
        value < 0
      ) {
        return false;
      }
    }

    if (
      receipt.reversedCredits >
        receipt.depositedCredits ||
      receipt.activeHoldCredits >
        (
          receipt.depositedCredits -
          receipt.reversedCredits
        )
    ) {
      return false;
    }

    return this
      .#verifySourceAndSignature(
        receipt
      );
  }
}

export class SignedFundingSource {
  constructor({
    sourceId,
    privateKey,
    asset =
      "compute-credits",
    now =
      () => Date.now()
  }) {
    if (
      !sourceId ||
      !privateKey
    ) {
      throw new TypeError(
        "sourceId and privateKey are required"
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

    this.sourceId =
      String(sourceId);

    this.privateKey =
      privateKey;

    this.asset =
      String(asset);

    this.now = now;
  }

  issueDeposit({
    campaignId,
    credits,
    depositId =
      randomUUID(),
    externalReference =
      null,
    occurredAt =
      null
  }) {
    if (!campaignId) {
      throw new TypeError(
        "campaignId is required"
      );
    }

    assertPositiveInteger(
      credits,
      "credits"
    );

    const payload = {
      schema:
        "sponsorrail.funding-deposit.v0.13",
      depositId:
        String(depositId),
      sourceId:
        this.sourceId,
      campaignId:
        String(campaignId),
      asset:
        this.asset,
      credits,
      externalReference:
        externalReference ===
          null
          ? null
          : String(
              externalReference
            ),
      occurredAt:
        normalizeOccurredAt(
          occurredAt,
          this.now
        )
    };

    return signReceipt(
      payload,
      this.privateKey
    );
  }

  issueReversal({
    originalDepositId,
    campaignId,
    credits,
    reason,
    reversalId =
      randomUUID(),
    externalReference =
      null,
    occurredAt =
      null
  }) {
    if (
      !originalDepositId ||
      !campaignId
    ) {
      throw new TypeError(
        "originalDepositId and campaignId are required"
      );
    }

    if (
      ![
        "refund",
        "dispute_loss",
        "chargeback",
        "adjustment"
      ].includes(reason)
    ) {
      throw new TypeError(
        "unsupported funding reversal reason"
      );
    }

    assertPositiveInteger(
      credits,
      "credits"
    );

    const payload = {
      schema:
        "sponsorrail.funding-reversal.v0.15",
      reversalId:
        String(
          reversalId
        ),
      sourceId:
        this.sourceId,
      originalDepositId:
        String(
          originalDepositId
        ),
      campaignId:
        String(
          campaignId
        ),
      asset:
        this.asset,
      credits,
      reason:
        String(reason),
      externalReference:
        externalReference ===
          null
          ? null
          : String(
              externalReference
            ),
      occurredAt:
        normalizeOccurredAt(
          occurredAt,
          this.now
        )
    };

    return signReceipt(
      payload,
      this.privateKey
    );
  }

  issueHold({
    originalDepositId,
    campaignId,
    credits,
    reason =
      "dispute",
    holdId =
      randomUUID(),
    externalReference =
      null,
    occurredAt =
      null
  }) {
    if (
      !originalDepositId ||
      !campaignId
    ) {
      throw new TypeError(
        "originalDepositId and campaignId are required"
      );
    }

    if (
      ![
        "dispute",
        "review",
        "risk"
      ].includes(reason)
    ) {
      throw new TypeError(
        "unsupported funding hold reason"
      );
    }

    assertPositiveInteger(
      credits,
      "credits"
    );

    const payload = {
      schema:
        "sponsorrail.funding-hold.v0.16",
      holdId:
        String(holdId),
      sourceId:
        this.sourceId,
      originalDepositId:
        String(
          originalDepositId
        ),
      campaignId:
        String(
          campaignId
        ),
      asset:
        this.asset,
      credits,
      reason:
        String(reason),
      externalReference:
        externalReference ===
          null
          ? null
          : String(
              externalReference
            ),
      occurredAt:
        normalizeOccurredAt(
          occurredAt,
          this.now
        )
    };

    return signReceipt(
      payload,
      this.privateKey
    );
  }

  issueHoldResolution({
    holdId,
    originalDepositId,
    campaignId,
    outcome,
    reason,
    resolutionId =
      randomUUID(),
    externalReference =
      null,
    occurredAt =
      null
  }) {
    if (
      !holdId ||
      !originalDepositId ||
      !campaignId
    ) {
      throw new TypeError(
        "holdId, originalDepositId, and campaignId are required"
      );
    }

    if (
      ![
        "release",
        "reverse"
      ].includes(outcome)
    ) {
      throw new TypeError(
        "unsupported funding hold outcome"
      );
    }

    const expectedReason =
      outcome === "release"
        ? "dispute_won"
        : "dispute_loss";

    if (
      reason !==
      expectedReason
    ) {
      throw new TypeError(
        "funding hold resolution reason does not match outcome"
      );
    }

    const payload = {
      schema:
        "sponsorrail.funding-hold-resolution.v0.16",
      resolutionId:
        String(
          resolutionId
        ),
      sourceId:
        this.sourceId,
      holdId:
        String(holdId),
      originalDepositId:
        String(
          originalDepositId
        ),
      campaignId:
        String(
          campaignId
        ),
      asset:
        this.asset,
      outcome:
        String(outcome),
      reason:
        String(reason),
      externalReference:
        externalReference ===
          null
          ? null
          : String(
              externalReference
            ),
      occurredAt:
        normalizeOccurredAt(
          occurredAt,
          this.now
        )
    };

    return signReceipt(
      payload,
      this.privateKey
    );
  }

  issueStatement({
    campaignId,
    depositedCredits,
    reversedCredits,
    activeHoldCredits,
    statementId =
      randomUUID(),
    asOf =
      null
  }) {
    if (!campaignId) {
      throw new TypeError(
        "campaignId is required"
      );
    }

    for (
      const [name, value]
      of [
        [
          "depositedCredits",
          depositedCredits
        ],
        [
          "reversedCredits",
          reversedCredits
        ],
        [
          "activeHoldCredits",
          activeHoldCredits
        ]
      ]
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

    if (
      reversedCredits >
        depositedCredits
    ) {
      throw new TypeError(
        "reversedCredits cannot exceed depositedCredits"
      );
    }

    if (
      activeHoldCredits >
        (
          depositedCredits -
          reversedCredits
        )
    ) {
      throw new TypeError(
        "activeHoldCredits exceeds remaining funded credits"
      );
    }

    const payload = {
      schema:
        "sponsorrail.funding-statement.v0.17",
      statementId:
        String(statementId),
      sourceId:
        this.sourceId,
      campaignId:
        String(campaignId),
      asset:
        this.asset,
      depositedCredits,
      reversedCredits,
      activeHoldCredits,
      asOf:
        normalizeOccurredAt(
          asOf,
          this.now
        )
    };

    return signReceipt(
      payload,
      this.privateKey
    );
  }
}

export function verifyFundingDeposit(
  receipt,
  registry
) {
  if (
    !registry ||
    typeof registry.verify !==
      "function"
  ) {
    throw new TypeError(
      "funding source registry is required"
    );
  }

  return registry.verify(
    receipt
  );
}


export function verifyFundingReversal(
  receipt,
  registry
) {
  if (
    !registry ||
    typeof registry
      .verifyReversal !==
      "function"
  ) {
    throw new TypeError(
      "funding source registry is required"
    );
  }

  return registry
    .verifyReversal(
      receipt
    );
}


export function verifyFundingHold(
  receipt,
  registry
) {
  if (
    !registry ||
    typeof registry.verifyHold !==
      "function"
  ) {
    throw new TypeError(
      "funding source registry is required"
    );
  }

  return registry.verifyHold(
    receipt
  );
}

export function verifyFundingHoldResolution(
  receipt,
  registry
) {
  if (
    !registry ||
    typeof registry
      .verifyHoldResolution !==
      "function"
  ) {
    throw new TypeError(
      "funding source registry is required"
    );
  }

  return registry
    .verifyHoldResolution(
      receipt
    );
}


export function verifyFundingStatement(
  receipt,
  registry
) {
  if (
    !registry ||
    typeof registry
      .verifyStatement !==
      "function"
  ) {
    throw new TypeError(
      "funding source registry is required"
    );
  }

  return registry
    .verifyStatement(
      receipt
    );
}
