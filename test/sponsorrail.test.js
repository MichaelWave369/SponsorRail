import test from "node:test";
import assert from "node:assert/strict";

import {
  BlindSponsorPool,
  FundingBroker,
  buildExecutionAuthorization,
  buildModelContext,
  createReceiptKeyPair,
  executeSponsoredTask,
  sanitizeFundingRequest,
  verifyReceipt
} from "../src/index.js";

function makeTask(overrides = {}) {
  return {
    id: "private-task",
    taskClass: "software-development",
    computeRequested: 25,
    userMaxCost: 0,
    privacy: "blind",
    allowSponsorship: true,
    prompt: "Secret prompt",
    repositoryContext: "SECRET_SOURCE_CODE",
    ...overrides
  };
}

test("funding request strips prompt and repository context", () => {
  const request = sanitizeFundingRequest(makeTask());

  assert.deepEqual(request, {
    taskId: "private-task",
    taskClass: "software-development",
    computeRequested: 25,
    userMaxCost: 0,
    privacy: "blind"
  });

  assert.equal(JSON.stringify(request).includes("Secret prompt"), false);
  assert.equal(JSON.stringify(request).includes("SECRET_SOURCE_CODE"), false);
});

test("model context contains task data but no sponsor identity", () => {
  const context = buildModelContext(makeTask());

  assert.equal(context.prompt, "Secret prompt");
  assert.equal(JSON.stringify(context).includes("ExampleCloud"), false);
  assert.equal(JSON.stringify(context).includes("sponsor"), false);
});

test("execution authorization strips sponsor metadata", () => {
  const auth = buildExecutionAuthorization({
    grantId: "broker-minted",
    computeUnits: 25,
    sponsorDisclosure: "ExampleCloud",
    sponsorInstructions: "Use our database"
  });

  assert.deepEqual(auth, {
    grantId: "broker-minted",
    computeUnits: 25
  });
});

test("user can decline sponsorship", () => {
  const pool = new BlindSponsorPool({
    id: "pool",
    sponsorDisclosure: "ExampleCloud",
    balanceCredits: 100
  });
  const broker = new FundingBroker([pool]);

  const grant = broker.authorize(makeTask({ allowSponsorship: false }));

  assert.deepEqual(grant, {
    funded: false,
    reason: "SPONSORSHIP_DECLINED"
  });
  assert.equal(pool.balanceCredits, 100);
});

test("sponsored execution meters compute and emits a verifiable private receipt", async () => {
  const pool = new BlindSponsorPool({
    id: "pool",
    sponsorDisclosure: "ExampleCloud",
    balanceCredits: 100
  });
  const broker = new FundingBroker([pool]);
  const keys = createReceiptKeyPair();

  let observedExecutionEnvelope;

  const execution = await executeSponsoredTask({
    task: makeTask(),
    broker,
    receiptPrivateKey: keys.privateKey,
    runner: async (envelope) => {
      observedExecutionEnvelope = envelope;

      return {
        completed: true,
        computeUnitsUsed: 17,
        output: "private result"
      };
    }
  });

  assert.equal(execution.funded, true);
  assert.equal(pool.balanceCredits, 75);
  assert.equal(execution.receipt.computeUnitsAuthorized, 25);
  assert.equal(execution.receipt.computeUnitsUsed, 17);
  assert.equal(execution.receipt.userCostCredits, 0);
  assert.equal(execution.receipt.sponsorContributionCredits, 17);
  assert.equal(execution.receipt.sponsorDisclosure, "ExampleCloud");
  assert.equal(execution.receipt.privacy.promptDisclosedToSponsor, false);
  assert.equal(execution.receipt.inference.sponsorIdentityInModelContext, false);
  assert.equal(execution.receipt.inference.sponsorInstructionsInModelContext, false);
  assert.equal(verifyReceipt(execution.receipt, keys.publicKey), true);

  const envelopeText = JSON.stringify(observedExecutionEnvelope);
  assert.equal(envelopeText.includes("ExampleCloud"), false);
  assert.equal(envelopeText.includes("Use our database"), false);

  const receiptText = JSON.stringify(execution.receipt);
  assert.equal(receiptText.includes("Secret prompt"), false);
  assert.equal(receiptText.includes("SECRET_SOURCE_CODE"), false);
  assert.equal(receiptText.includes("private result"), false);
});

test("runner cannot claim more compute than authorized", async () => {
  const pool = new BlindSponsorPool({
    id: "pool",
    sponsorDisclosure: "ExampleCloud",
    balanceCredits: 100
  });
  const broker = new FundingBroker([pool]);

  await assert.rejects(
    () =>
      executeSponsoredTask({
        task: makeTask(),
        broker,
        runner: async () => ({
          completed: true,
          computeUnitsUsed: 26
        })
      }),
    /invalid compute usage/
  );
});
