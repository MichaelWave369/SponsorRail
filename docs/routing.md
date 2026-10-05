# Provider discovery and routing

SponsorRail v0.8 introduces a provider router that selects compute without reading the task prompt.

## Principle

> Route on requirements, not content.

The router can see coarse requirements needed to make an execution decision. It does not receive the private material the selected provider will eventually execute.

## Routing request

Allowed fields:

- task ID
- task class
- privacy mode
- requested compute units
- required capabilities
- preferred locality
- maximum cost per unit

Excluded fields:

- prompt
- repository context
- source code
- model output
- sponsor identity
- sponsor instructions

## Provider registration

A provider entry can declare locality, capabilities, task classes, privacy modes, maximum compute, cost, priority, and an availability probe.

Provider identity is bound to the adapter's own `providerId`; a router entry cannot relabel one adapter as another.

## Eligibility

A provider is disqualified for:

- task-class mismatch
- privacy-mode mismatch
- missing capability
- compute ceiling below the request
- cost above the caller's explicit ceiling
- failed availability probe

Only eligible providers are scored.

## Scoring

The reference score is deterministic and explainable.

It combines:

- a fixed eligible/available base
- preferred-locality bonus
- lower-cost bonus
- bounded operator priority

This is a policy heuristic, not a learned ranking model.

## Execution

`executeRoutedSponsoredTask()` performs discovery first.

If no provider qualifies:

```text
NO_ELIGIBLE_PROVIDER
sponsor reservation = 0
```

If a provider qualifies, normal SponsorRail authorization and signed-provider execution follow.

## Receipt evidence

The SponsorRail receipt may contain the selected provider ID, score, locality, cost, priority, required capabilities, locality preference, candidate count, and eligible count.

Raw candidate probes are not embedded in receipts.

## Ollama probe

`OllamaChatProvider.probe()` calls:

```text
GET /api/tags
```

and confirms that the configured model appears in Ollama's installed model list.

This lets the router prefer a working local model and fall back before sponsor credits are reserved.

## Future work

Later routing layers can add provider latency history, cost conversion, operator policy, confidential-compute capability, model-quality classes, and multi-provider failover while preserving the same content-blind routing boundary.
