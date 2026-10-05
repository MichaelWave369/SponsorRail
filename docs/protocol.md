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


## Signed compute-provider usage

v0.6 defines a provider usage receipt:

```json
{
  "schema": "sponsorrail.provider-usage.v0.6",
  "usageId": "uuid",
  "providerId": "provider.example",
  "grantId": "grant-uuid",
  "usageMetric": "compute-units",
  "modelClass": "provider-model-class",
  "computeUnitsAuthorized": 2500,
  "computeUnitsUsed": 1700,
  "completed": true,
  "startedAt": "2026-10-04T22:00:00.000Z",
  "completedAt": "2026-10-04T22:01:00.000Z",
  "signature": {
    "algorithm": "Ed25519",
    "value": "base64"
  }
}
```

Before settlement, SponsorRail verifies:

1. the provider is registered and enabled
2. the Ed25519 signature is valid
3. the receipt's grant ID matches the execution authorization
4. the authorized-unit field matches the grant
5. used units are a non-negative integer no greater than authorized units
6. the usage metric matches the operator-registered provider contract

The provider receipt does not include prompt text, repository contents, source code, or model output.

The SponsorRail receipt commits to the provider receipt by SHA-256 and records whether signature verification succeeded.

### Provider trust boundary

A compute provider is not a sponsor.

The provider may receive private execution context when needed to perform computation. SponsorRail prevents sponsor metadata from crossing into that execution envelope. Provider privacy and retention policy are therefore separate from sponsor privacy and must be evaluated independently.


## Ollama adapter v0.7

The first concrete provider adapter uses Ollama's non-streaming chat API.

The request contains:

- configured model
- private task/repository context as chat messages
- `stream: false`
- runtime options
- `num_predict` clamped to the SponsorRail authorization ceiling

Sponsor identity and sponsor instructions are not included.

### Metering

Ollama exposes prompt and generated token counts. v0.7 uses generated tokens as the settlement metric:

```text
usageMetric = ollama-output-tokens
computeUnitsUsed = eval_count
```

The adapter returns prompt token counts, cached prompt tokens, and duration telemetry to the caller, but these fields do not increase sponsor settlement.

This choice makes the charged quantity pre-authorizable through `num_predict`.

### Endpoint policy

Loopback hosts are permitted by default.

Remote Ollama-compatible endpoints require explicit `allowRemote: true`. Non-loopback HTTP additionally requires explicit `allowInsecureRemote: true`; otherwise HTTPS is required.


## Provider routing v0.8

Routing operates on a sanitized request:

```json
{
  "taskId": "task-001",
  "taskClass": "software-development",
  "privacy": "blind",
  "computeRequested": 500,
  "requiredCapabilities": ["chat", "code"],
  "preferredLocality": "local",
  "maxCostPerUnit": 1
}
```

No prompt, repository context, source code, model output, sponsor identity, or provider probe payload is included.

A routing decision records:

```json
{
  "schema": "sponsorrail.routing.v0.8",
  "selectedProviderId": "provider.local",
  "score": 94.5,
  "locality": "local",
  "costPerUnit": 0,
  "priority": 2,
  "requiredCapabilities": ["chat", "code"],
  "preferredLocality": "local",
  "candidateCount": 3,
  "eligibleCount": 2
}
```

The decision may be embedded in the SponsorRail receipt as coarse selection evidence.

### Qualification order

Provider eligibility is checked before sponsor authorization. A request with no eligible provider must not reserve sponsor credits.

### Ollama discovery

The Ollama adapter may probe `GET /api/tags` to determine whether its configured model is installed. Full discovery payloads remain local to routing and are not copied into receipts.


## Safe failover v0.9

SponsorRail distinguishes retry-safe provider unavailability from ambiguous execution failure.

A provider may raise a retry-safe error carrying:

```text
safeToRetry = true
code = PROVIDER_SPECIFIC_CODE
```

The reference `ProviderUnavailableError` provides this contract.

### Failover rule

Automatic failover is allowed only when all of the following are true:

1. the selected provider failed
2. the error is explicitly marked `safeToRetry=true`
3. another eligible provider remains
4. the caller's `maxAttempts` limit has not been reached

The failed attempt releases its sponsor reservation before another provider is authorized.

Generic errors are treated as ambiguous and stop execution.

### Circuit breaker

Provider health state is one of:

```text
CLOSED
OPEN
HALF_OPEN
```

After the configured consecutive-failure threshold, the circuit enters `OPEN` until its cooldown expires.

Open circuits are routing-ineligible and are not probed.

After cooldown, the circuit becomes `HALF_OPEN`. A successful execution returns it to `CLOSED`; another failure can reopen it.

### Routing receipt evidence

v0.9 routing evidence may include:

```json
{
  "schema": "sponsorrail.routing.v0.9",
  "selectedProviderId": "provider.backup",
  "attemptCount": 2,
  "failoverUsed": true,
  "failedProviderIds": ["provider.primary"],
  "selectedCircuitState": "CLOSED"
}
```

Raw provider error messages are intentionally excluded.
