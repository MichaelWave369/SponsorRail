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


## Provider health plane

v0.10 makes provider health a replaceable state plane.

```text
ProviderRouter
    |
    v
Health Tracker Interface
    |
    +---- in-memory tracker
    |
    +---- SQLite durable tracker
              |
              +-- circuit history
              +-- shared policy
              +-- half-open lease
```

Health data is operational metadata only. It is deliberately independent of sponsor balances and private task contents.

The SQLite health tracker may use the same database file as other SponsorRail SQLite components, but it maintains separate tables and semantics.

### Half-open coordination

Circuit cooldown does not grant unlimited retry authority.

After cooldown, routers see `HALF_OPEN`. The execution path must atomically acquire a short lease before running the provider. Other processes skip the busy trial and may choose another provider.

This coordination occurs before SponsorRail funding authorization, so losing the half-open lease race does not create a sponsor-credit reservation.


## Campaign persistence plane

v0.12 adds a dedicated SQLite campaign table linked to sponsor pools.

```text
sponsor_campaigns
      |
      | 1:1
      v
sponsor_pools
      |
      v
durable grant
  campaign_json snapshot
```

The campaign table stores the validated campaign contract. The grant stores only safe campaign funding metadata required for receipt evidence.

Ordinary pool authorization excludes campaign-backed pools. Campaign-aware authorization applies user preferences before reserving credits.


## Funding-source plane

v0.13 adds an explicit boundary before sponsor campaign balances.

```text
Payment / grant / credit system
          |
          v
Funding-source adapter
          |
          | Ed25519 signed deposit
          v
FundingSourceRegistry
          |
          v
Transactional deposit ledger
          |
          v
Campaign pool
```

Funding sources are operator-trusted by public key, analogous to compute providers being trusted for signed usage.

The generic protocol does not depend on Stripe, bank rails, cloud credits, or any single payment processor. Those systems can be adapters that issue SponsorRail funding-deposit receipts only after their own settlement rules are satisfied.

Funding-source receipts contain coarse funding metadata only and never enter model context.
