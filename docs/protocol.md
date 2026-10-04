# Sponsored Compute Protocol v0.3

This document describes the reference message shapes. It is not yet a stable standard.

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

No prompt, repository content, source code, output, or user identity is allowed in a blind funding request.

## Pool policy

```json
{
  "eligibleTaskClasses": ["software-development"],
  "allowedPrivacyModes": ["blind"],
  "maxComputePerGrant": 5000
}
```

Policy matching operates only on fields already allowed into the funding plane.

## Reservation lease

When a pool accepts a request, requested compute moves from `availableCredits` to `reservedCredits`.

```json
{
  "reservationId": "pool-generated-uuid",
  "taskId": "task-001",
  "taskClass": "software-development",
  "privacy": "blind",
  "computeUnits": 2500,
  "issuedAt": "2026-10-04T21:00:00.000Z",
  "expiresAt": "2026-10-04T21:05:00.000Z"
}
```

Authorization is not spending.

## Durable broker grant

```json
{
  "funded": true,
  "grantId": "broker-generated-uuid",
  "poolId": "oss-pool",
  "reservationId": "pool-generated-uuid",
  "taskId": "task-001",
  "taskClass": "software-development",
  "privacy": "blind",
  "computeUnits": 2500,
  "sponsorDisclosure": "ExampleCloud",
  "issuedAt": "2026-10-04T21:00:00.000Z",
  "expiresAt": "2026-10-04T21:05:00.000Z"
}
```

The durable grant remains in the funding plane and is persisted with pool state.

## Execution authorization

```json
{
  "grantId": "broker-generated-uuid",
  "computeUnits": 2500
}
```

This is the only funding-derived object passed into the execution plane.

## Recovery

A broker started with an empty pool list and a configured store reconstructs:

- pool balances and reservations
- active durable grants
- receipt-chain sequence and head hash

Recovered active grants can be settled or released using the same grant ID.

## Reconciliation

Reconciliation checks:

1. grants whose pool no longer exists
2. grants whose reservation no longer exists
3. expired grants
4. reservations without a matching grant

Expired grants release their reservations. Unexpired orphan reservations are reported and retained. Expired orphan reservations are released.

## Settlement

If 1700 of 2500 reserved units are used:

```json
{
  "reservedUnits": 2500,
  "usedUnits": 1700,
  "refundUnits": 800
}
```

The pool moves 1700 units to `spentCredits` and returns 800 to `availableCredits`.

## Receipt chain

Receipts use schema identifier `sponsorrail.receipt.v0.3`.

```json
{
  "chain": {
    "sequence": 42,
    "previousReceiptHash": "hex-or-null",
    "receiptHash": "hex"
  }
}
```

The receipt hash commits to the receipt payload, previous receipt hash, and sequence. The broker persists only the latest chain sequence and head hash. Receipts may additionally carry an Ed25519 signature.

`verifyReceiptHash` checks one receipt's hash commitment. `verifyReceiptChain` checks hash integrity and adjacency for an ordered receipt set.

The chain is evidence of ordering and tamper detection in the reference runtime. It is not hardware-backed attestation or a public transparency log.
