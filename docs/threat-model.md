# Threat Model v0.1

SponsorRail assumes sponsors may be economically motivated to learn about users or influence agent behavior. The design therefore treats sponsor data as untrusted input that must not cross the execution boundary.

## Protected assets

- user prompts
- repository and source contents
- model outputs
- user identity in blind mode
- model independence from sponsor influence
- integrity of metering and receipts

## Threats addressed by the reference implementation

### Prompt leakage through funding requests

Mitigation: funding requests are constructed from an explicit allowlist of coarse fields.

### Sponsor instruction injection

Mitigation: execution authorization contains only a broker-minted grant ID and compute-unit limit. Sponsor identity and sponsor instructions are excluded.

### Receipt leakage

Mitigation: receipts contain task identifiers, coarse class, metering, disclosure, and privacy assertions but no prompt, repository context, or output.

### Fake or altered receipts

Mitigation: receipts may be signed with Ed25519 and independently verified.

### Compute over-claiming by a runner

Mitigation: reported usage above the authorized amount is rejected.

## Not solved in v0.1

- payment settlement
- Sybil resistance
- fraud detection
- confidential-compute attestation
- remote model-provider telemetry
- sponsor marketplace collusion
- jurisdiction-specific advertising compliance
- unlinkability between funding and execution services
- production key management

These are explicit future qualification gates, not implied guarantees.


## Compute-provider threats added in v0.6

### Provider over-reporting

Threat: a provider claims more usage than was authorized.

Mitigation: usage receipts are grant-bound and rejected when used units exceed the authorization ceiling.

### Forged provider identity

Threat: an untrusted actor submits a signed-looking usage record.

Mitigation: SponsorRail accepts only Ed25519 receipts from operator-registered provider public keys.

### Receipt substitution

Threat: a valid provider receipt from one grant is replayed against another.

Mitigation: verification binds provider usage to the exact grant ID and authorized compute amount.

### Provider result leakage into sponsor evidence

Threat: prompt, source, or model output is copied into funding receipts.

Mitigation: provider usage receipts use an explicit coarse schema and SponsorRail stores only a SHA-256 commitment to that receipt.

### Remote-provider privacy

A remote compute provider may necessarily receive the execution context. v0.6 does not claim confidential inference. Sponsor privacy and provider privacy are separate trust boundaries.


## Ollama adapter threats added in v0.7

### Accidental remote disclosure

Threat: an operator believes Ollama is local while configuration points to a remote endpoint.

Mitigation: non-loopback endpoints are rejected unless `allowRemote=true`. Remote plaintext HTTP is rejected unless separately opted into.

### Model substitution

Threat: configuration silently switches to an unintended model.

Mitigation: the configured model must be present in the adapter's model allowlist.

### Unbounded generation

Threat: a provider generates more billable output than the grant permits.

Mitigation: `num_predict` is clamped to the authorization ceiling and reported `eval_count` is independently checked after completion.

### Hung local inference

Threat: a stalled Ollama request holds sponsor credits indefinitely.

Mitigation: the adapter aborts after a configurable timeout and SponsorRail releases the reservation on provider failure.


## Routing threats added in v0.8

### Prompt leakage into routing

Threat: provider selection becomes a hidden second consumer of private task text.

Mitigation: the routing request is constructed from an explicit allowlist of coarse fields and excludes prompt/repository contents.

### Sponsor-influenced provider selection

Threat: sponsor identity changes which model/provider is selected.

Mitigation: sponsor identity is absent from the routing request and router inputs.

### Stale provider availability

Threat: a provider passes discovery and becomes unavailable before execution.

Mitigation: provider execution still fails closed and releases sponsor reservations. Discovery is treated as point-in-time evidence, not a guarantee.

### Probe-data leakage

Threat: provider discovery returns model inventories or infrastructure details that end up in public receipts.

Mitigation: receipts record only coarse routing evidence. Raw probe payloads stay outside receipt construction.

