# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

SponsorRail treats sponsorship as a compute grant rather than an excuse to interrupt users with miserable ads. Sponsors fund useful work while the funding plane remains separated from the agent's private execution context.

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
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail is not yet a payment processor, ad network, confidential-compute system, or production privacy guarantee.

### Known v0.5 boundaries

- the JSON state store remains single-process by design
- the SQLite backend requires Node 22.5+ because it uses the built-in `node:sqlite` module
- heartbeats are caller-driven; there is no worker heartbeat daemon
- receipt journaling is append-only at the application level, not WORM storage
- settlement records are durable but not yet backed by a transactional database
- production key rotation, provider settlement, fraud resistance, and hardware-backed attestation remain future work

## License

MIT
