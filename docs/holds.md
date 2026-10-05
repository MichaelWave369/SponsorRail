# Temporary funding holds

SponsorRail v0.16 models funding that is at risk but not yet permanently lost.

## Why a hold exists

A dispute can remain unresolved while an agent system continues operating.

Treating the dispute as no event is risky because contested credits remain spendable.

Treating it immediately as a permanent reversal is also inaccurate because the sponsor may win.

A hold provides the middle state.

## Placement

`placeFundingHold()` verifies a signed hold against the original deposit.

The ledger proves:

```text
same source
same campaign
same asset
reversals + active holds <= original deposit
```

SponsorRail removes as much of the hold as possible from available credits.

It never touches reserved or spent balances.

## Provisional deficit

If a 10-credit hold arrives when only 6 credits are available:

```text
held = 6
unfunded = 4
```

The four-credit deficit is provisional exposure, not permanent liability.

Campaign authorization remains blocked while any hold deficit is uncovered.

## Credit allocation order

Every credit moving toward availability follows:

```text
permanent liability
       |
       v
active hold deficits
       |
       v
available
```

This applies to new deposits, released grants, expired reservations, and unused settlement refunds.

## Release

A winning dispute resolves the hold with:

```text
outcome = release
reason  = dispute_won
```

The held credits return through the normal allocation gate.

The provisional deficit disappears because the risk no longer exists.

## Reverse

A lost dispute resolves the hold with:

```text
outcome = reverse
reason  = dispute_loss
```

Held credits are consumed.

Unfunded hold credits become permanent campaign liability.

The resolution also creates the permanent reversal ledger entry, so finalized loss appears in `verifiedReversalCredits`.

## Persistence and replay

Hold state and hold resolutions survive restart.

Exact hold and resolution replays are idempotent.

A different signed payload reusing the same hold or resolution ID fails closed.

## Concurrency

SQLite uses the same `BEGIN IMMEDIATE` serialization as other SponsorRail money-state transitions.

Independent processes racing the same signed hold can quarantine the campaign exactly once.

## Current boundary

v0.16 does not invent automatic hold expiry.

External processors and funding sources differ in how long provisional risk can remain valid. A future policy layer can add source-specific expiry only when its semantics are explicit and testable.
