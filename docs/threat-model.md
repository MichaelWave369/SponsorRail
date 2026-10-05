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
