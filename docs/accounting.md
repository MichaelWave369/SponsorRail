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
