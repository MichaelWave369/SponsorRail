# Funding provenance

SponsorRail v0.13 introduces signed funding-source deposits.

## Why this exists

Until v0.13, a sponsor pool could have credits but SponsorRail had no protocol-level evidence describing where newly added credits came from.

That is adequate for simulations. It is inadequate once real money, cloud credits, grants, or patron funding are involved.

## Roles

### Funding source

A funding source is an operator-trusted adapter that has already decided an external funding event is valid.

Examples can eventually include:

- card/payment processor settlement
- cloud-credit grants
- open-source sponsorship funds
- research grants
- organization budget allocations

The generic SponsorRail protocol does not hard-code any of them.

### FundingSourceRegistry

The operator registers each trusted source ID with an Ed25519 public key and expected asset type.

A signed-looking receipt from an unknown source is rejected.

## Signed deposit receipt

`SignedFundingSource.issueDeposit()` produces a fixed-schema receipt containing only:

- deposit ID
- funding source ID
- campaign ID
- asset type
- credits
- optional external reference
- occurrence timestamp
- Ed25519 signature

It has no field for prompt text, repository contents, source code, model output, sponsor instructions, or user identity.

## Atomic deposit

`SqliteFundingBroker.depositCampaign()` verifies the funding receipt before opening its write transaction.

Inside the transaction it:

1. checks for an existing deposit ID
2. validates destination campaign existence
3. rejects duplicate external references
4. increases the campaign pool's available credits
5. inserts the immutable funding-deposit row
6. commits

If any step fails, the balance change rolls back.

## Idempotency

Exact replay:

```text
deposit A -> +25
deposit A again -> +0
```

Mutated replay:

```text
deposit ID A / 25 credits
deposit ID A / 250 credits

=> conflict
```

External-reference replay:

```text
deposit A / payment P
deposit B / payment P

=> rejected
```

## Concurrency

Two independent processes can race the same signed deposit against one SQLite database.

Exactly one applies the credit. The other returns an idempotent replay result.

## Operator seed vs verified funding

Campaign `budgetCredits` remains an operator-seeded starting balance for compatibility.

Verified deposits are tracked separately.

`fundingSnapshot()` exposes both so a UI or auditor can distinguish simulated/operator seed credits from externally attested top-ups.

## What v0.13 does not claim

This is not yet payment processing.

SponsorRail verifies an adapter's signed statement that credits should be added. The adapter remains responsible for validating its external rail.

The protocol also does not yet trace individual spend to specific deposit lots. Credits inside a campaign pool remain fungible.

A future Stripe/payment adapter can sit above this contract rather than modifying it.


## First external adapter: Stripe Checkout

v0.14 adds a Stripe Checkout funding adapter above the generic signed funding-source contract.

The adapter does not change the deposit ledger. Its job is narrower:

1. verify Stripe's webhook evidence
2. validate a paid Checkout Session
3. convert the signed payment amount into SponsorRail credits under an operator-configured policy
4. issue the normal SponsorRail signed funding deposit
5. optionally pass that deposit directly to the SQLite funding ledger

The destination campaign is configured on the adapter rather than read from arbitrary Checkout metadata.

The credit amount is derived from Stripe's `amount_total` and currency. Metadata cannot override the funded amount.

### Deterministic payment identity

Each Checkout Session maps to:

```text
depositId = stripe-checkout:<session-id>
externalReference = stripe-checkout:<session-id>
```

This makes webhook retry idempotency line up with SponsorRail deposit idempotency.


## Funding reversals v0.15

`SignedFundingSource.issueReversal()` creates a signed negative adjustment referencing one original funding deposit.

A reversal records:

- reversal ID
- funding source ID
- original deposit ID
- campaign ID
- asset
- credits
- reason
- optional external reference
- occurrence timestamp
- Ed25519 signature

Supported generic reasons are `refund`, `dispute_loss`, `chargeback`, and `adjustment`.

A reversal must come from the same funding source, campaign, and asset as the original deposit.

Aggregate reversals cannot exceed the original deposit's credits.

### Liability

If a reversal is larger than currently available campaign credits, SponsorRail debits all available credits and records the remainder as funding liability.

It does not reduce reserved credits or rewrite spent history.

Returned reservations, settlement refunds, and new deposits flow through the same liability gate: liability is paid before credits become newly available.


## Temporary funding holds v0.16

A funding hold represents provisional loss exposure without claiming that the funding has permanently reversed.

`SignedFundingSource.issueHold()` signs:

- hold ID
- source ID
- original deposit ID
- campaign ID
- asset
- credits
- reason
- optional external reference
- occurrence timestamp

A hold is bounded by the remaining unreversed and unheld portion of its original deposit.

### Hold resolutions

`issueHoldResolution()` supports two final outcomes:

```text
release + dispute_won
reverse + dispute_loss
```

A release returns quarantined credits through the normal liability/hold allocation gate.

A reverse converts the hold into a permanent reversal. Any part of the hold that could not originally be quarantined becomes permanent campaign liability.


## Funding-source reconciliation v0.17

A trusted funding source can issue a signed statement representing its own SponsorRail-credit view for one campaign as of one timestamp.

The statement reports:

```text
depositedCredits
reversedCredits
activeHoldCredits
```

`activeHoldCredits` is total unresolved hold exposure, not only the portion currently quarantined from available balance.

SponsorRail verifies the funding-source signature before comparison.

### Reconciliation is read-only

A reconciliation mismatch never changes campaign balances.

It is persisted as evidence for operator review or a later explicit corrective workflow.

### Historical comparison

Reconciliation queries deposits and reversals up to the statement's `asOf` time.

Active holds are reconstructed from hold placement and resolution timestamps, so a hold that was open at statement time remains part of that historical comparison even if it has since resolved.
