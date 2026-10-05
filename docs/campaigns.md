# Sponsored capability campaigns

SponsorRail v0.11 turns sponsorship from an advertising interruption into a capability grant.

## Product rule

> Sponsorship must add capability, never remove comfort.

A campaign can fund compute, CI, GPU time, deployment, security scans, research runs, or other useful capabilities. It cannot require the user to endure artificial friction in exchange.

## Required campaign fields

- campaign ID
- sponsor disclosure
- capability type
- budget credits

Campaigns may also define benefit description, funding policy, priority, and targeting mode.

## Experience contract

Campaigns fail validation if they request any of the following:

- required interaction
- non-dismissible surface
- autoplay
- countdown
- forced viewing
- recommendation/ranking influence
- prompt access
- repository access
- model-output access
- user-identity access
- data sharing
- sponsor instructions

The accepted contract is intentionally boring:

```text
interactionRequired = false
dismissible = true
dataShared = none
influence = none
```

Boring is excellent when money is near cognition.

## Universal campaigns

Universal campaigns must allow all task classes.

They can still apply privacy and per-grant compute limits, but they do not choose users based on task category.

## Contextual campaigns

Contextual campaigns may target coarse task classes such as software development or research.

They are ignored unless the application/user explicitly enables contextual sponsorship.

The router never sees prompt contents for this purpose.

## User controls

`SponsorCampaignRegistry.match()` supports:

- contextual sponsorship opt-in
- allowed capability types
- blocked campaign IDs
- global sponsorship decline through `allowSponsorship=false`

## Funding integration

`createCampaignPool()` converts a validated campaign into a `BlindSponsorPool`.

Safe campaign metadata follows the funding grant and SponsorRail receipt, while `buildExecutionAuthorization()` continues to strip all sponsor/campaign fields before execution.

## Transactional SQLite persistence

v0.12 persists campaigns in SQLite with atomic pool creation and campaign authorization.

The SQLite backend supports:

- `createCampaign()`
- `campaignSnapshot()`
- `listCampaigns()`
- `matchCampaigns()`
- `authorizeCampaign()`
- constructor-level `campaignPreferences`

Generic `authorize()` intentionally excludes campaign pools so contextual opt-in cannot be bypassed.

Campaign authorization uses the same conditional balance update pattern as ordinary SQLite funding, preserving the no-overspend invariant across processes.
