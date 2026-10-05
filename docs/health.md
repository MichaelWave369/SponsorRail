# Durable provider health

SponsorRail v0.10 adds restart-safe and cross-process provider circuit state.

## Why this exists

v0.9 could remember that a provider was failing, but only while one router process remained alive.

That creates a bad recovery pattern:

```text
provider fails
circuit opens
process restarts
memory disappears
provider is tried immediately again
```

The SQLite health backend removes that amnesia.

## Loading the backend

Because Node's built-in SQLite module is only available on supported Node 22 releases and newer, the backend is lazy-loaded:

```js
import {
  loadSqliteHealthBackend
} from "./src/index.js";

const {
  SqliteProviderHealthTracker
} =
  await loadSqliteHealthBackend();
```

## Persisted state

The `provider_health` table stores:

- provider ID
- total successes
- total failures
- consecutive failures
- last failure code
- last failure timestamp
- last success timestamp
- circuit-open expiry
- half-open lease expiry

It does not store prompt text, source code, repository context, model output, sponsor identity, or raw provider error messages.

## Shared policy

The database also stores the circuit configuration:

```text
failureThreshold
cooldownMs
halfOpenLeaseMs
```

Every process sharing the database must agree on those values.

A mismatch throws rather than silently producing inconsistent circuit behavior.

## Cross-process half-open lease

After an open circuit cools down, the provider becomes `HALF_OPEN`.

Before executing a recovery trial, a router asks:

```js
tracker.tryAcquireHalfOpen(
  providerId
)
```

The SQLite implementation performs this under a write transaction.

For two processes racing simultaneously:

```text
process A -> acquired = true
process B -> acquired = false
```

Exactly one recovery trial proceeds.

## Lease expiry

Half-open leases are temporary.

If the winning process dies before recording success or failure, another process can acquire the lease after its expiry.

## Success and failure

Successful execution:

- increments success count
- resets consecutive failures
- closes the circuit
- clears half-open lease

Failure:

- increments failure counters
- records a coarse failure code
- may reopen the circuit
- clears half-open lease

## Scope

This provides coordination among processes sharing one SQLite database.

It is not distributed consensus across machines. A future networked health-coordination backend can implement the same tracker interface without changing the router contract.
