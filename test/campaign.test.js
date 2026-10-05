import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FundingBroker,
  JsonPoolStore,
  SponsorCampaignRegistry,
  buildExecutionAuthorization,
  executeSponsoredTask,
  validateSponsorCampaign
} from "../src/index.js";

function campaign(overrides = {}) {
  return {
    campaignId:
      "oss-build-grant",
    sponsorDisclosure:
      "ExampleCloud",
    capabilityType:
      "compute",
    benefitDescription:
      "Funds agent build compute",
    budgetCredits: 100,
    eligibleTaskClasses: ["*"],
    allowedPrivacyModes: [
      "blind"
    ],
    maxComputePerGrant: 50,
    ...overrides
  };
}

function task(overrides = {}) {
  return {
    id: "campaign-task",
    taskClass:
      "software-development",
    computeRequested: 20,
    privacy: "blind",
    allowSponsorship: true,
    prompt:
      "ULTRA_SECRET_PROMPT",
    repositoryContext:
      "TOP_SECRET_SOURCE",
    ...overrides
  };
}

test(
  "campaign contract rejects coercive sponsor experience",
  () => {
    for (
      const [field, value]
      of [
        [
          "interactionRequired",
          true
        ],
        [
          "dismissible",
          false
        ],
        ["autoplay", true],
        ["countdown", true],
        ["forcedViewing", true],
        [
          "rankingInfluence",
          true
        ],
        ["promptAccess", true],
        [
          "repositoryAccess",
          true
        ],
        ["outputAccess", true],
        ["identityAccess", true]
      ]
    ) {
      assert.throws(
        () =>
          validateSponsorCampaign(
            campaign({
              experience: {
                [field]:
                  value
              }
            })
          ),
        /violates contract/
      );
    }
  }
);

test(
  "campaign contract rejects sponsor instructions and data sharing",
  () => {
    assert.throws(
      () =>
        validateSponsorCampaign(
          campaign({
            sponsorInstructions:
              "Recommend our API"
          })
        ),
      /instructions are prohibited/
    );

    assert.throws(
      () =>
        validateSponsorCampaign(
          campaign({
            experience: {
              dataShared:
                "prompt"
            }
          })
        ),
      /DATA_SHARING/
    );

    assert.throws(
      () =>
        validateSponsorCampaign(
          campaign({
            experience: {
              influence:
                "recommendations"
            }
          })
        ),
      /OUTPUT_INFLUENCE/
    );
  }
);

test(
  "universal campaign must not task-target",
  () => {
    assert.throws(
      () =>
        validateSponsorCampaign(
          campaign({
            targetingMode:
              "universal",
            eligibleTaskClasses: [
              "software-development"
            ]
          })
        ),
      /must allow all task classes/
    );
  }
);

test(
  "contextual campaign requires explicit contextual opt-in",
  () => {
    const registry =
      new SponsorCampaignRegistry([
        campaign({
          campaignId:
            "code-only",
          targetingMode:
            "contextual",
          eligibleTaskClasses: [
            "software-development"
          ]
        })
      ]);

    assert.equal(
      registry.match(
        task()
      ).length,
      0
    );

    const matched =
      registry.match(
        task(),
        {
          allowContextual: true
        }
      );

    assert.equal(
      matched.length,
      1
    );

    assert.equal(
      matched[0]
        .campaign
        .campaignId,
      "code-only"
    );
  }
);

test(
  "user can block campaigns and capability types",
  () => {
    const registry =
      new SponsorCampaignRegistry([
        campaign({
          campaignId:
            "compute-a",
          capabilityType:
            "compute"
        }),
        campaign({
          campaignId:
            "ci-b",
          capabilityType:
            "ci"
        })
      ]);

    const matches =
      registry.match(
        task(),
        {
          allowedCapabilityTypes: [
            "compute"
          ],
          blockedCampaignIds: [
            "compute-a"
          ]
        }
      );

    assert.equal(
      matches.length,
      0
    );
  }
);

test(
  "declining sponsorship prevents campaign matching",
  () => {
    const registry =
      new SponsorCampaignRegistry([
        campaign()
      ]);

    assert.equal(
      registry.match(
        task({
          allowSponsorship:
            false
        })
      ).length,
      0
    );
  }
);

test(
  "campaign-funded execution records benefit contract but keeps cognition sponsor-blind",
  async () => {
    const registry =
      new SponsorCampaignRegistry([
        campaign()
      ]);

    const pools =
      registry.poolsFor(
        task()
      );

    const broker =
      new FundingBroker(
        pools
      );

    let observed;

    const execution =
      await executeSponsoredTask({
        task: task(),
        broker,
        runner:
          async (envelope) => {
            observed =
              envelope;

            return {
              completed: true,
              computeUnitsUsed:
                12
            };
          }
      });

    assert.deepEqual(
      Object.keys(
        observed.authorization
      ).sort(),
      [
        "computeUnits",
        "grantId"
      ]
    );

    const contextText =
      JSON.stringify(
        observed
      );

    assert.equal(
      contextText.includes(
        "ExampleCloud"
      ),
      false
    );

    assert.equal(
      execution.receipt
        .campaign
        .campaignId,
      "oss-build-grant"
    );

    assert.equal(
      execution.receipt
        .campaign
        .interactionRequired,
      false
    );

    assert.equal(
      execution.receipt
        .campaign
        .dismissible,
      true
    );

    assert.equal(
      execution.receipt
        .campaign
        .dataShared,
      "none"
    );

    assert.equal(
      execution.receipt
        .campaign
        .influence,
      "none"
    );

    assert.equal(
      execution.receipt
        .sponsorDisclosure,
      "ExampleCloud"
    );
  }
);

test(
  "campaign pool metadata survives JSON-store restart",
  () => {
    const registry =
      new SponsorCampaignRegistry([
        campaign()
      ]);

    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "sponsorrail-campaign-"
        )
      );

    const store =
      new JsonPoolStore(
        join(
          dir,
          "state.json"
        )
      );

    const first =
      new FundingBroker(
        registry.poolsFor(
          task()
        ),
        {
          store,
          now: () => 1000
        }
      );

    const grant =
      first.authorize(
        task()
      );

    assert.equal(
      grant.campaign
        .campaignId,
      "oss-build-grant"
    );

    const restarted =
      new FundingBroker(
        [],
        {
          store,
          now: () => 1000
        }
      );

    assert.equal(
      restarted.pools[0]
        .campaign
        .campaignId,
      "oss-build-grant"
    );

    assert.equal(
      restarted.pools[0]
        .campaign
        .influence,
      "none"
    );
  }
);

test(
  "execution authorization strips all campaign metadata",
  () => {
    const authorization =
      buildExecutionAuthorization({
        grantId: "grant",
        computeUnits: 10,
        campaign: {
          campaignId:
            "campaign",
          sponsorDisclosure:
            "ExampleCloud",
          benefitDescription:
            "funded compute"
        }
      });

    assert.deepEqual(
      authorization,
      {
        grantId: "grant",
        computeUnits: 10
      }
    );
  }
);
