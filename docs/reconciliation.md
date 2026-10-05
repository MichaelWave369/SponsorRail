# Funding reconciliation

SponsorRail v0.17 adds two complementary audit mechanisms.

## 1. Internal conservation audit

`auditCampaignFunding(campaignId)` asks whether SponsorRail's own tables still agree.

The core identity is:

```text
operator seed
+ verified deposits
- verified reversals
=
available
+ reserved
+ spent
+ held
- outstanding liability
```

The audit also checks every verified deposit:

```text
permanent reversals
+ active holds
<= original deposit credits
```

A report is healthy only when the balance delta is zero and no exposure ceiling is violated.

## 2. External funding-source reconciliation

A registered funding source can issue a signed statement for one campaign.

The statement contains SponsorRail-credit totals, not fiat balances:

```text
deposited credits
reversed credits
active hold credits
as-of time
```

SponsorRail compares those totals with its own source-specific event ledger.

## Historical as-of semantics

Reconciliation is historical, not merely "whatever the tables look like now."

Deposits and reversals are included only when their occurrence time is at or before the statement time.

A hold is considered active at statement time when:

```text
hold placed <= asOf

AND

no hold resolution occurred <= asOf
```

This means a dispute resolved today can still correctly appear as active in yesterday's reconciliation.

## Match and mismatch

Example match:

```text
external:
deposited = 100
reversed  = 20
holds     = 10

local:
deposited = 100
reversed  = 20
holds     = 10

MATCH
```

Example mismatch:

```text
external deposited = 100
local deposited    = 90

delta = -10

MISMATCH
```

A mismatch is persisted as evidence.

It does not automatically mint 10 credits.

## Why reconciliation is read-only

External systems can be late, duplicated, partially unavailable, misconfigured, or compromised.

Automatic financial correction from a single disagreement would turn an audit signal into authority.

SponsorRail therefore keeps:

```text
OBSERVATION != AUTHORITY
```

The operator or a future governed correction protocol decides what happens next.

## Replay safety

Each statement has a durable statement ID.

Exact signed replay returns the recorded reconciliation.

A different signed statement reusing the same ID fails closed.

## Source isolation

Statements are reconciled by:

```text
source ID
campaign ID
asset
as-of time
```

Funding from another registered source does not affect that source's reconciliation totals.

## Stripe boundary

v0.17 does not call Stripe APIs.

The existing Stripe adapter consumes signed webhook evidence.

A future Stripe reconciliation adapter can fetch authoritative processor records and issue a normal signed SponsorRail statement through this generic contract.

## Current limitations

- no live Stripe account/payout retrieval
- no automatic corrective journal entry
- no multi-machine consensus around SQLite
- no WORM/externally notarized reconciliation archive
- no fiat-denominated general ledger

Those should be added explicitly rather than smuggled into a credit-reconciliation feature.
