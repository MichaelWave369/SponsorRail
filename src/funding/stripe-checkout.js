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
      null,
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

  handleWebhook({
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

    const session =
      assertCheckoutSession(
        event
      );

    const currency =
      session.currency
        .toLowerCase();

    const rate =
      this.creditRates[
        currency
      ];

    if (
      rate === undefined
    ) {
      throw new Error(
        "Stripe currency is not configured for SponsorRail credits"
      );
    }

    const credits =
      session.amount_total *
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

    const depositReceipt =
      this.source
        .issueDeposit({
          campaignId:
            this.campaignId,
          credits,
          depositId:
            `stripe-checkout:${session.id}`,
          externalReference:
            `stripe-checkout:${session.id}`
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
}
