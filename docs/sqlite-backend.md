# SQLite transactional backend

SponsorRail v0.5 adds an optional SQLite-backed broker for multi-connection accounting.

## Requirements

The backend uses Node's built-in `node:sqlite` module and therefore requires Node 22.5 or newer.

The default package entry remains compatible with Node 20 because the SQLite backend is loaded lazily:

```js
import {
  loadSqliteBackend
} from "./src/index.js";

const {
  SqliteFundingBroker
} = await loadSqliteBackend();
```

## Why a separate backend?

The JSON backend is deliberately readable and simple, but it is not a multi-writer database.

A real sponsor pool may be accessed by several workers at once. The critical invariant is:

> Reserved compute can never exceed the credits actually available in the pool.

SQLite provides the locking and transactional semantics needed to enforce that invariant.

## Database mode

The reference backend enables:

```text
busy_timeout
foreign_keys = ON
journal_mode = WAL
synchronous = NORMAL
```

Write operations use `BEGIN IMMEDIATE` so competing writers serialize before mutating sponsor balances.

## Atomic authorization

Authorization performs a conditional update:

```sql
UPDATE sponsor_pools
SET available_credits = available_credits - ?,
    reserved_credits = reserved_credits + ?
WHERE id = ?
  AND available_credits >= ?;
```

A grant row is inserted only if that update changed exactly one pool row.

This prevents two independent broker connections from both spending the same remaining credits.

## Atomic settlement

Settlement atomically:

1. checks durable idempotency records
2. validates the active grant and lease
3. refunds unused reserved compute
4. moves actual usage to spent credits
5. deletes the active grant
6. records the settlement

A replay returns the original settlement result instead of charging again.

## Receipt sequencing

The SQLite backend assigns receipt sequence numbers while holding a write transaction, then stores the receipt and updates the chain head before committing.

This prevents two independent brokers from both claiming the same receipt sequence.

## Privacy

The SQLite backend stores only funding-plane data.

It does not persist prompt text, repository context, source code, or model output. Receipts retain the same hashed evidence and sponsor disclosure fields used by the rest of SponsorRail.

## Qualification

The v0.5 test suite includes two worker threads with independent SQLite connections racing against one 30-credit sponsor pool while each attempts to reserve 20 credits.

Exactly one worker may succeed.

## Current limits

- SQLite is a local transactional backend, not a distributed database.
- Cross-machine consensus is out of scope.
- External payment settlement is not yet coupled to database transactions.
- Provider usage attestations are still future work.
