# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

SponsorRail treats sponsorship as a compute grant rather than an excuse to interrupt users with miserable ads. Sponsors fund useful work while the funding plane remains separated from the agent's private execution context.

## v0.4 — live settlement and durable receipts

v0.4 hardens three failure boundaries:

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
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail is not yet a payment processor, ad network, confidential-compute system, or production privacy guarantee.

### Known v0.4 boundaries

- the JSON state store remains single-process
- heartbeats are caller-driven; there is no worker heartbeat daemon
- receipt journaling is append-only at the application level, not WORM storage
- settlement records are durable but not yet backed by a transactional database
- production key rotation, provider settlement, fraud resistance, and hardware-backed attestation remain future work

## License

MIT
