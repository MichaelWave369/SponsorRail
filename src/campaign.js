import {
  BlindSponsorPool
} from "./sponsorrail.js";

function assertPositiveInteger(
  value,
  name
) {
  if (
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new TypeError(
      `${name} must be a positive integer`
    );
  }
}

function normalizeList(
  value,
  fallback
) {
  const source =
    value ?? fallback;

  if (
    !Array.isArray(source) ||
    source.length === 0
  ) {
    throw new TypeError(
      "campaign lists must be non-empty arrays"
    );
  }

  return Object.freeze([
    ...new Set(
      source.map(String)
    )
  ]);
}

function normalizeExperience(
  experience = {}
) {
  const normalized =
    Object.freeze({
      interactionRequired:
        experience.interactionRequired ===
          true,
      dismissible:
        experience.dismissible !==
          false,
      autoplay:
        experience.autoplay ===
          true,
      countdown:
        experience.countdown ===
          true,
      forcedViewing:
        experience.forcedViewing ===
          true,
      rankingInfluence:
        experience.rankingInfluence ===
          true,
      promptAccess:
        experience.promptAccess ===
          true,
      repositoryAccess:
        experience.repositoryAccess ===
          true,
      outputAccess:
        experience.outputAccess ===
          true,
      identityAccess:
        experience.identityAccess ===
          true,
      dataShared:
        String(
          experience.dataShared ??
          "none"
        ),
      influence:
        String(
          experience.influence ??
          "none"
        )
    });

  const violations = [];

  if (
    normalized.interactionRequired
  ) {
    violations.push(
      "INTERACTION_REQUIRED"
    );
  }

  if (!normalized.dismissible) {
    violations.push(
      "NOT_DISMISSIBLE"
    );
  }

  if (normalized.autoplay) {
    violations.push(
      "AUTOPLAY"
    );
  }

  if (normalized.countdown) {
    violations.push(
      "COUNTDOWN"
    );
  }

  if (normalized.forcedViewing) {
    violations.push(
      "FORCED_VIEWING"
    );
  }

  if (
    normalized.rankingInfluence
  ) {
    violations.push(
      "RANKING_INFLUENCE"
    );
  }

  if (normalized.promptAccess) {
    violations.push(
      "PROMPT_ACCESS"
    );
  }

  if (
    normalized.repositoryAccess
  ) {
    violations.push(
      "REPOSITORY_ACCESS"
    );
  }

  if (normalized.outputAccess) {
    violations.push(
      "OUTPUT_ACCESS"
    );
  }

  if (normalized.identityAccess) {
    violations.push(
      "IDENTITY_ACCESS"
    );
  }

  if (
    normalized.dataShared !==
    "none"
  ) {
    violations.push(
      "DATA_SHARING"
    );
  }

  if (
    normalized.influence !==
    "none"
  ) {
    violations.push(
      "OUTPUT_INFLUENCE"
    );
  }

  return {
    experience: normalized,
    violations:
      Object.freeze(
        violations
      )
  };
}

export function validateSponsorCampaign(
  input
) {
  if (
    !input ||
    typeof input !== "object"
  ) {
    throw new TypeError(
      "campaign is required"
    );
  }

  if (
    !input.campaignId ||
    !input.sponsorDisclosure ||
    !input.capabilityType
  ) {
    throw new TypeError(
      "campaignId, sponsorDisclosure, and capabilityType are required"
    );
  }

  assertPositiveInteger(
    input.budgetCredits,
    "budgetCredits"
  );

  if (
    input.maxComputePerGrant !==
      undefined &&
    input.maxComputePerGrant !==
      null
  ) {
    assertPositiveInteger(
      input.maxComputePerGrant,
      "maxComputePerGrant"
    );
  }

  if (
    input.sponsorInstructions !==
      undefined &&
    input.sponsorInstructions !==
      null
  ) {
    throw new Error(
      "sponsor instructions are prohibited"
    );
  }

  const targetingMode =
    String(
      input.targetingMode ??
      "universal"
    );

  if (
    ![
      "universal",
      "contextual"
    ].includes(
      targetingMode
    )
  ) {
    throw new TypeError(
      "targetingMode must be universal or contextual"
    );
  }

  const eligibleTaskClasses =
    normalizeList(
      input.eligibleTaskClasses,
      ["*"]
    );

  if (
    targetingMode ===
      "universal" &&
    !eligibleTaskClasses
      .includes("*")
  ) {
    throw new Error(
      "universal campaigns must allow all task classes"
    );
  }

  const allowedPrivacyModes =
    normalizeList(
      input.allowedPrivacyModes,
      ["blind"]
    );

  const {
    experience,
    violations
  } =
    normalizeExperience(
      input.experience
    );

  if (
    violations.length > 0
  ) {
    throw new Error(
      `sponsor experience violates contract: ${violations.join(",")}`
    );
  }

  const normalized =
    Object.freeze({
      schema:
        "sponsorrail.campaign.v0.11",
      campaignId:
        String(
          input.campaignId
        ),
      sponsorDisclosure:
        String(
          input.sponsorDisclosure
        ),
      capabilityType:
        String(
          input.capabilityType
        ),
      benefitDescription:
        String(
          input.benefitDescription ??
          "Sponsored compute"
        ),
      disclosureLabel:
        String(
          input.disclosureLabel ??
          "Sponsored"
        ),
      targetingMode,
      budgetCredits:
        input.budgetCredits,
      eligibleTaskClasses,
      allowedPrivacyModes,
      maxComputePerGrant:
        input.maxComputePerGrant ??
        null,
      priority:
        Number(
          input.priority ??
          0
        ),
      experience
    });

  if (
    !Number.isFinite(
      normalized.priority
    )
  ) {
    throw new TypeError(
      "priority must be finite"
    );
  }

  return normalized;
}

