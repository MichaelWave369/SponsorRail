import {
  createHmac,
  timingSafeEqual
} from "node:crypto";

import {
  SignedFundingSource
} from "../funding.js";

const ACCEPTED_EVENTS =
  new Set([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded"
  ]);

const REFUND_EVENTS =
  new Set([
    "refund.created",
    "refund.updated"
  ]);

function normalizeRawBody(
  rawBody
) {
  if (
    typeof rawBody ===
    "string"
  ) {
    return Buffer.from(
      rawBody,
      "utf8"
    );
  }

  if (
    Buffer.isBuffer(rawBody)
  ) {
    return rawBody;
  }

  if (
    rawBody instanceof
      Uint8Array
  ) {
    return Buffer.from(
      rawBody
    );
  }

  throw new TypeError(
    "rawBody must be a string, Buffer, or Uint8Array"
  );
}

function parseStripeSignature(
  header
) {
  if (
    !header ||
    typeof header !==
      "string"
  ) {
    throw new TypeError(
      "Stripe-Signature header is required"
    );
  }

  const timestamps = [];
  const v1 = [];

  for (
    const part
    of header.split(",")
  ) {
    const separator =
      part.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key =
      part
        .slice(0, separator)
        .trim();

    const value =
      part
        .slice(separator + 1)
        .trim();

    if (key === "t") {
      const timestamp =
        Number(value);

      if (
        Number.isInteger(
          timestamp
        )
      ) {
        timestamps.push(
          timestamp
        );
      }
    }

    if (
      key === "v1" &&
      /^[0-9a-fA-F]{64}$/
        .test(value)
    ) {
      v1.push(
        value.toLowerCase()
      );
    }
  }

  if (
    timestamps.length === 0 ||
    v1.length === 0
  ) {
    throw new Error(
      "invalid Stripe-Signature header"
    );
  }

  return {
    timestamp:
      timestamps[0],
    signatures: v1
  };
}

function secureHexEqual(
  a,
  b
) {
  const left =
    Buffer.from(a, "hex");

  const right =
    Buffer.from(b, "hex");

  if (
    left.length !==
    right.length
  ) {
    return false;
  }

  return timingSafeEqual(
    left,
    right
  );
}

export function verifyStripeWebhookSignature({
  rawBody,
  signatureHeader,
  webhookSecret,
  toleranceSeconds = 300,
  now = () => Date.now()
}) {
  if (!webhookSecret) {
    throw new TypeError(
      "webhookSecret is required"
    );
  }

  if (
    !Number.isInteger(
      toleranceSeconds
    ) ||
    toleranceSeconds <= 0
  ) {
    throw new TypeError(
      "toleranceSeconds must be a positive integer"
    );
  }

  if (
    typeof now !== "function"
  ) {
    throw new TypeError(
      "now must be a function"
    );
  }

  const body =
    normalizeRawBody(
      rawBody
    );

  const parsed =
    parseStripeSignature(
      signatureHeader
    );

  const nowSeconds =
    Math.floor(
      Number(now()) /
      1000
    );

  if (
    !Number.isFinite(
      nowSeconds
    )
  ) {
    throw new TypeError(
      "Stripe webhook clock must return milliseconds"
    );
  }

  if (
    Math.abs(
      nowSeconds -
      parsed.timestamp
    ) >
    toleranceSeconds
  ) {
    return false;
  }

  const signedPayload =
    Buffer.concat([
      Buffer.from(
        String(
          parsed.timestamp
        ),
        "utf8"
      ),
      Buffer.from(
        ".",
        "utf8"
      ),
      body
    ]);

  const expected =
    createHmac(
      "sha256",
      String(webhookSecret)
    )
      .update(
        signedPayload
      )
      .digest("hex");

  return parsed
    .signatures
    .some(
      (signature) =>
        secureHexEqual(
          expected,
          signature
        )
    );
}

