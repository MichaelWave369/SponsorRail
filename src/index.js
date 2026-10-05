export {
  BlindSponsorPool,
  FundingBroker,
  buildExecutionAuthorization,
  buildModelContext,
  createReceiptKeyPair,
  evaluatePolicy,
  executeSponsoredTask,
  sanitizeFundingRequest,
  signReceipt,
  verifyReceipt,
  verifyReceiptChain,
  verifyReceiptHash
} from "./sponsorrail.js";

export {
  JsonPoolStore,
  POOL_STORE_SCHEMA
} from "./store.js";

export async function loadSqliteBackend() {
  return import("./sqlite.js");
}

export {
  ProviderRegistry,
  ProviderUnavailableError,
  SignedComputeProvider,
  createProviderKeyPair,
  executeSponsoredProviderTask,
  isSafeProviderRetry,
  verifyProviderUsageReceipt
} from "./provider.js";

export {
  OllamaChatProvider
} from "./providers/ollama.js";

export {
  ProviderRouter,
  executeRoutedSponsoredTask
} from "./router.js";

export {
  ProviderHealthTracker
} from "./health.js";

export async function loadSqliteHealthBackend() {
  return import("./health-sqlite.js");
}

export {
  SponsorCampaignRegistry,
  campaignFundingMetadata,
  createCampaignPool,
  validateSponsorCampaign
} from "./campaign.js";

export {
  FundingSourceRegistry,
  SignedFundingSource,
  createFundingSourceKeyPair,
  verifyFundingDeposit
} from "./funding.js";