### Cost-only routing

Threat: the cheapest provider is selected despite privacy or capability mismatch.

Mitigation: privacy, capability, compute, and explicit cost limits are eligibility gates. Price affects ranking only among eligible providers.


## Failover threats added in v0.9

### Duplicate execution

Threat: a provider completes work but the response is lost, causing SponsorRail to run the task again elsewhere.

Mitigation: automatic failover requires explicit `safeToRetry=true`. Generic timeouts and uncertain transport failures stop instead of rerunning.

### Failing-provider storm

Threat: every new task repeatedly probes or executes against a known-bad provider.

Mitigation: consecutive failures open a circuit. Open providers are routing-ineligible and are not probed until cooldown.

### Circuit poisoning

Threat: one transient failure permanently removes a provider.

Mitigation: failure threshold and cooldown are configurable. Expired circuits become half-open and can recover on success.

### Error leakage

Threat: provider error text contains infrastructure details or private material and is copied into receipts.

Mitigation: receipts record provider IDs and coarse failure/failover facts, not raw error messages.

### Sponsor credit stacking

Threat: multiple failover attempts reserve sponsor credits simultaneously.

Mitigation: each failed attempt releases its reservation before the next provider is authorized.


## Durable health threats added in v0.10

### Circuit amnesia

Threat: restarting a router clears knowledge that a provider is failing.

Mitigation: the SQLite health backend persists circuit history and expiry state.

### Recovery stampede

Threat: many processes observe an expired cooldown and simultaneously test the same half-open provider.

Mitigation: transactional half-open execution lease. Only one cooperating process may claim the recovery trial at a time.

### Policy disagreement

Threat: separate processes interpret the same health rows using different failure thresholds or cooldowns.

Mitigation: the SQLite health database persists the circuit policy and rejects conflicting configuration.

### Abandoned half-open lease

Threat: the process holding a half-open trial crashes before reporting success or failure.

Mitigation: half-open leases expire automatically and may be reacquired after expiry.

### Health database disclosure

Threat: operational health storage becomes a side channel for private task content.

Mitigation: durable health rows contain only provider IDs, counters, coarse failure codes, timestamps, and lease/circuit expiry values.


## Sponsor-campaign threats added in v0.11

### Manufactured inconvenience

Threat: the free tier is deliberately made worse so sponsorship can sell relief.

Mitigation: campaign validation rejects forced viewing, countdowns, required interaction, autoplay, and non-dismissible sponsor experiences.

### Sponsor instruction injection

Threat: sponsor copy or preferences become model instructions.

Mitigation: sponsor instructions are prohibited by campaign validation, and execution authorization continues to contain only grant ID and compute units.

### Behavioral targeting through prompts

Threat: private prompt contents are analyzed to choose a sponsor.

Mitigation: campaign matching receives only task class, privacy mode, compute request, and explicit user preferences. Contextual targeting is opt-in.

### Recommendation capture

Threat: sponsorship changes provider/model/product recommendations.

Mitigation: campaign experience must declare `influence=none` and `rankingInfluence=false`; violations fail validation.

### Hidden data exchange

Threat: sponsorship silently trades user data for compute.

Mitigation: v0.11 campaign contract requires `dataShared=none` and rejects prompt, repository, output, or identity access.


## SQLite campaign threats added in v0.12

### Contextual opt-in bypass

Threat: a contextual campaign is persisted as a normal pool and later selected by generic authorization.

Mitigation: generic SQLite authorization explicitly excludes campaign-owned pools. Campaign pools require campaign-aware authorization.

### Partial campaign creation

Threat: a campaign row exists without its funding pool, or a pool exists without its campaign contract.

Mitigation: campaign row and pool are created in one SQLite write transaction.

### Concurrent campaign overspend

Threat: multiple processes simultaneously reserve more credits than the campaign budget.

