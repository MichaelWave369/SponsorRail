# Stripe Checkout funding adapter

SponsorRail v0.14 connects Stripe Checkout to the generic signed funding-deposit protocol.

## Scope

This adapter handles **payment evidence**, not the entire Stripe product surface.

It verifies paid Checkout webhook events and converts them into SponsorRail funding deposits.

It does not:

- create Checkout Sessions
- create prices/products
- store card data
- reconcile Stripe payouts
- process refunds or disputes
- automatically reverse SponsorRail credits

Those are separate lifecycle problems and should not be hidden inside the webhook mapper.

## Webhook input

Pass the original raw HTTP request body plus the `Stripe-Signature` header:

```js
adapter.handleWebhook({
  rawBody,
  signatureHeader
});
```

Do not parse and re-stringify the JSON before verification.

## Accepted events

```text
checkout.session.completed
checkout.session.async_payment_succeeded
```

The Checkout Session must be a one-time payment with `payment_status=paid`.

This allows immediate Checkout payments and delayed Checkout payments to converge on the same funding path.

## Configuration

```js
new StripeCheckoutFundingAdapter({
  webhookSecret,
  sourceId: "stripe.checkout",
  privateKey,
  campaignId: "open-source-builds",
  creditsPerMinorUnit: {
    usd: 2
  },
  requiredLivemode: false,
  maxCreditsPerDeposit: 100000
});
```

### Currency conversion

`creditsPerMinorUnit` is a SponsorRail product rule.

For example:

```text
Stripe amount_total = 500
currency = usd
rate = 2 credits per minor unit

SponsorRail deposit = 1000 credits
```

This does not represent an FX conversion. It is simply the operator's mapping from paid minor units to SponsorRail compute credits.

## Campaign binding

The adapter is configured with one campaign ID.

It does not trust Checkout metadata to select the destination campaign.

For multiple campaigns, use separately configured adapters/endpoints or a future audited dispatch layer.

## Test/live protection

The default is:

```text
requiredLivemode = false
```

A live webhook therefore fails until the operator explicitly changes the adapter to:

```js
requiredLivemode: true
```

## Idempotency

The funding identity is the Checkout Session:

```text
stripe-checkout:cs_...
```

Stripe can retry webhook events. Delayed-payment flows can also emit different Checkout events over the same Session lifecycle.

If multiple accepted success deliveries describe the same paid Checkout Session and amount, they produce the same SponsorRail signed deposit.

The SQLite ledger therefore credits the campaign exactly once.

## End-to-end application

```js
const result =
  adapter.handleAndDeposit({
    rawBody,
    signatureHeader,
    broker,
    fundingSourceRegistry
  });
```

This:

1. verifies the Stripe webhook
2. maps it to SponsorRail credits
3. issues an Ed25519 SponsorRail funding receipt
4. verifies that funding source through the normal registry
5. applies the deposit transactionally to the campaign ledger

## Security notes

Keep these credentials separate:

- Stripe webhook signing secret
- SponsorRail funding-source private key

A compromise of one trust boundary should not automatically become a credential for the other.

## Current limitations

v0.14 does not model refunds, disputes, chargebacks, payout settlement, taxes as separate SponsorRail ledger events, or Stripe Connect account attribution.

Those deserve explicit reversal/reconciliation semantics rather than pretending money only travels in one direction forever.
