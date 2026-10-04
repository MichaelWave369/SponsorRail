# Durable grants and recovery

SponsorRail v0.3 introduces durable grant leases.

## Goal

A sponsor authorization should not disappear because the broker process restarts.

A durable grant binds:

- grant ID
- pool ID
- reservation ID
- coarse task metadata
- authorized compute
- sponsor disclosure
- issue time
- expiry time

No prompt, repository content, source code, or model output is included.

## Startup recovery

When `FundingBroker` is constructed with no explicit pools and a `JsonPoolStore`, it restores:

- pool snapshots
- active grants
- receipt-chain head state

It then reconciles the recovered state by default.

## Reconciliation outcomes

`broker.reconcile()` returns four collections:

- `expiredGrants`
- `staleGrants`
- `orphanReservations`
- `releasedOrphans`

A stale grant references a missing pool or reservation and is removed from the active grant registry.

An orphan reservation is retained until its lease expires. Once expired it is released back to available sponsor credits.

## Why not instantly release every orphan?

Because a missing grant record does not prove that work stopped. Reclaiming an unexpired reservation could allow the same sponsor credits to fund two concurrent jobs.

Expiry provides the conservative safety boundary.

## Next hardening steps

Future work should add:

- grant heartbeat and renewal
- idempotent settlement keys
- append-only grant transition journal
- transactional database adapters
- multi-process locking
- external provider settlement receipts
