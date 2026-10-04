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
