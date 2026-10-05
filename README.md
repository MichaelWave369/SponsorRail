# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

SponsorRail treats sponsorship as a compute grant rather than an excuse to interrupt users with miserable ads. Sponsors fund useful work while the funding plane remains separated from the agent's private execution context.

## v0.13 — signed funding provenance and deposit ledger

v0.13 answers a new question: **where did campaign credits come from?**

SponsorRail now supports registered funding sources that issue Ed25519-signed deposit receipts. The SQLite funding backend verifies those receipts before atomically increasing a campaign pool.

### Funding flow

```text
external funding event
       |
       v
trusted funding-source adapter
       |
       | signed deposit receipt
       v
FundingSourceRegistry
       |
       | signature + source verification
       v
SQLite deposit transaction
       |
       +-- append immutable deposit record
       +-- increase campaign available credits
```

### Idempotency

The same signed deposit can be replayed safely without double-crediting a campaign.

Reusing a deposit ID with a different signed payload fails closed. Reusing the same external funding reference under a second deposit ID also fails.

### Provenance scope

v0.13 proves that verified credits entered a campaign pool. It deliberately does **not** claim that a particular task spent a particular external dollar once credits are fungible.

`fundingSnapshot()` separates:

- operator-seeded credits
- verified deposit count
- verified deposited credits
- current available / reserved / spent balances

### Demo

```bash
npm run demo:funding
```

## v0.12 — transactional SQLite campaign persistence

v0.12 gives sponsored capability campaigns the same transactional durability as SponsorRail's SQLite funding path.

Campaign creation now atomically persists both the campaign contract and its backing sponsor pool. Campaign authorization is also atomic across independent processes.

### Critical opt-in rule

Generic SQLite `authorize()` ignores campaign-owned pools.

Campaign funding uses `authorizeCampaign()` or a broker configured with explicit `campaignPreferences`. This prevents contextual campaigns from bypassing their user opt-in through the ordinary funding path.

### Cross-process campaign invariant

```text
campaign budget = 30

worker A requests 20
worker B requests 20

exactly one succeeds

available = 10
reserved  = 20
spent     = 0
```

### Migration

Existing SponsorRail SQLite databases are migrated in place with a nullable `campaign_json` grant column plus the new `sponsor_campaigns` table.

### Demo

```bash
npm run demo:sqlite-campaign
```

## v0.11 — sponsored capability campaigns and non-coercion contract

v0.11 turns the sponsor-side product rules into executable policy.

A sponsor campaign now describes a useful capability grant rather than an interruption:

```text
Sponsor budget
    |
    v
Campaign contract
    |
    +-- useful capability
    +-- clear Sponsored disclosure
    +-- dismissible
    +-- no forced interaction
    +-- no prompt/source/output access
    +-- no ranking influence
    |
    v
BlindSponsorPool
    |
    v
ordinary SponsorRail grant
```

### Hard-rejected campaign behavior

SponsorRail rejects campaigns that require clicks/viewing, disable dismissal, autoplay, countdown, manufacture forced viewing, request prompt/repository/output/identity access, share data, influence recommendations, or contain sponsor instructions.

### Targeting modes

- **universal** — no task-class targeting; may fund eligible work broadly
- **contextual** — may match only coarse task classes and requires explicit user opt-in

The prompt is never a campaign-matching input.

### Receipt evidence

Campaign-funded receipts can record campaign ID, capability type, benefit description, disclosure label, targeting mode, and the non-coercion assertions:

```text
interactionRequired = false
dismissible = true
dataShared = none
influence = none
```

That evidence remains outside model context.

### Demo

```bash
npm run demo:campaign
```

## v0.10 — durable provider health and cross-process half-open leases

v0.10 makes circuit state survive process restart and coordinates recovery across independent router processes.

The new `SqliteProviderHealthTracker` persists:

- success/failure counts
- consecutive failures
- last failure code
- success/failure timestamps
- circuit-open expiry
- half-open execution lease

The health database also persists its circuit policy. A process that opens the same database with a conflicting failure threshold, cooldown, or half-open lease duration is rejected instead of silently interpreting shared state differently.

### Cross-process half-open invariant

After cooldown, a provider becomes half-open. Only one process may hold the half-open execution lease at a time.

```text
provider circuit cools down
        |
        v
     HALF_OPEN
      /     \
 router A  router B
    |         |
 atomic lease race
    |         |
  WINS       BUSY
    |
 trial execution
```

A busy half-open provider is skipped without reserving sponsor credits.

### Runtime compatibility

- Node 20+: in-memory `ProviderHealthTracker`
- Node 22.5+: optional durable `SqliteProviderHealthTracker` via `loadSqliteHealthBackend()`

### Demo

```bash
npm run demo:durable-health
```

On Node versions without built-in SQLite support, the demo exits successfully with a skip notice.

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

The current reference implementation covers blind funding-request isolation, sponsor-free execution context, policy matching, reserve/settle/refund accounting, failure rollback, durable grants, restart settlement, lease expiry and orphan reconciliation, heartbeat renewal, idempotent settlement across restart, v0.3 state migration, hash-linked receipts, a durable append-only receipt journal, journal-to-state recovery, receipt signatures, and tamper verification.

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
- [Durable provider health](docs/health.md)
- [Sponsor campaigns](docs/campaigns.md)
- [Funding provenance](docs/funding.md)
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail is not yet a payment processor, ad network, confidential-compute system, or production privacy guarantee.

### Known v0.13 boundaries

- the JSON state store remains single-process by design
- the SQLite backend requires Node 22.5+ because it uses the built-in `node:sqlite` module
- heartbeats are caller-driven; there is no worker heartbeat daemon
- receipt journaling is append-only at the application level, not WORM storage
- JSON settlement records remain single-process; the SQLite backend provides transactional settlement and receipt sequencing
- in-memory provider health remains process-local by design; the SQLite health backend provides durable shared state
- SQLite health coordination is local-machine/database-file coordination, not distributed consensus
- safe failover requires an explicit retry-safe provider error
- routing scores are deterministic policy heuristics, not learned recommendations
- provider health probes are point-in-time availability checks
- Ollama prompt/input tokens are telemetry rather than billed units in v0.7
- SQLite now persists campaign contracts, campaign pools, grant campaign snapshots, and transactional campaign authorization
- signed funding deposits prove source-side credit issuance but do not yet perform fiat/card/bank settlement themselves
- campaign pools may contain both operator-seeded and verified deposited credits; per-task lot tracing is not claimed
- production key rotation, external payment settlement, fraud resistance, and hardware-backed attestation remain future work

## License

MIT