function normalizeCreditRates(
  value
) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new TypeError(
      "creditsPerMinorUnit is required"
    );
  }

  const entries =
    Object.entries(value);

  if (
    entries.length === 0
  ) {
    throw new TypeError(
      "creditsPerMinorUnit cannot be empty"
    );
  }

  const result = {};

  for (
    const [currency, rate]
    of entries
  ) {
    if (
      !/^[a-zA-Z]{3}$/
        .test(currency) ||
      !Number.isInteger(rate) ||
      rate <= 0
    ) {
      throw new TypeError(
        "currency rates must map 3-letter codes to positive integer credits"
      );
    }

    result[
      currency.toLowerCase()
    ] = rate;
  }

  return Object.freeze(
    result
  );
}

function assertCheckoutSession(
  event
) {
  if (
    !event ||
    typeof event !== "object" ||
    !event.id ||
    !ACCEPTED_EVENTS.has(
      event.type
    )
  ) {
    throw new Error(
      "unsupported Stripe event"
    );
  }

  const session =
    event.data?.object;

  if (
    !session ||
    session.object !==
      "checkout.session" ||
    !session.id
  ) {
    throw new Error(
      "Stripe event does not contain a Checkout Session"
    );
  }

  if (
    session.mode !==
      "payment"
  ) {
    throw new Error(
      "Stripe Checkout Session must use payment mode"
    );
  }

  if (
    session.payment_status !==
      "paid"
  ) {
    throw new Error(
      "Stripe Checkout Session is not paid"
    );
  }

  if (
    !Number.isInteger(
      session.amount_total
    ) ||
    session.amount_total <= 0
  ) {
    throw new Error(
      "Stripe Checkout Session amount_total must be positive"
    );
  }

  if (
    typeof session.currency !==
      "string"
  ) {
    throw new Error(
      "Stripe Checkout Session currency is required"
    );
  }

  if (
    !Number.isInteger(
      session.created
    ) ||
    session.created <= 0
  ) {
    throw new Error(
      "Stripe Checkout Session created timestamp is required"
    );
  }

  if (
    typeof session.payment_intent !==
      "string" ||
    !session.payment_intent
  ) {
    throw new Error(
      "Stripe Checkout Session payment_intent is required"
    );
  }

  return session;
}

export class StripeCheckoutFundingAdapter {
  constructor({
    webhookSecret,
    sourceId =
      "stripe.checkout",
    privateKey,
    campaignId,
    creditsPerMinorUnit,
    requiredLivemode =
      false,
    maxCreditsPerDeposit =
      null,
    toleranceSeconds =
      300,
    now =
      () => Date.now()
  }) {
    if (!webhookSecret) {
      throw new TypeError(
        "webhookSecret is required"
      );
    }

    if (!campaignId) {
      throw new TypeError(
        "campaignId is required"
      );
    }

    if (
      requiredLivemode !==
        null &&
      typeof requiredLivemode !==
        "boolean"
    ) {
      throw new TypeError(
        "requiredLivemode must be boolean or null"
      );
    }

    if (
      maxCreditsPerDeposit !==
        null &&
      (
        !Number.isInteger(
          maxCreditsPerDeposit
        ) ||
        maxCreditsPerDeposit <=
          0
      )
    ) {
      throw new TypeError(
        "maxCreditsPerDeposit must be a positive integer"
      );
    }

    this.webhookSecret =
      String(webhookSecret);

    this.campaignId =
      String(campaignId);

    this.creditRates =
      normalizeCreditRates(
        creditsPerMinorUnit
      );

    this.requiredLivemode =
      requiredLivemode;

    this.maxCreditsPerDeposit =
      maxCreditsPerDeposit;

    this.toleranceSeconds =
      toleranceSeconds;

    this.now = now;

    this.source =
      new SignedFundingSource({
        sourceId,
        privateKey,
        asset:
          "compute-credits",
        now
      });
  }

