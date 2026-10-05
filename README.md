# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

SponsorRail treats sponsorship as a compute grant rather than an excuse to interrupt users with miserable ads. Sponsors fund useful work while the funding plane remains separated from the agent's private execution context.

## v0.9 — safe provider failover and circuit breaking

v0.9 makes routing resilient without turning retries into accidental duplicate compute.

The rule is intentionally conservative:

> **Automatic failover happens only when a provider failure is explicitly safe to retry.**

A provider can signal retry-safe unavailability with `ProviderUnavailableError`. Generic timeouts, network ambiguity, and unknown failures do not automatically rerun the task.

### Health memory

`ProviderHealthTracker` records coarse provider health:

- successes
- failures
- consecutive failures
- last failure code
- last success/failure timestamps
- circuit-open expiry

After a configurable failure threshold, the provider circuit opens and routing skips that provider without probing it. After cooldown the provider becomes half-open and may be tested again.

### Safe failover flow

```text
provider A selected
      |
      v
explicit retry-safe failure
      |
      +-> reservation released
      +-> health failure recorded
      |
      v
provider B selected
      |
      v
signed usage + settlement
```

An ambiguous failure instead stops:

```text
provider A timeout / uncertain outcome
      |
      v
reservation released
      |
      X no automatic duplicate execution
```

### Receipt evidence

Successful failover receipts can record the selected provider, attempt count, whether failover was used, and failed provider IDs. Raw error text is not copied into receipts.

### Demo

```bash
npm run demo:failover
```

## v0.8 — provider discovery and routing

v0.8 adds a privacy-preserving router above the provider layer.

The router evaluates only coarse execution requirements:

- task class
- privacy mode
- requested compute
- required capabilities
- locality preference
- maximum cost per unit

It does **not** receive prompt text, repository context, source code, model output, or sponsor identity.

Eligible providers are scored on availability, privacy compatibility, capability compatibility, locality, cost, and operator priority. The selected provider and coarse decision evidence are written into the SponsorRail receipt.

### Routing flow

```text
private task
   |
   +-----------------------> execution context
   |
   +-> coarse routing request
             |
             v
       ProviderRouter
        /    |    \
     local remote offline
        \    |    /
             v
        selected provider
             |
             v
      signed provider usage
             |
             v
        SponsorRail settlement
```

### No provider, no reservation

Provider discovery happens before sponsor authorization. If no provider qualifies, SponsorRail returns `NO_ELIGIBLE_PROVIDER` and sponsor credits remain untouched.

### Ollama discovery

`OllamaChatProvider.probe()` now checks Ollama's `/api/tags` endpoint and confirms that the configured model is installed before routing work to it.

### Routing demo

```bash
npm run demo:routing
```

## v0.7 — local-first Ollama provider

v0.7 ships SponsorRail's first concrete compute-provider adapter.

`OllamaChatProvider` talks to Ollama's `/api/chat` endpoint with streaming disabled, uses generated-token count as the enforceable billing unit, returns prompt/timing telemetry to the caller, and signs usage through the v0.6 provider-attestation layer.

### Safety defaults

- loopback-only endpoint by default
- explicit opt-in required for remote endpoints
- HTTPS required for remote endpoints unless insecure remote use is explicitly enabled
- fixed model allowlist
- request timeout / abort
- output-token ceiling enforced through `num_predict`
- sponsor identity never enters the Ollama request
- prompt/source/output never enter provider usage receipts

### Billing metric

The first Ollama adapter settles on:

```text
ollama-output-tokens = eval_count
```

Prompt token counts and timing fields are returned as telemetry but are not billed in v0.7. This keeps the sponsored amount enforceable before generation because `num_predict` can cap generated tokens.

### Live local demo

With Ollama running locally:

```bash
OLLAMA_MODEL=<installed-model> npm run demo:ollama
```

The default endpoint is `http://127.0.0.1:11434`.

## v0.6 — signed compute-provider attestation

v0.6 connects SponsorRail's accounting plane to a distinct compute-provider plane.

A trusted provider signs a usage receipt after executing a grant. SponsorRail verifies that receipt before settling sponsor credits.

```text
Sponsor
   |
   | funds credits
   v
SponsorRail Broker
   |
   | opaque grant
   v
Compute Provider
   |
   | signed usage receipt
   v
SponsorRail Verification
   |
   | verified units only
   v
Settlement + SponsorRail receipt
```

### Provider invariants

- provider usage is signed with Ed25519
- provider identity must be registered by the operator
- usage receipts are bound to the exact grant ID and compute ceiling
- a provider cannot claim more units than the grant authorizes
- SponsorRail settles from verified provider usage, not arbitrary result metadata
- provider receipts omit prompt, repository context, source, and model output
- sponsor identity is not passed into the provider execution envelope

