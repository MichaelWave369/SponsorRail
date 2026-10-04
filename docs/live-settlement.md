# Live settlement and receipt journal

SponsorRail v0.4 addresses three ordinary distributed-systems failures that become expensive when real money funds compute.

## 1. The worker is still alive

Without lease renewal, a long-running valid task can lose its reservation simply because its original grant expires.

`FundingBroker.heartbeat()` renews an active lease while preserving the original compute ceiling and policy decision.

## 2. The work settled but the response disappeared

A client may retry settlement after a network failure or broker restart.

SponsorRail persists settlement records and recognizes both repeated idempotency keys and repeated settlement of an already-settled grant.

The same usage produces the same result without a second charge. Different usage is rejected.

## 3. The chain head survived but receipt history did not

v0.3 stored the chain head. v0.4 adds a durable NDJSON receipt journal.

Receipts are appended before the state document advances its chain head. This ordering allows the journal to repair a lagging state document after restart.

## Safety properties

- heartbeat cannot revive expired authority
- heartbeat cannot increase authorized compute
- settlement replay cannot spend twice
- settlement conflicts fail closed
- receipt hash duplicates are not appended twice
- journal entries are verified before being trusted for recovery
- prompt, repository context, source, and output remain outside funding-state persistence

## Future hardening

The next production-oriented layer should replace single-process JSON accounting with transactional storage and explicit concurrency control, then add provider adapters and external settlement receipts.
