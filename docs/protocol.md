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


## Durable provider health v0.10

The optional SQLite health backend persists provider circuit state independently from sponsor accounting.

Persisted health fields include:

- provider ID
- successes
- failures
- consecutive failures
- last failure code
- last failure timestamp
- last success timestamp
- circuit-open expiry
- half-open lease expiry

No prompt, repository content, source code, model output, sponsor identity, or raw error message is stored.

### Shared circuit policy

A health database records one circuit policy:

```text
failureThreshold
cooldownMs
halfOpenLeaseMs
```

Independent processes opening the same health database must use the same policy. Conflicting configuration fails closed.

### Half-open execution lease

A half-open provider may be tested by at most one cooperating router process at a time.

```text
tryAcquireHalfOpen(providerId)
```

The acquisition is transactional under SQLite `BEGIN IMMEDIATE`.

A successful provider execution clears the circuit and lease. A provider failure records the failure and reopens the circuit when the configured threshold applies. An abandoned half-open lease expires automatically.

### Routing schema

v0.10 routing decisions use:

```text
sponsorrail.routing.v0.10
```

SponsorRail execution receipts use:

```text
sponsorrail.receipt.v0.10
```


## Sponsored capability campaigns v0.11

A campaign describes funding policy and user-visible benefit without adding execution authority.

```json
{
  "schema": "sponsorrail.campaign.v0.11",
  "campaignId": "open-source-builds",
  "sponsorDisclosure": "ExampleCloud",
  "capabilityType": "compute",
  "benefitDescription": "Funds open-source agent compute",
  "targetingMode": "universal",
  "budgetCredits": 100,
  "eligibleTaskClasses": ["*"],
  "allowedPrivacyModes": ["blind"],
  "maxComputePerGrant": 25
}
```

Campaign funding metadata carried into grants and receipts is restricted to coarse fields and non-coercion assertions.

### Contextual targeting

`targetingMode=contextual` may match the coarse task class only when the user/application explicitly supplies `allowContextual=true`.

Prompt text, repository context, source code, and output are never campaign-matching inputs.

### Non-coercion assertions

A conforming v0.11 campaign must resolve to:

```text
interactionRequired = false
dismissible = true
dataShared = none
influence = none
```

Campaigns violating those assertions are rejected before a sponsor pool is created.


## Transactional campaign persistence v0.12

The SQLite funding backend stores campaign contracts in a dedicated `sponsor_campaigns` table linked one-to-one with their backing sponsor pools.

Campaign creation is atomic: the pool and campaign row either both commit or neither does.

Campaign grants snapshot safe campaign funding metadata into the durable grant row so receipt evidence survives later campaign changes.

### Authorization separation

Generic `authorize(task)` excludes campaign-owned pools.

Campaign funding must use `authorizeCampaign(task, preferences)` or configure the broker with explicit `campaignPreferences`.

This preserves contextual opt-in and campaign blocking/capability controls.

### Migration

Existing SQLite grant tables are upgraded with:

```text
campaign_json TEXT NULL
```

Old grants remain valid and simply carry no campaign metadata.


## Signed funding deposits v0.13

A trusted funding source may issue:

```json
{
  "schema": "sponsorrail.funding-deposit.v0.13",
  "depositId": "uuid",
  "sourceId": "source.example",
  "campaignId": "open-source-builds",
  "asset": "compute-credits",
  "credits": 2500,
  "externalReference": "payment-or-grant-reference",
  "occurredAt": "2026-10-05T02:00:00.000Z",
  "signature": {
    "algorithm": "Ed25519",
    "value": "base64"
  }
}
```

The operator registers trusted funding-source public keys in `FundingSourceRegistry`.

Before a campaign balance changes, SponsorRail verifies:

1. the source is registered and enabled
2. the asset matches the registered source contract
3. the Ed25519 signature is valid
4. credits are a positive integer
5. the destination campaign exists

### Deposit idempotency

`depositId` is the primary replay key.

Replaying the identical signed receipt returns an idempotent result and does not add credits again.

A different signed payload reusing the same deposit ID is rejected.

When `externalReference` is present, the pair `(sourceId, externalReference)` is also unique, preventing one external payment/grant from being minted twice under different deposit IDs.

### Provenance limits

Deposit provenance demonstrates that a verified source attested to adding credits to a campaign pool.

It is not a claim that a later execution consumed a specific payment lot. Pool credits remain fungible in v0.13.


## Stripe Checkout funding adapter v0.14

The Stripe adapter consumes the raw webhook body and `Stripe-Signature` header.

Signature verification covers the original raw payload and webhook timestamp. Parsed/re-serialized JSON is not an acceptable substitute for the raw body.

The adapter recognizes these success events:

