import {
  createHmac
} from "node:crypto";

import {
  FundingSourceRegistry,
  StripeCheckoutFundingAdapter,
  createFundingSourceKeyPair,
  verifyFundingDeposit
} from "../src/index.js";

const webhookSecret =
  "whsec_demo";

const timestamp = 1000;

const event = {
  id: "evt_demo",
  object: "event",
  created: timestamp,
  livemode: false,
  type:
    "checkout.session.completed",
  data: {
    object: {
      id: "cs_demo",
      object:
        "checkout.session",
      payment_intent:
        "pi_demo",
      created: 900,
      mode: "payment",
      payment_status:
        "paid",
      amount_total: 500,
      currency: "usd"
    }
  }
};

const rawBody =
  JSON.stringify(event);

const signature =
  createHmac(
    "sha256",
    webhookSecret
  )
    .update(
      `${timestamp}.${rawBody}`
    )
    .digest("hex");

const keys =
  createFundingSourceKeyPair();

const adapter =
  new StripeCheckoutFundingAdapter({
    webhookSecret,
    sourceId:
      "stripe.checkout.demo",
    privateKey:
      keys.privateKey,
    campaignId:
      "demo-campaign",
    creditsPerMinorUnit: {
      usd: 2
    },
    now:
      () => 1_000_000
  });

const registry =
  new FundingSourceRegistry([
    {
      sourceId:
        "stripe.checkout.demo",
      publicKey:
        keys.publicKey
    }
  ]);

const mapped =
  adapter.handleWebhook({
    rawBody,
    signatureHeader:
      `t=${timestamp},v1=${signature}`
  });

console.log(
  "Stripe event:",
  mapped.stripe
);

console.log(
  "Credits:",
  mapped.credits
);

console.log(
  "SponsorRail funding receipt valid:",
  verifyFundingDeposit(
    mapped.depositReceipt,
    registry
  )
);