Mitigation: campaign authorization uses the same transactional conditional balance update used by ordinary SQLite funding.

### Campaign evidence loss after restart

Threat: a funded grant survives restart but loses which campaign paid for it.

Mitigation: safe campaign funding metadata is snapshotted into the durable grant's `campaign_json` field.


## Funding provenance threats added in v0.13

### Forged top-up

Threat: an attacker invents campaign credits.

Mitigation: campaign deposits require a valid Ed25519 receipt from an enabled operator-registered funding source.

### Deposit replay

Threat: the same valid deposit receipt is submitted repeatedly.

Mitigation: deposit IDs are durable primary keys and exact replay is idempotent.

### Reference reminting

Threat: one external payment/grant is represented by multiple deposit IDs.

Mitigation: non-null external references are unique per funding source.

### Deposit mutation

Threat: a valid deposit ID is reused with a larger amount or different campaign.

Mitigation: the canonical signed receipt hash must match the existing ledger entry; otherwise SponsorRail raises an idempotency conflict.

### False per-task provenance

Threat: a pool-level deposit is presented as proof that a specific external payment funded a specific task.

Mitigation: v0.13 explicitly reports pool-level provenance only. Per-task lot accounting is not claimed.

### Funding-source key compromise

Threat: a compromised trusted source key mints fraudulent credits.

Mitigation boundary: source-key rotation, revocation history, hardware-backed signing, and external settlement reconciliation remain future production hardening.


## Stripe adapter threats added in v0.14

### Forged webhook

Threat: an attacker posts a fake paid Checkout Session.

Mitigation: the adapter verifies the Stripe webhook signature against the exact raw request body and enforces timestamp tolerance before parsing or minting SponsorRail credits.

### Webhook replay

Threat: Stripe retries an event or multiple success events describe the same Checkout Session.

Mitigation: the Checkout Session ID deterministically becomes the SponsorRail deposit ID and external reference. The v0.13 ledger applies that funding identity once.

### Metadata inflation

Threat: arbitrary Checkout metadata claims more SponsorRail credits than were actually paid.

Mitigation: credit quantity is computed from signed `amount_total` and configured currency conversion. Metadata is not a credit source.

### Campaign redirection

Threat: payment metadata redirects funds into another campaign.

Mitigation: each adapter instance is bound to a configured SponsorRail campaign ID.

### Test/live confusion

Threat: test-mode webhook events mint production campaign credits or vice versa.

Mitigation: the adapter defaults to `requiredLivemode=false`. Live mode must be explicitly enabled.

### Unbounded conversion

Threat: a configuration error maps a payment to an extreme number of credits.

Mitigation: rates must be positive integers and operators can set `maxCreditsPerDeposit`.


## Funding reversal threats added in v0.15

### Refund replay

Threat: the same refund or dispute webhook repeatedly removes credits.

Mitigation: signed reversal IDs are durable idempotency keys and exact replay is a no-op.

### Over-reversal

Threat: multiple partial refunds or dispute events reverse more credits than the original deposit.

Mitigation: aggregate reversals are bounded by original deposit credits.

### Historical erasure

Threat: a refund rewrites past spent-compute records to make accounting appear balanced.

Mitigation: reversals are append-only. Spent and receipt history are never reduced.

### Reserved-credit theft

Threat: a reversal invalidates an already active execution reservation.

Mitigation: reversals debit available credits only. Any shortfall becomes campaign liability.

### Liability bypass

Threat: a campaign with outstanding refund liability continues authorizing new sponsored tasks.

Mitigation: campaign matching and authorization exclude campaigns with non-zero funding liability.

### Conversion policy drift

Threat: a Stripe credit conversion rate changes between payment and later partial refund.

Mitigation boundary: a Stripe funding source ID should represent an immutable conversion policy. Operators must rotate the source ID when changing `creditsPerMinorUnit`. Per-deposit conversion-policy snapshots are future hardening.
