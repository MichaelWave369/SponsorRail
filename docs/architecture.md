# Architecture

SponsorRail separates funding, execution, accounting, and receipt concerns so that money can provide compute without becoming authority over agent cognition.

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
   | reserve compute                                |
   v                                                 |
Sponsor Pool ---- persisted accounting              |
   |                                                 |
   '--------------> Execution Gate -----------------'
                         |
                         v
                   Meter actual use
                         |
                         v
              Settle / refund reservation
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

It must not receive prompt text, source code, repository contents, model output, or user identity in blind mode.

## Policy plane

A pool can constrain funding using only permitted coarse fields:

- eligible task classes
- allowed privacy modes
- maximum compute per grant

Policy decisions never require model context.

## Accounting plane

SponsorRail v0.2 distinguishes three balances:

- `availableCredits`: available for new reservations
- `reservedCredits`: authorized for in-flight work but not spent
- `spentCredits`: settled actual usage

The invariant is:

```text
available + reserved + spent = total funded credits
```

Unused reservation capacity is refunded. Failed execution releases the reservation.

## Persistence plane

`JsonPoolStore` persists versioned pool snapshots through temporary-file replacement. Persisted reservations contain only coarse funding-plane metadata.

The reference store is deliberately single-process. Cross-process locking, database transactions, and crash-safe broker grant recovery are not claimed in v0.2.

## Execution plane

The execution plane receives the private model context plus an opaque broker grant ID and compute-unit limit. It does not receive sponsor identity, sponsor messaging, sponsor instructions, or sponsor targeting metadata.

## Receipt plane

The receipt may disclose who funded a run, but only after the execution boundary and without embedding private task contents. v0.2 adds explicit refunded-compute accounting to Ed25519-signed receipts.