  #parseVerifiedEvent({
    rawBody,
    signatureHeader
  }) {
    if (
      !verifyStripeWebhookSignature({
        rawBody,
        signatureHeader,
        webhookSecret:
          this.webhookSecret,
        toleranceSeconds:
          this.toleranceSeconds,
        now:
          this.now
      })
    ) {
      throw new Error(
        "Stripe webhook signature verification failed"
      );
    }

    let event;

    try {
      event =
        JSON.parse(
          normalizeRawBody(
            rawBody
          ).toString("utf8")
        );
    } catch {
      throw new Error(
        "Stripe webhook body is not valid JSON"
      );
    }

    if (
      this.requiredLivemode !==
        null &&
      event.livemode !==
        this.requiredLivemode
    ) {
      throw new Error(
        "Stripe webhook livemode mismatch"
      );
    }

    return event;
  }

  #creditsFor(
    amountMinor,
    currency
  ) {
    if (
      !Number.isInteger(
        amountMinor
      ) ||
      amountMinor <= 0
    ) {
      throw new Error(
        "Stripe amount must be positive"
      );
    }

    const normalizedCurrency =
      String(currency)
        .toLowerCase();

    const rate =
      this.creditRates[
        normalizedCurrency
      ];

    if (
      rate === undefined
    ) {
      throw new Error(
        "Stripe currency is not configured for SponsorRail credits"
      );
    }

    const credits =
      amountMinor *
      rate;

    if (
      !Number.isSafeInteger(
        credits
      ) ||
      credits <= 0
    ) {
      throw new Error(
        "Stripe funding conversion produced invalid credits"
      );
    }

    if (
      this.maxCreditsPerDeposit !==
        null &&
      credits >
        this.maxCreditsPerDeposit
    ) {
      throw new Error(
        "Stripe deposit exceeds configured credit ceiling"
      );
    }

    return {
      currency:
        normalizedCurrency,
      credits
    };
  }

  handleWebhook({
    rawBody,
    signatureHeader
  }) {
    const event =
      this.#parseVerifiedEvent({
        rawBody,
        signatureHeader
      });

    const session =
      assertCheckoutSession(
        event
      );

    const {
      currency,
      credits
    } =
      this.#creditsFor(
        session.amount_total,
        session.currency
      );

    const occurredAt =
      session.created *
      1000;

    const depositReceipt =
      this.source
        .issueDeposit({
          campaignId:
            this.campaignId,
          credits,
          depositId:
            `stripe-checkout:${session.id}`,
          externalReference:
            `stripe-payment-intent:${session.payment_intent}`,
          occurredAt
        });

    return Object.freeze({
      accepted: true,
      stripe: Object.freeze({
        eventId:
          String(event.id),
        eventType:
          String(event.type),
        checkoutSessionId:
          String(session.id),
        paymentIntentId:
          String(
            session.payment_intent
          ),
        livemode:
          event.livemode ===
          true,
        currency,
        amountMinor:
          session.amount_total
      }),
      credits,
      depositReceipt
    });
  }

  handleAndDeposit({
    rawBody,
    signatureHeader,
    broker,
    fundingSourceRegistry
  }) {
    if (
      !broker ||
      typeof broker.depositCampaign !==
        "function"
    ) {
      throw new TypeError(
        "broker with depositCampaign() is required"
      );
    }

    const mapped =
      this.handleWebhook({
        rawBody,
        signatureHeader
      });

    const deposit =
      broker.depositCampaign(
        mapped.depositReceipt,
        fundingSourceRegistry
      );

    return Object.freeze({
      ...mapped,
      deposit
    });
  }

  handleReversalWebhook({
    rawBody,
    signatureHeader,
    broker,
    fundingSourceRegistry
  }) {
    if (
      !broker ||
      typeof broker
        .applyFundingReversal !==
        "function" ||
      typeof broker
        .findFundingDepositByExternalReference !==
        "function"
    ) {
      throw new TypeError(
        "broker with reversal funding APIs is required"
      );
    }

    const event =
      this.#parseVerifiedEvent({
        rawBody,
        signatureHeader
      });

    const object =
      event.data?.object;

    let reason;
    let reversalId;
    let externalReference;
    let paymentIntentId;
    let amountMinor;
    let currency;
    let occurredAt;

    if (
      REFUND_EVENTS.has(
        event.type
      )
    ) {
      if (
        !object ||
        object.object !==
          "refund" ||
        !object.id
      ) {
        throw new Error(
          "Stripe refund event does not contain a Refund"
        );
      }

      if (
        object.status !==
          "succeeded"
      ) {
        return Object.freeze({
          accepted: false,
          ignored: true,
          reason:
            "REFUND_NOT_SUCCEEDED",
          stripeEventId:
            String(event.id)
        });
      }

      if (
        typeof object.payment_intent !==
          "string" ||
        !object.payment_intent
      ) {
        throw new Error(
          "Stripe Refund payment_intent is required"
        );
      }

      reason = "refund";
      reversalId =
        `stripe-refund:${object.id}`;
      externalReference =
        `stripe-refund:${object.id}`;
      paymentIntentId =
        object.payment_intent;
      amountMinor =
        object.amount;
      currency =
        object.currency;
      occurredAt =
        object.created;
    } else if (
      event.type ===
        "charge.dispute.closed"
    ) {
      if (
        !object ||
        object.object !==
          "dispute" ||
        !object.id
      ) {
        throw new Error(
          "Stripe dispute event does not contain a Dispute"
        );
      }

      if (
        object.status !==
          "lost"
      ) {
        return Object.freeze({
          accepted: false,
          ignored: true,
          reason:
            "DISPUTE_NOT_LOST",
          stripeEventId:
            String(event.id),
          disputeStatus:
            String(
              object.status ??
              "unknown"
            )
        });
      }

      if (
        typeof object.payment_intent !==
          "string" ||
        !object.payment_intent
      ) {
        throw new Error(
          "Stripe Dispute payment_intent is required"
        );
      }

      reason =
        "dispute_loss";
      reversalId =
        `stripe-dispute:${object.id}`;
      externalReference =
        `stripe-dispute:${object.id}`;
      paymentIntentId =
        object.payment_intent;
      amountMinor =
        object.amount;
      currency =
        object.currency;
      occurredAt =
        object.created;
    } else {
      return Object.freeze({
        accepted: false,
        ignored: true,
        reason:
          "UNSUPPORTED_REVERSAL_EVENT",
        stripeEventId:
          String(
            event.id ??
            "unknown"
          )
      });
    }

    if (
      !Number.isInteger(
        occurredAt
      ) ||
      occurredAt <= 0
    ) {
      throw new Error(
        "Stripe reversal created timestamp is required"
      );
    }

    const {
      currency:
        normalizedCurrency,
      credits
    } =
      this.#creditsFor(
        amountMinor,
        currency
      );

    const originalDeposit =
      broker
        .findFundingDepositByExternalReference(
          this.source.sourceId,
          `stripe-payment-intent:${paymentIntentId}`
        );

    if (!originalDeposit) {
      throw new Error(
        "no matching SponsorRail Stripe deposit"
      );
    }

    const reversalReceipt =
      this.source
        .issueReversal({
          originalDepositId:
            originalDeposit.depositId,
          campaignId:
            originalDeposit.campaignId,
          credits,
          reason,
          reversalId,
          externalReference,
          occurredAt:
            occurredAt * 1000
        });

    const reversal =
      broker
        .applyFundingReversal(
          reversalReceipt,
          fundingSourceRegistry
        );

    return Object.freeze({
      accepted: true,
      stripe: Object.freeze({
        eventId:
          String(event.id),
        eventType:
          String(event.type),
        objectId:
          String(object.id),
        paymentIntentId:
          String(paymentIntentId),
        livemode:
          event.livemode === true,
        currency:
          normalizedCurrency,
        amountMinor
      }),
      credits,
      reversalReceipt,
      reversal
    });
  }
}
