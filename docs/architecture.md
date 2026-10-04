# Architecture

SponsorRail separates funding, execution, accounting, liveness, and evidence so that money can provide compute without becoming authority over agent cognition.

```text
User task
   |
   v
Funding Sanitizer
   |
   v
Policy Matcher
   |
   v
Funding Broker
   |
   +---- durable grant / reservation ----+
   |                                     |
   | heartbeat                           v
   |                              Persistent State
   |                                     |
   v                                     |
Execution Gate --------------------------+
   | private task
   v
Agent Runtime
   | measured use
   v
Idempotent Settlement
   |
   v
Receipt preparation
   |
   v
optional Ed25519 signature
   |
   v
Append-only receipt journal
   |
   v
Persistent chain head
```

## Funding plane

The funding plane may know coarse task classification, compute amounts, sponsor disclosure, grant identifiers, reservation identifiers, lease times, and settlement records.

It does not need prompt text, source code, repository contents, or model output.

## Execution plane

The execution plane receives private model context plus an opaque grant ID and authorized compute units. Sponsor identity and sponsor instructions remain excluded.

## Liveness plane

A grant lease prevents abandoned work from reserving sponsor credits indefinitely. v0.4 adds heartbeat renewal. A heartbeat can move the expiry forward but cannot increase the compute ceiling or alter task policy.

## Settlement plane

Settlement records are durable and keyed for idempotent replay. The broker also detects a previously settled grant even if a caller retries with a different key, preventing double-spend of sponsor credits.

## Evidence plane

Receipts are prepared against the current chain head, optionally signed, then committed.

Commit order is:

1. verify receipt hash and chain adjacency
2. append receipt to journal
3. advance in-memory chain head
4. persist chain-head state

If the journal append succeeds but state persistence lags, startup recovery can advance state from the valid journal tail.

## Persistence plane

The v0.4 JSON state contains pool snapshots, active durable grants, completed settlement records, and the receipt-chain head. A separate NDJSON file contains completed receipts.

The reference implementation remains single-process and does not claim distributed transactions.


## Storage backends

SponsorRail now has two storage paths.

### JSON reference backend

The JSON backend is intentionally simple and single-process. It is useful for examples, local development, protocol inspection, and environments where concurrent writers are not required.

### SQLite transactional backend

The SQLite backend is loaded lazily on Node 22.5+.

It uses:

- WAL mode
- `BEGIN IMMEDIATE` for write transactions
- conditional pool balance updates
- unique settlement constraints
- foreign keys
- durable receipt sequencing

The SQLite database is authoritative for pool balances, active grants, settlements, and receipt-chain state. Independent broker instances can open separate connections to the same database and coordinate through SQLite transaction locking.

This backend does not change the cognition boundary. Sponsor identity, prompt text, repository context, source code, and model output remain outside the execution authorization.


## Compute-provider plane

v0.6 introduces an explicit provider boundary between execution and settlement.

```text
private execution context
        |
        v
SignedComputeProvider
        |
        | result stays with caller
        | signed coarse usage only
        v
ProviderRegistry verification
        |
        v
SponsorRail settlement
```

The provider execution envelope contains only the private model context and opaque execution authorization. Sponsor disclosure and sponsor instructions are excluded.

The provider signs coarse metering evidence. SponsorRail uses the registered public key to verify the usage statement before charging a sponsor pool.

This does not make a remote provider blind to the prompt. It makes the **sponsor** blind to the prompt and makes provider-reported usage auditable.
