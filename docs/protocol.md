# Sponsored Compute Protocol v0.2

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

## Reservation

When a pool accepts a request, requested compute moves from `availableCredits` to `reservedCredits`. It is not yet counted as spent.

```json
{
  "reservationId": "pool-generated-uuid",
  "taskId": "task-001",
  "taskClass": "software-development",
  "privacy": "blind",
  "computeUnits": 2500
}
```

## Broker grant

```json
{
  "funded": true,
  "grantId": "broker-generated-uuid",
  "poolId": "oss-pool",
  "reservationId": "pool-generated-uuid",
  "computeUnits": 2500,
  "sponsorDisclosure": "ExampleCloud"
}
```

The full grant remains in the funding plane.

## Execution authorization

```json
{
  "grantId": "broker-generated-uuid",
  "computeUnits": 2500
}
```

This is the only funding-derived object passed into the execution plane.

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

If execution throws or usage is invalid, the reference broker releases the reservation in full.

## Receipt

Receipts use schema identifier `sponsorrail.receipt.v0.2`. They record authorized, used, and refunded compute; user cost; sponsor contribution; disclosure text; privacy assertions; inference assertions; completion state; and an Ed25519 signature when signing is enabled.

The receipt is evidence of reference-runtime behavior, not proof of confidential computing. Stronger attestation mechanisms remain future work.
