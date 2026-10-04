# SponsorRail

**Privacy-preserving sponsored compute infrastructure for AI agents.**

> **Someone can pay for your AI to work. Nobody buys the right to tell it what to think.**

SponsorRail explores a simple rule:

## FUNDING != AUTHORITY

Money may grant compute. Money may not grant control.

Instead of forcing users to watch intrusive ads, SponsorRail treats sponsorship as a compute grant. A company, community, patron, or public-interest fund can pay for agent work while the funding plane remains separated from the agent's private execution context.

## What v0.1 proves

The first reference implementation demonstrates that:

- blind sponsors receive coarse funding metadata, not prompts or repository contents
- sponsor identity is excluded from model context
- sponsor instructions are excluded from execution authorization
- users can decline sponsorship
- compute is explicitly authorized and metered
- receipts omit prompts, source context, and model output
- receipts can be signed and independently verified with Ed25519

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
      | opaque compute grant
      v
+--------------------+        private task        +----------------+
|  Execution Gate    | -------------------------> |  Agent Runtime |
+--------------------+                            +----------------+
      |                                                  |
      '---------------- metering ------------------------'
                         |
                         v
                  Signed receipt
```

The sponsor attribution exists in the funding and receipt planes. It does **not** enter the model context.

## Example

A sponsor creates a 100-credit blind pool. A user requests a 25-credit coding task. SponsorRail exposes only the task ID, coarse task class, requested units, cost ceiling, and privacy mode to the funding side. The agent receives the private prompt plus an opaque compute authorization. After execution, SponsorRail emits a signed receipt recording who funded the computation and how much was used without copying private task data into the receipt.

See `examples/basic.mjs`.

## Documentation

- [Principles](docs/principles.md)
- [Architecture](docs/architecture.md)
- [Protocol v0.1](docs/protocol.md)
- [Threat model](docs/threat-model.md)

## Status

**Experimental / pre-alpha.**

SponsorRail v0.1 is a boundary proof, not a production advertising network or payment system. The current receipt assertions demonstrate reference-runtime behavior; they are not yet hardware-backed or confidential-compute attestations.

## Roadmap

Next milestones are expected to cover persistent sponsor pools, policy matching, richer metering, privacy-preserving eligibility, receipt chains, provider adapters, and real settlement boundaries while preserving the core rule that funding never grants authority over agent cognition.

## License

MIT
