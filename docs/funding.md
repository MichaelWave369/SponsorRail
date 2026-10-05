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
