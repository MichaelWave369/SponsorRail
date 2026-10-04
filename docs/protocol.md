# Sponsored Compute Protocol v0.1

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

## Broker grant

```json
{
  "funded": true,
  "grantId": "broker-generated-uuid",
  "poolId": "oss-pool",
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

## Receipt

Receipts use schema identifier `sponsorrail.receipt.v0.1` and record authorized/used compute, user cost, sponsor contribution, disclosure text, privacy assertions, inference assertions, completion state, and an Ed25519 signature when signing is enabled.

The receipt is evidence of funding behavior, not proof of confidential computing. Stronger attestation mechanisms are future work.
