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