### Privacy boundary: sponsor vs provider

The sponsor and compute provider are different actors.

A sponsor never receives the prompt, source, or model output through SponsorRail.

A compute provider may receive the execution context because it may need that context to perform inference. Local or confidential providers can reduce that disclosure, but SponsorRail does not pretend a remote model can compute on a prompt it never receives.

That distinction is recorded explicitly in the SponsorRail receipt.

## v0.5 — transactional SQLite concurrency

v0.5 adds a second backend for workloads that need real multi-connection accounting guarantees while preserving the existing JSON reference backend.

The new SQLite backend adds:

- WAL-backed persistent accounting
- `BEGIN IMMEDIATE` write serialization
- atomic reserve / settle / release operations
- conditional balance updates that cannot overspend a pool
- durable idempotent settlements across independent broker connections
- database-backed receipt sequencing
- independent-worker concurrency tests

The original JSON backend remains available for simple local/reference use.

### Runtime compatibility

- Node 20+: JSON reference backend
- Node 22.5+: optional SQLite transactional backend via `loadSqliteBackend()`

### Concurrency invariant

Two independent workers competing for the same credits must never both win when the pool cannot fund both.

```text
pool = 30 credits

worker A requests 20
worker B requests 20

exactly one reservation succeeds

remaining:
available 10
reserved 20
spent 0
```

### Previous v0.4 guarantees remain

v0.4 hardened three failure boundaries:

1. **Live work can renew its lease.**
2. **Settlement is idempotent.**
3. **Completed receipts are appended to a durable journal.**

### Grant heartbeat

Active workers can renew a grant without changing its authority or compute ceiling.

```text
grant expires 01.100
       |
heartbeat at 01.080
       |
renew to 01.280
```

The matching reservation receives the same expiry. An already-expired grant cannot be revived.

### Idempotent settlement

A settlement can be retried after a lost response or process restart.

```text
settle grant G / 17 units / key K
        |
        v
17 units charged

network response disappears

retry grant G / 17 units / key K
        |
        v
same result
0 additional units charged
```

SponsorRail also prevents the same grant from being charged twice under a different idempotency key.

### Append-only receipt journal

v0.3 persisted only the receipt-chain head. v0.4 also writes completed receipts to an NDJSON journal.

Each receipt remains hash-linked and may be Ed25519 signed.

```text
receipt 1 -> receipt 2 -> receipt 3
    |          |           |
    +----------+-----------+
        append-only journal
```

If the state document lags behind a successfully appended journal entry, the broker recovers the chain head from the journal on restart.

## Quick start

Requires Node.js 20 or newer.

```bash
npm test
npm run demo
```

No third-party runtime dependencies are required.

## Current qualification

The v0.4 reference implementation covers blind funding-request isolation, sponsor-free execution context, policy matching, reserve/settle/refund accounting, failure rollback, durable grants, restart settlement, lease expiry and orphan reconciliation, heartbeat renewal, idempotent settlement across restart, v0.3 state migration, hash-linked receipts, a durable append-only receipt journal, journal-to-state recovery, receipt signatures, and tamper verification.

## Privacy boundary

SponsorRail persistent state and receipts may contain coarse funding information such as task ID, task class, grant IDs, sponsor disclosure, compute usage, lease times, and hashes.

SponsorRail does not persist through these funding structures: prompt text, repository context, source code, or model output.

## Documentation

- [Principles](docs/principles.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Accounting](docs/accounting.md)
- [Durable grants](docs/durable-grants.md)
- [Live settlement](docs/live-settlement.md)
- [SQLite backend](docs/sqlite-backend.md)
- [Compute providers](docs/providers.md)
- [Ollama adapter](docs/ollama.md)
- [Provider routing](docs/routing.md)
- [Safe failover](docs/failover.md)
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail is not yet a payment processor, ad network, confidential-compute system, or production privacy guarantee.

### Known v0.9 boundaries

- the JSON state store remains single-process by design
- the SQLite backend requires Node 22.5+ because it uses the built-in `node:sqlite` module
- heartbeats are caller-driven; there is no worker heartbeat daemon
- receipt journaling is append-only at the application level, not WORM storage
- JSON settlement records remain single-process; the SQLite backend provides transactional settlement and receipt sequencing
- provider health memory is process-local in v0.9 and resets on restart
- safe failover requires an explicit retry-safe provider error
- routing scores are deterministic policy heuristics, not learned recommendations
- provider health probes are point-in-time availability checks
- Ollama prompt/input tokens are telemetry rather than billed units in v0.7
- production key rotation, external payment settlement, fraud resistance, and hardware-backed attestation remain future work

## License

MIT
