# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

SponsorRail follows one rule:

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

Instead of forcing users to watch intrusive ads, SponsorRail treats sponsorship as a compute grant. A company, community, patron, or public-interest fund can pay for agent work while the funding plane remains separated from the agent's private execution context.

## v0.3 durable-grants rung

SponsorRail v0.3 makes sponsored-compute authorization survive process failure instead of relying on an in-memory grant map.

It adds:

- durable grant records
- grant issue and expiry timestamps
- restart recovery of active grants
- settlement of a pre-restart grant after recovery
- lease-style grant expiration
- automatic release of expired reservations
- orphan-reservation detection
- conservative handling of unexpired orphans
- automatic reclamation of expired orphans
- migration of v0.2 pool-store documents
- persistent receipt-chain head and sequence
- hash-linked v0.3 receipts
- receipt-hash and chain verification helpers

A grant can now be authorized, persisted, recovered by a new broker process, and settled without losing accounting continuity.

## Quick start

Requires Node.js 20 or newer.

```bash
npm test
npm run demo
```

No third-party runtime dependencies are required.

## Reference flow

```text
Sponsor / Patron
      |
      | funds compute pool
      v
+-----------------------+
| SponsorRail Broker    |
| durable grant ledger  |
+-----------------------+
      |
      | reserve + persist grant lease
      v
+-----------------------+        private task        +----------------+
| Execution Gate        | -------------------------> | Agent Runtime  |
+-----------------------+                            +----------------+
      ^                                                      |
      |                                                      |
      +------------ settle actual use / refund -------------+
                             |
                             v
                     hash-linked receipt
                             |
                             v
                   persistent chain head
```

Sponsor attribution exists in the funding and receipt planes. It does **not** enter model context.

## Durable grant example

```text
pool: 100 available

authorize 25
  available 75
  reserved 25
  durable grant written

broker process exits

new broker starts
  pool recovered
  active grant recovered

settle 17
  available 83
  reserved 0
  spent 17
```

If a grant lease expires before settlement, reconciliation releases its reservation. If a reservation exists without a matching durable grant, SponsorRail reports it as an orphan. An unexpired orphan is preserved conservatively; an expired orphan is reclaimed.

## Receipt continuity

Each v0.3 receipt contains:

- a monotonically increasing sequence number
- the previous receipt hash
- its own receipt hash
- optional Ed25519 signature

The chain head and sequence are persisted independently of full receipt contents, so the next receipt after a normal broker restart continues the prior chain.

## Privacy boundary

Persistent v0.3 state contains only funding-plane information such as pool accounting, task ID, coarse task class, privacy mode, grant metadata, and receipt-chain hashes.

It does not persist through SponsorRail:

- prompt text
- repository context
- source code
- model output

## Documentation

- [Principles](docs/principles.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Accounting](docs/accounting.md)
- [Durable grants](docs/durable-grants.md)
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail is not yet a payment processor, ad network, confidential-compute system, or production privacy guarantee. Current receipt assertions demonstrate reference-runtime behavior; they are not hardware-backed attestations.

### Known v0.3 boundaries

- the JSON store is single-process and does not provide database-grade concurrent transactions
- grant leases expire but cannot yet be renewed or heartbeated
- receipt-chain state is durable, but the reference implementation does not persist a complete append-only receipt log
- production key rotation, fraud resistance, payment settlement, and provider attestation remain future work

## Roadmap

Natural next rungs include grant heartbeat/renewal, append-only receipt journals, idempotent settlement, stronger concurrency controls, provider adapters, privacy-preserving eligibility, fraud resistance, and production-grade key management while preserving the rule that funding never grants authority over agent cognition.

## License

MIT