```text
checkout.session.completed
checkout.session.async_payment_succeeded
```

A recognized event must contain a Checkout Session with:

```text
object = checkout.session
mode = payment
payment_status = paid
created = positive Unix timestamp
amount_total = positive integer minor units
currency = configured 3-letter currency
```

### Credit conversion

The operator configures integer credits per Stripe minor currency unit:

```js
{
  usd: 2
}
```

A paid amount of 500 USD minor units therefore produces 1000 SponsorRail credits in that configuration.

This is protocol configuration, not a currency-exchange-rate claim.

### Campaign binding

One adapter instance is bound to one SponsorRail campaign ID.

The campaign destination is not selected from Stripe customer metadata or Checkout metadata.

### Live-mode gate

The adapter defaults to test-mode webhooks.

Production use requires explicit `requiredLivemode: true`.

### Deposit identity

A Checkout Session ID is the stable funding identity:

```text
stripe-checkout:<session-id>
```

Webhook event IDs are recorded as Stripe transport evidence but do not create separate funding lots for the same Checkout Session.


## Funding reversal protocol v0.15

```json
{
  "schema": "sponsorrail.funding-reversal.v0.15",
  "reversalId": "uuid",
  "sourceId": "source.example",
  "originalDepositId": "deposit-uuid",
  "campaignId": "campaign-1",
  "asset": "compute-credits",
  "credits": 500,
  "reason": "refund",
  "externalReference": "refund-reference",
  "occurredAt": "2026-10-05T04:00:00.000Z",
  "signature": {
    "algorithm": "Ed25519",
    "value": "base64"
  }
}
```

A conforming funding ledger must reject:

1. untrusted or disabled funding sources
2. invalid signatures
3. unknown original deposits
4. source/campaign/asset mismatch with the original deposit
5. aggregate reversals exceeding original deposit credits
6. mutated replay under the same reversal ID
7. duplicate non-null external reversal references

Exact replay of the same signed reversal is idempotent.

### Campaign liability

A campaign with outstanding funding liability is ineligible for new campaign authorization.

Credits returned from grant release or unused settlement, as well as new deposits, must pay liability before becoming available for new work.


## Temporary funding hold protocol v0.16

Hold receipt:

```json
{
  "schema": "sponsorrail.funding-hold.v0.16",
  "holdId": "hold-uuid",
  "sourceId": "source.example",
  "originalDepositId": "deposit-uuid",
  "campaignId": "campaign-1",
  "asset": "compute-credits",
  "credits": 500,
  "reason": "dispute",
  "externalReference": "processor-dispute-id",
  "occurredAt": "2026-10-05T05:00:00.000Z",
  "signature": {
    "algorithm": "Ed25519",
    "value": "base64"
  }
}
```

Resolution receipt:

```json
{
  "schema": "sponsorrail.funding-hold-resolution.v0.16",
  "resolutionId": "resolution-uuid",
  "sourceId": "source.example",
  "holdId": "hold-uuid",
  "originalDepositId": "deposit-uuid",
  "campaignId": "campaign-1",
  "asset": "compute-credits",
  "outcome": "release",
  "reason": "dispute_won",
  "externalReference": "processor-resolution-id",
  "occurredAt": "2026-10-20T05:00:00.000Z",
  "signature": {
    "algorithm": "Ed25519",
    "value": "base64"
  }
}
```

Hold placement and resolution are idempotent.

### Exposure ceiling

For one original deposit:

```text
permanent reversals
+ active holds
<= original deposit credits
```

This prevents a provisional hold and a permanent reversal from independently claiming the same funding twice.


## Signed funding statement v0.17

```json
{
  "schema": "sponsorrail.funding-statement.v0.17",
  "statementId": "statement-uuid",
  "sourceId": "source.example",
  "campaignId": "campaign-1",
  "asset": "compute-credits",
  "depositedCredits": 2500,
  "reversedCredits": 200,
  "activeHoldCredits": 300,
  "asOf": "2026-10-05T06:00:00.000Z",
  "signature": {
    "algorithm": "Ed25519",
    "value": "base64"
  }
}
```

Constraints:

```text
depositedCredits >= 0
reversedCredits >= 0
activeHoldCredits >= 0
reversedCredits <= depositedCredits
activeHoldCredits <= depositedCredits - reversedCredits
```

The statement is source-specific and campaign-specific.

### Reconciliation report

`reconcileFundingStatement()` persists:

```text
statement identity
statement hash
external totals
local totals as-of statement time
per-field deltas
matched boolean
report hash
recorded time
```

Exact signed-statement replay is idempotent.

A different signed payload reusing the same statement ID is an idempotency conflict.

Reconciliation reports never alter funding balances.
