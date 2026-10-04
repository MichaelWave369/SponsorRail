# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

SponsorRail follows one rule:

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

Instead of forcing users to watch intrusive ads, SponsorRail treats sponsorship as a compute grant. A company, community, patron, or public-interest fund can pay for agent work while the funding plane remains separated from the agent's private execution context.

## v0.2 accounting rung

SponsorRail v0.2 adds broker mechanics on top of the v0.1 trust boundary:

- policy matching by coarse task class, privacy mode, and per-grant compute limit
- reserve-before-execute accounting
- settlement against actual compute used
- automatic refund of unused reserved credits
- full reservation release when execution fails or reports invalid usage
- JSON persistence for pool balances, policies, and coarse reservation state
- restart-safe visibility of outstanding pool reservations
- v0.2 signed receipts that record refunded compute

Authorization is not spending. A 25-credit grant that uses 17 credits settles 17 and returns 8 to the pool.

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
+--------------------+
| SponsorRail Broker |
+--------------------+
      |
      | reserve N units
      v
+--------------------+        private task        +----------------+
|  Execution Gate    | -------------------------> |  Agent Runtime |
+--------------------+                            +----------------+
      ^                                                  |
      |                                                  |
      +--------- settle actual use / refund rest --------+
                         |
                         v
                  Signed receipt
```

Sponsor attribution exists in the funding and receipt planes. It does **not** enter model context.

## Accounting example

A sponsor pool starts with 100 credits. A coding task requests 25.

```text
before authorization: available 100 / reserved 0 / spent 0
after authorization:  available  75 / reserved 25 / spent 0
after using 17:       available  83 / reserved 0 / spent 17
```

The total remains 100. Eight unused credits return to the sponsor pool.

## Persistence

`JsonPoolStore` writes versioned pool snapshots using a temporary file and rename. Persisted blind-mode reservation state contains coarse metadata only: task ID, task class, privacy mode, and reserved compute units. Prompt text, repository context, source code, and model output are never written by this store.

The v0.2 reference store is **single-process**. It does not yet provide multi-process locking or a transactional database.

## Documentation

- [Principles](docs/principles.md)
- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Accounting](docs/accounting.md)
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail is not yet a payment processor, ad network, confidential-compute system, or production privacy guarantee. Current receipt assertions demonstrate reference-runtime behavior; they are not hardware-backed attestations.

### Known v0.2 boundary

Pool reservations survive a process restart, but the broker's in-memory grant lookup does not yet recover those grants for settlement. Outstanding reservations remain visible in persistent state rather than silently disappearing. Durable grant recovery is an explicit next qualification rung.

## Roadmap

Next milestones include durable grant recovery and expiration, receipt chaining, settlement/provider adapters, stronger concurrency controls, privacy-preserving eligibility, fraud resistance, and production-grade key management while preserving the rule that funding never grants authority over agent cognition.

## License

MIT
