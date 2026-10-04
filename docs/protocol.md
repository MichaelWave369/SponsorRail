# Sponsored Compute Protocol v0.4

This document describes the reference protocol. It is not yet a stable standard.

## Funding request

```json
{
  "taskId": "task-001",
  "taskClass": "software-development",
  "computeRequested": 2500,
  "userMaxCost": 0,
  "privacy": "blind"
}
```

Blind funding requests exclude prompt text, repository contents, source code, model output, and user identity.

## Durable grant

A grant binds a reservation to an opaque authorization and lease.

```json
{
  "grantId": "uuid",
  "poolId": "oss-pool",
  "reservationId": "uuid",
  "computeUnits": 2500,
  "issuedAt": "2026-10-04T22:00:00.000Z",
  "expiresAt": "2026-10-04T22:05:00.000Z"
}
```

Only `grantId` and `computeUnits` cross into the execution plane.

## Heartbeat

An active grant may be renewed before expiry.

```text
heartbeat(grant, leaseMs)
```

The broker updates both the durable grant and matching reservation. Heartbeat never increases the compute-unit authorization.

An expired grant is released and cannot be revived.

## Idempotent settlement

```text
settle(grant, usedUnits, idempotencyKey)
```

A successful settlement creates a durable settlement record.

Replaying the same grant and usage returns the original settlement result without charging again, including after broker restart.

A conflicting replay with different usage is rejected.

## Receipt commit

v0.4 splits receipt construction into:

```text
prepareReceipt(payload)
        |
        v
sign optional receipt
        |
        v
commitReceipt(receipt)
```

`commitReceipt` verifies chain integrity, appends the receipt to the durable journal, advances the chain head, and persists state.

## Receipt journal

The reference store uses newline-delimited JSON:

```text
state.json.receipts.ndjson
```

Each line is one complete receipt.

The journal is append-only through the SponsorRail API. Duplicate receipt hashes are not appended twice.

On startup, a valid journal whose tail is ahead of the state document can restore the persisted chain head.

## Receipt schema

Receipts use:

```text
sponsorrail.receipt.v0.4
```

and retain grant and task identifiers, authorized/used/refunded compute, sponsor disclosure, privacy and inference assertions, a model-context hash, chain sequence, previous receipt hash, receipt hash, and optional Ed25519 signature.

The receipt journal is evidence of runtime ordering and tamper detection. It is not a public transparency log, confidential-compute proof, or hardware-backed attestation.


## Transactional backend semantics

A conforming transactional SponsorRail backend must provide the following atomicity properties:

1. A successful grant reservation decrements available credits and increments reserved credits in the same transaction that records the durable grant.
2. A failed reservation leaves all balances unchanged.
3. Settlement moves actual usage to spent credits, refunds unused reserved credits, deletes the active grant, and records the idempotent settlement atomically.
4. Two concurrent writers cannot both reserve credits that exceed the same pool balance.
5. Receipt sequence allocation and receipt persistence occur in one transaction.

The v0.5 SQLite backend implements these properties with SQLite WAL mode and `BEGIN IMMEDIATE`.
