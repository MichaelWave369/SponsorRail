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

  verify(receipt) {
    if (
      receipt?.schema !==
      "sponsorrail.funding-deposit.v0.13"
    ) {
      return false;
    }

    const source =
      this.get(
        receipt.sourceId
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

    return verifyReceipt(
      receipt,
      source.publicKey
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
        isoNow(this.now)
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
