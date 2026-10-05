# Compute-provider attestation

SponsorRail v0.6 separates three roles:

1. **Sponsor** — funds compute.
2. **Broker** — grants and settles compute authority.
3. **Compute provider** — performs execution and attests usage.

Keeping those roles explicit prevents a sponsor from becoming an instruction source merely because it paid the bill.

## Reference provider

`SignedComputeProvider` wraps an executor function.

The executor receives:

```js
{
  modelContext,
  authorization: {
    grantId,
    computeUnits
  }
}
```

It does not receive sponsor identity or sponsor instructions.

After execution, the adapter signs a coarse usage statement with Ed25519.

## Provider registry

`ProviderRegistry` is configured by the SponsorRail operator with trusted provider public keys.

A provider cannot self-authorize by attaching an arbitrary key to its receipt.

The registry also binds a provider to a usage metric such as `compute-units`.

## Settlement

`executeSponsoredProviderTask()` performs:

```text
authorize sponsor grant
        |
        v
send private context + opaque grant to provider
        |
        v
receive result + signed usage receipt
        |
        v
verify provider signature and grant binding
        |
        v
settle verified units
        |
        v
emit SponsorRail receipt + provider usage receipt
```

If provider execution fails, signature verification fails, grant binding fails, or usage exceeds the authorization ceiling, SponsorRail releases the sponsor reservation rather than charging it.

## Evidence

The SponsorRail receipt records:

- provider ID
- usage ID
- usage metric
- model class
- SHA-256 hash of the signed provider usage receipt
- signature-verification status
- whether execution context was shared with the provider
- whether sponsor identity was shared with the provider

The full provider usage receipt is returned separately so an auditor can verify the provider signature independently.

## Privacy

Provider receipts do not contain:

- prompt text
- repository context
- source code
- model output

However, the compute provider may receive private execution context in order to perform the computation.

This is intentionally different from the sponsor boundary:

```text
Sponsor      -> no prompt
Provider     -> may receive prompt
SponsorRail  -> records the distinction
```

Local inference, confidential-compute providers, or future zero-knowledge usage systems can tighten the provider boundary without changing the sponsor protocol.

## Future adapters

The reference adapter is provider-neutral. Future adapters can map real provider telemetry into the signed usage schema, including local Ollama-style runtimes, hosted model APIs, GPU job schedulers, CI systems, browser agents, and build/deploy services.

A real adapter should never trust client-supplied usage when provider-side metering is available.


## First concrete adapter: Ollama

`OllamaChatProvider` is SponsorRail's first real provider adapter.

It composes the generic signed-provider layer with Ollama's local chat endpoint and preserves the same provider receipt format.

The adapter intentionally defaults to loopback-only operation. This makes the easiest configuration also the most private configuration.

The provider sees the execution context because it performs inference. It does not receive sponsor identity or sponsor instructions.

Generated tokens are billed because Ollama can enforce an output ceiling before generation. Prompt token counts remain visible in returned metering telemetry for later pricing research.


## Provider discovery and routing

v0.8 adds `ProviderRouter`.

A provider registration describes:

- provider ID
- executable adapter
- locality
- capabilities
- supported task classes
- supported privacy modes
- maximum compute units
- cost per unit
- operator priority
- optional availability probe

Routing never examines the user prompt.

The default selection score rewards an eligible/available provider, preferred locality, lower cost, and operator priority. Privacy, capability, compute-limit, and cost-limit failures disqualify a provider rather than merely lowering its score.

Applications can inspect the candidate list to explain why a provider was or was not eligible.


## Provider retry contract

v0.9 adds `ProviderUnavailableError`.

Provider adapters should use this only when they can reasonably assert that retrying elsewhere is safe.

Examples that may be classified retry-safe by an adapter include explicit capacity rejection or service-unavailable responses.

Timeouts and transport ambiguity should remain ordinary errors unless the adapter has stronger evidence.

The Ollama adapter currently classifies HTTP 429, 502, 503, and 504 responses as retry-safe availability failures. Request timeouts remain ambiguous.