export function campaignFundingMetadata(
  campaign
) {
  const normalized =
    campaign.schema ===
      "sponsorrail.campaign.v0.11"
      ? campaign
      : validateSponsorCampaign(
          campaign
        );

  return Object.freeze({
    schema:
      "sponsorrail.campaign-funding.v0.11",
    campaignId:
      normalized.campaignId,
    capabilityType:
      normalized.capabilityType,
    benefitDescription:
      normalized
        .benefitDescription,
    disclosureLabel:
      normalized
        .disclosureLabel,
    targetingMode:
      normalized.targetingMode,
    interactionRequired:
      false,
    dismissible:
      true,
    dataShared: "none",
    influence: "none"
  });
}

export function createCampaignPool(
  campaign
) {
  const normalized =
    campaign.schema ===
      "sponsorrail.campaign.v0.11"
      ? campaign
      : validateSponsorCampaign(
          campaign
        );

  return new BlindSponsorPool({
    id:
      `campaign:${normalized.campaignId}`,
    sponsorDisclosure:
      normalized
        .sponsorDisclosure,
    balanceCredits:
      normalized
        .budgetCredits,
    eligibleTaskClasses:
      normalized
        .eligibleTaskClasses,
    allowedPrivacyModes:
      normalized
        .allowedPrivacyModes,
    maxComputePerGrant:
      normalized
        .maxComputePerGrant,
    campaign:
      campaignFundingMetadata(
        normalized
      )
  });
}

export class SponsorCampaignRegistry {
  #campaigns;
  #pools;

  constructor(campaigns = []) {
    this.#campaigns =
      new Map();

    this.#pools =
      new Map();

    for (
      const campaign
      of campaigns
    ) {
      this.register(campaign);
    }
  }

  register(
    campaign,
    {
      replace = false
    } = {}
  ) {
    const normalized =
      validateSponsorCampaign(
        campaign
      );

    if (
      this.#campaigns.has(
        normalized.campaignId
      ) &&
      !replace
    ) {
      throw new Error(
        "campaign already registered"
      );
    }

    this.#campaigns.set(
      normalized.campaignId,
      normalized
    );

    this.#pools.set(
      normalized.campaignId,
      createCampaignPool(
        normalized
      )
    );

    return normalized;
  }

  get(campaignId) {
    return (
      this.#campaigns.get(
        String(campaignId)
      ) ??
      null
    );
  }

  match(
    task,
    {
      allowContextual = false,
      allowedCapabilityTypes = [
        "*"
      ],
      blockedCampaignIds = []
    } = {}
  ) {
    if (
      task?.allowSponsorship ===
      false
    ) {
      return Object.freeze([]);
    }

    const taskClass =
      String(
        task?.taskClass ??
        "software-development"
      );

    const privacy =
      String(
        task?.privacy ??
        "blind"
      );

    const computeRequested =
      Number(
        task?.computeRequested
      );

    assertPositiveInteger(
      computeRequested,
      "computeRequested"
    );

    const capabilityAllow =
      new Set(
        allowedCapabilityTypes
          .map(String)
      );

    const blocked =
      new Set(
        blockedCampaignIds
          .map(String)
      );

    const matches = [];

    for (
      const campaign
      of this.#campaigns
        .values()
    ) {
      if (
        blocked.has(
          campaign.campaignId
        )
      ) {
        continue;
      }

      if (
        !capabilityAllow
          .has("*") &&
        !capabilityAllow
          .has(
            campaign
              .capabilityType
          )
      ) {
        continue;
      }

      if (
        campaign.targetingMode ===
          "contextual" &&
        allowContextual !==
          true
      ) {
        continue;
      }

      const classAllowed =
        campaign
          .eligibleTaskClasses
          .includes("*") ||
        campaign
          .eligibleTaskClasses
          .includes(
            taskClass
          );

      if (!classAllowed) {
        continue;
      }

      if (
        !campaign
          .allowedPrivacyModes
          .includes(
            privacy
          )
      ) {
        continue;
      }

      if (
        campaign
          .maxComputePerGrant !==
            null &&
        computeRequested >
          campaign
            .maxComputePerGrant
      ) {
        continue;
      }

      const pool =
        this.#pools.get(
          campaign.campaignId
        );

      if (
        !pool ||
        pool.availableCredits <
          computeRequested
      ) {
        continue;
      }

      matches.push({
        campaign,
        pool
      });
    }

    matches.sort(
      (a, b) => {
        if (
          a.campaign.priority !==
          b.campaign.priority
        ) {
          return (
            b.campaign.priority -
            a.campaign.priority
          );
        }

        return a.campaign
          .campaignId
          .localeCompare(
            b.campaign
              .campaignId
          );
      }
    );

    return Object.freeze(
      matches.map(
        ({ campaign, pool }) =>
          Object.freeze({
            campaign:
              Object.freeze({
                campaignId:
                  campaign
                    .campaignId,
                sponsorDisclosure:
                  campaign
                    .sponsorDisclosure,
                capabilityType:
                  campaign
                    .capabilityType,
                benefitDescription:
                  campaign
                    .benefitDescription,
                disclosureLabel:
                  campaign
                    .disclosureLabel,
                targetingMode:
                  campaign
                    .targetingMode,
                priority:
                  campaign
                    .priority,
                experience:
                  campaign
                    .experience
              }),
            pool
          })
      )
    );
  }

  poolsFor(
    task,
    preferences = {}
  ) {
    return Object.freeze(
      this.match(
        task,
        preferences
      ).map(
        (entry) =>
          entry.pool
      )
    );
  }
}
