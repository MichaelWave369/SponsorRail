# Architecture

SponsorRail separates funding, execution, accounting, recovery, and receipt concerns so that money can provide compute without becoming authority over agent cognition.

```text
User task
   |
   v
Task Gateway
   | private task -----------------------------------.
   |                                                 |
   v                                                 v
Funding Sanitizer                              Agent Runtime
   | coarse metadata only                           ^
   v                                                 |
Policy Matcher                                      |
   |                                                 |
   v                                                 |
Funding Broker                                      |
   | reserve + durable grant                        |
   v                                                 |
Persistent State                                    |
   | pools / grants / chain head                    |
   v                                                 |
Execution Gate -------------------------------------'
   |
   v
Meter actual use
   |
   v
Settle / refund
   |
   v
Hash-linked receipt
```

## Funding plane

The funding plane may know:

- task ID
- coarse task class
- requested compute units
- user's maximum direct cost
- privacy mode
- sponsor disclosure
- grant and reservation identifiers
- grant lease times

It must not receive prompt text, source code, repository contents, model output, or user identity in blind mode.

## Policy plane

A pool can constrain funding using only permitted coarse fields:

- eligible task classes
- allowed privacy modes
- maximum compute per grant

Policy decisions never require model context.

## Accounting plane

SponsorRail distinguishes:

- `availableCredits`
- `reservedCredits`
- `spentCredits`

The invariant remains:

```text
available + reserved + spent = total funded credits
```

## Durable grant plane

A successful authorization writes both the reservation and matching grant to persistent state. Grants carry issue and expiration times.

On restart, a broker can reconstruct active grants and continue settlement.

## Reconciliation plane

Reconciliation detects:

- stale grants with missing pools
- stale grants with missing reservations
- expired grants
- orphan reservations

Expired grants and expired orphan reservations are released. Unexpired orphan reservations are reported but retained to avoid reclaiming compute that may still correspond to live work.

## Persistence plane

`JsonPoolStore` v0.3 stores a versioned document containing pools, active grants, and receipt-chain head state. v0.2 pool-only documents are migrated in memory when read.

The reference store is single-process. Cross-process locking and database transactions are not yet claimed.

## Execution plane

The execution plane receives the private model context plus an opaque broker grant ID and compute-unit limit. It does not receive sponsor identity, sponsor messaging, sponsor instructions, or sponsor targeting metadata.

## Receipt plane

v0.3 receipts are hash-linked. Each receipt commits to its payload, previous receipt hash, and sequence number. The broker persists chain head and sequence so receipt continuity survives normal restart without storing full private outputs.
