# Architecture

SponsorRail v0.1 is intentionally small. It proves the boundary before adding marketplaces, payment processors, model providers, or ad systems.

```text
User task
   |
   v
Task Gateway
   | private task ------------------------------.
   |                                            |
   v                                            v
Funding Sanitizer                         Agent Runtime
   | coarse metadata only                      ^
   v                                            |
Funding Broker                                |
   |                                            |
   v                                            |
Sponsor Pool                                   |
   | authorization only                        |
   '-----------------> Execution Gate ----------'
                         |
                         v
                    Metered result
                         |
                         v
                   Signed receipt
```

## Funding plane

The funding plane may know:

- task ID
- coarse task class
- requested compute units
- user's maximum direct cost
- privacy mode

It must not receive:

- prompt text
- source code
- repository contents
- model output
- user identity in blind mode

## Execution plane

The execution plane receives:

- private model context from the user task
- an opaque broker-minted grant ID
- authorized compute units

It does not receive:

- sponsor identity
- sponsor messaging
- sponsor instructions
- sponsor targeting metadata

## Receipt plane

The receipt may disclose who funded a run, but only after the execution boundary and without embedding private task contents. v0.1 signs receipts with Ed25519.
