# Safe provider failover

SponsorRail v0.9 adds conservative automatic failover.

## The problem

A router can select the best provider and still lose it one millisecond later. Real systems are rude like that.

Blindly retrying every failure is unsafe because a timeout or dropped response does not prove that the provider failed to perform the compute.

## Explicit retry safety

Adapters can throw:

```js
new ProviderUnavailableError(
  "service unavailable",
  {
    code: "PROVIDER_UNAVAILABLE"
  }
)
```

This error carries:

```text
safeToRetry = true
```

Only explicitly retry-safe failures can trigger automatic provider failover.

## Attempt accounting

For every attempt:

1. SponsorRail chooses an eligible provider.
2. The broker reserves compute.
3. Provider execution begins.
4. On retry-safe failure, the reservation is released.
5. Health state is updated.
6. The next eligible provider may be tried.

At no point are multiple provider attempts intentionally backed by simultaneous SponsorRail reservations.

## Ambiguous failures

These stop automatic failover by default:

- request timeout
- connection reset after request transmission
- malformed response after execution may have occurred
- receipt-commit failure
- unknown exception

The correct response to uncertainty is evidence gathering or reconciliation, not cheerful duplication.

## Circuit breaker

`ProviderHealthTracker` uses consecutive failures and a cooldown.

```text
CLOSED
  |
  | threshold reached
  v
OPEN
  |
  | cooldown expires
  v
HALF_OPEN
  |
  +-- success --> CLOSED
  |
  +-- failure --> OPEN
```

Open providers are neither probed nor selected.

## Health evidence

Health memory stores only coarse operational data:

- provider ID
- counts
- timestamps
- last failure code
- circuit expiry

No prompt, source, output, sponsor identity, or raw error message is stored.

## Durable health option

v0.10 adds `SqliteProviderHealthTracker` for restart-safe and cross-process circuit state.

The SQLite backend adds an atomic half-open lease so only one cooperating router process can execute the recovery trial at a time.

The in-memory tracker remains useful for single-process applications.

## Current limitation

SQLite health coordination protects cooperating processes sharing one SQLite database. It is not cross-machine consensus or a global distributed circuit breaker.
