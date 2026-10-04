# Accounting and reservation semantics

SponsorRail uses reserve-then-settle accounting.

## Why reservation matters

Charging the full requested amount at authorization time would overcharge sponsors whenever an agent finishes early or fails before consuming its budget. SponsorRail therefore separates permission to consume compute from actual settled use.

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

## Invariants

- authorization cannot spend credits
- settlement cannot exceed the reserved amount
- a reservation can be settled or released once
- unused reserved compute returns to available balance
- failed or invalid execution is not charged
- persistent pool snapshots retain outstanding reservations
- blind persistence excludes prompt, repository context, source, and output

## v0.2 limitation

The JSON store preserves reservations across restart, but the broker's grant lookup is still process-local. A restarted broker therefore exposes an outstanding reservation in pool state but cannot yet settle it by the old grant object. Durable grant recovery, expiration, and reconciliation are the next accounting rung.
