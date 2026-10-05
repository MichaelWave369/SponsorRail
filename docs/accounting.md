# Accounting and settlement semantics

SponsorRail uses reserve-then-settle accounting.

## Balance invariant

```text
available + reserved + spent = total funded credits
```

Authorization moves credits from available to reserved. Settlement moves actual usage to spent and refunds unused capacity.

## Idempotent settlement

Distributed systems sometimes perform the work correctly and then lose the response. Retrying must not spend the same sponsor credits twice.

v0.4 persists settlement records containing the idempotency key, grant ID, pool ID, reservation ID, reserved units, used units, refunded units, and settlement time.

A replay with the same grant and usage returns the original result. A replay that attempts to change usage is rejected as an idempotency conflict.

## Lease renewal

Grant heartbeats update the expiry of both the durable grant and its pool reservation. Heartbeat does not change the reserved compute amount.

An expired grant cannot be renewed.

## Failure behavior

- runner failure before settlement: release full reservation
- invalid compute report: release full reservation
- expired grant: release reservation
- valid settlement retry: return prior result, charge nothing more
- conflicting settlement retry: reject

## Current boundary

The reference JSON store is single-process. Idempotency is durable across normal restart, but not yet implemented on a database transaction with multi-writer concurrency guarantees.


## Funding provenance ledger

v0.13 adds a funding-side ledger before ordinary reserve/settle accounting.

A successful verified deposit performs one SQLite transaction:

```text
verify signed deposit
        |
        v
increase campaign available credits
        +
append funding_deposits row
        |
        v
commit
```

The credit increase and ledger record cannot intentionally commit independently.

### Provenance snapshot

`fundingSnapshot(campaignId)` distinguishes:

```text
operatorSeedCredits
verifiedDepositCount
verifiedDepositCredits
currentAvailableCredits
currentReservedCredits
currentSpentCredits
```

Operator seed credits are retained for backward compatibility and local/testing workflows. They are not represented as externally verified deposits.

### Replay safety

Exact signed-deposit replay is idempotent.

Deposit-ID mutation and duplicate external-reference minting fail closed.

This is distinct from execution settlement idempotency; SponsorRail now protects replay on both the **money-in** and **compute-spend** sides.


## Reversal and liability accounting

v0.15 adds append-only negative funding events.

Example:

```text
campaign:
available  = 6
reserved   = 15
spent      = 0
liability  = 0

verified refund = 10

after reversal:
available  = 0
reserved   = 15
spent      = 0
liability  = 4
```

The active reservation remains intact. The refund does not retroactively revoke authorized work.

If that 15-credit reservation is later released:

```text
returned reservation = 15
pay liability         = 4
newly available       = 11

final:
available  = 11
reserved   = 0
spent      = 0
liability  = 0
```

`fundingSnapshot()` now reports verified deposits, verified reversals, net verified funding, and outstanding liability separately.


## Temporary hold accounting

A hold creates two possible quantities:

```text
held credits      = amount successfully quarantined from available
unfunded credits  = provisional exposure that could not be quarantined
```

Example:

```text
available = 6
reserved  = 15

dispute hold = 10

held       = 6
unfunded   = 4
available  = 0
reserved   = 15
```

The 15-credit reservation remains valid.

Incoming campaign credits are allocated in this order:

```text
1. permanent reversal liability
2. active hold deficits
3. available balance
```

A won dispute releases the held portion and clears the provisional deficit.

A lost dispute consumes the held portion and turns the provisional deficit into permanent liability.

Campaign pool snapshots include `heldCredits` so quarantined credits remain visible in total-credit accounting.


## Funding conservation audit v0.17

SponsorRail now exposes an explicit campaign-level conservation check.

```text
economicFundingCredits
  = operatorSeedCredits
  + verifiedDepositCredits
  - verifiedReversalCredits

bookCredits
  = available
  + reserved
  + spent
  + held

liabilityAdjustedBookCredits
  = bookCredits
  - outstandingLiabilityCredits

balanceDelta
  = liabilityAdjustedBookCredits
  - economicFundingCredits
```

A healthy ledger requires:

```text
balanceDelta = 0
```

and no deposit may violate:

```text
reversedCredits
+ activeHoldCredits
<= depositCredits
```

This audit is computed from persisted tables rather than trusting cached totals.

### External source reconciliation

Funding-source statements are compared to local event totals at a signed `asOf` boundary.

A non-zero delta is retained as an auditable mismatch.

SponsorRail does not auto-credit, auto-debit, or rewrite events in response to reconciliation disagreement.
