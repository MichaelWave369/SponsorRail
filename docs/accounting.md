# Accounting and reservation semantics

SponsorRail uses reserve-then-settle accounting with durable grant leases.

## Why reservation matters

Charging the full requested amount at authorization time would overcharge sponsors whenever an agent finishes early or fails before consuming its budget. SponsorRail separates permission to consume compute from actual settled use.

## State transitions

For a pool with 100 credits and a task requesting 25:

```text
AVAILABLE 100 | RESERVED 0  | SPENT 0
       authorize 25
AVAILABLE 75  | RESERVED 25 | SPENT 0
       use 17 and settle
AVAILABLE 83  | RESERVED 0  | SPENT 17
```

If the runner fails before valid settlement:

```text
AVAILABLE 75  | RESERVED 25 | SPENT 0
       release
AVAILABLE 100 | RESERVED 0  | SPENT 0
```

## Durable authorization

v0.3 persists the active grant and its reservation together in the same store document. A restarted broker can recover the grant and settle it later.

## Lease expiry

Every new grant has `issuedAt` and `expiresAt`. Reconciliation releases expired grants so abandoned work cannot reserve sponsor funds forever.

The reference lease is fixed at authorization time. Heartbeat and renewal semantics are not yet implemented.

## Orphan handling

An orphan reservation is a reservation without a matching durable grant.

SponsorRail handles orphans conservatively:

- unexpired orphan: report and retain
- expired orphan: release and refund

This avoids turning a transient persistence inconsistency into premature reclamation.

## Invariants

- authorization cannot spend credits
- settlement cannot exceed reserved compute
- unused reserved compute returns to available balance
- failed or invalid execution is not charged
- active grants survive restart
- expired grants cannot settle
- expired grants release reserved credits
- unexpired orphans are not silently reclaimed
- expired orphans are reclaimed
- blind persistence excludes prompt, repository context, source, and output

## Current limitation

The JSON store is still single-process. Durable state solves restart recovery, not distributed consensus. Multi-process concurrency and transactional database adapters remain future work.
