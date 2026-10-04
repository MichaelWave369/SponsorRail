import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BlindSponsorPool,
  FundingBroker,
  JsonPoolStore,
  buildExecutionAuthorization,
  buildModelContext,
  createReceiptKeyPair,
  evaluatePolicy,
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

function makePool(overrides = {}) {
  return new BlindSponsorPool({
    id: "pool",
    sponsorDisclosure: "ExampleCloud",
    balanceCredits: 100,
    ...overrides
  });
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

test("policy matcher rejects task class, privacy mode, and oversized grants", () => {
  const policy = {
    eligibleTaskClasses: ["software-development"],
    allowedPrivacyModes: ["blind"],
    maxComputePerGrant: 50
  };

  assert.equal(
    evaluatePolicy(sanitizeFundingRequest(makeTask()), policy).eligible,
    true
  );

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(makeTask({ taskClass: "research" })),
      policy
    ).reason,
    "TASK_CLASS_NOT_ELIGIBLE"
  );

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(makeTask({ privacy: "contextual" })),
      policy
    ).reason,
    "PRIVACY_MODE_NOT_ELIGIBLE"
  );

  assert.equal(
    evaluatePolicy(
      sanitizeFundingRequest(makeTask({ computeRequested: 51 })),
      policy
    ).reason,
    "GRANT_LIMIT_EXCEEDED"
  );
});

test("authorization reserves credits without spending them", () => {
  const pool = makePool();
  const broker = new FundingBroker([pool]);

  const grant = broker.authorize(makeTask());

  assert.equal(grant.funded, true);
  assert.equal(pool.availableCredits, 75);
  assert.equal(pool.reservedCredits, 25);
  assert.equal(pool.spentCredits, 0);
  assert.equal(pool.totalCredits, 100);
});

test("settlement spends actual usage and refunds unused reservation", () => {
  const pool = makePool();
  const broker = new FundingBroker([pool]);

  const grant = broker.authorize(makeTask());
  const settlement = broker.settle(grant, 17);

  assert.deepEqual(settlement, {
    reservedUnits: 25,
    usedUnits: 17,
    refundUnits: 8
  });

  assert.equal(pool.availableCredits, 83);
  assert.equal(pool.reservedCredits, 0);
  assert.equal(pool.spentCredits, 17);
  assert.equal(pool.totalCredits, 100);
});

test("failed execution releases the full reservation", async () => {
  const pool = makePool();
  const broker = new FundingBroker([pool]);

  await assert.rejects(
    () =>
      executeSponsoredTask({
        task: makeTask(),
        broker,
        runner: async () => {
          throw new Error("agent crashed");
        }
      }),
    /agent crashed/
  );

  assert.equal(pool.availableCredits, 100);
  assert.equal(pool.reservedCredits, 0);
  assert.equal(pool.spentCredits, 0);
});

test("invalid over-reporting releases reservation rather than charging sponsor", async () => {
  const pool = makePool();
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

  assert.equal(pool.availableCredits, 100);
  assert.equal(pool.spentCredits, 0);
});

test("user can decline sponsorship", () => {
  const pool = makePool();
  const broker = new FundingBroker([pool]);

  const grant = broker.authorize(
    makeTask({ allowSponsorship: false })
  );

  assert.deepEqual(grant, {
    funded: false,
    reason: "SPONSORSHIP_DECLINED"
  });

  assert.equal(pool.balanceCredits, 100);
});

test("sponsored execution emits v0.2 receipt with settlement evidence", async () => {
  const pool = makePool();
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

  assert.equal(
    execution.receipt.schema,
    "sponsorrail.receipt.v0.2"
  );
  assert.equal(pool.balanceCredits, 83);
  assert.equal(execution.receipt.computeUnitsAuthorized, 25);
  assert.equal(execution.receipt.computeUnitsUsed, 17);
  assert.equal(execution.receipt.computeUnitsRefunded, 8);
  assert.equal(execution.receipt.sponsorContributionCredits, 17);
  assert.equal(
    verifyReceipt(execution.receipt, keys.publicKey),
    true
  );

  const envelopeText = JSON.stringify(
    observedExecutionEnvelope
  );
  assert.equal(
    envelopeText.includes("ExampleCloud"),
    false
  );
  assert.equal(
    envelopeText.includes("Use our database"),
    false
  );

  const receiptText = JSON.stringify(execution.receipt);
  assert.equal(
    receiptText.includes("Secret prompt"),
    false
  );
  assert.equal(
    receiptText.includes("SECRET_SOURCE_CODE"),
    false
  );
  assert.equal(
    receiptText.includes("private result"),
    false
  );
});

test("pool snapshots persist only coarse reservation metadata and survive restart", () => {
  const dir = mkdtempSync(
    join(tmpdir(), "sponsorrail-")
  );
  const storePath = join(dir, "pools.json");
  const store = new JsonPoolStore(storePath);

  const pool = makePool({
    eligibleTaskClasses: [
      "software-development"
    ],
    maxComputePerGrant: 50
  });

  const broker = new FundingBroker(
    [pool],
    { store }
  );

  const grant = broker.authorize(makeTask());

  const raw = readFileSync(storePath, "utf8");

  assert.equal(
    raw.includes("Secret prompt"),
    false
  );
  assert.equal(
    raw.includes("SECRET_SOURCE_CODE"),
    false
  );
  assert.equal(
    raw.includes("private-task"),
    true
  );

  const restarted = new FundingBroker(
    [],
    { store }
  );

  assert.equal(restarted.pools.length, 1);
  assert.equal(
    restarted.pools[0].availableCredits,
    75
  );
  assert.equal(
    restarted.pools[0].reservedCredits,
    25
  );
  assert.equal(
    restarted.pools[0].totalCredits,
    100
  );

  assert.throws(
    () => restarted.settle(grant, 10),
    /unknown grant/
  );
});
