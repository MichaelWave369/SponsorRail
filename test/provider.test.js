import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BlindSponsorPool,
  FundingBroker,
  ProviderRegistry,
  SignedComputeProvider,
  createProviderKeyPair,
  executeSponsoredProviderTask,
  loadSqliteBackend,
  signReceipt,
  verifyProviderUsageReceipt,
  verifyReceiptHash
} from "../src/index.js";

function makeTask(overrides = {}) {
  return {
    id: "provider-task",
    taskClass:
      "software-development",
    computeRequested: 25,
    userMaxCost: 0,
    privacy: "blind",
    allowSponsorship: true,
    prompt:
      "ULTRA_SECRET_PROMPT",
    repositoryContext:
      "TOP_SECRET_SOURCE",
    ...overrides
  };
}

function makeBroker() {
  return new FundingBroker([
    new BlindSponsorPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud Sponsor",
      balanceCredits: 100
    })
  ]);
}

function makeProvider({
  computeUnitsUsed = 17,
  output =
    "PRIVATE_MODEL_OUTPUT",
  now =
    () => 1000
} = {}) {
  const keys =
    createProviderKeyPair();

  const provider =
    new SignedComputeProvider({
      providerId:
        "provider.local.reference",
      privateKey:
        keys.privateKey,
      modelClass:
        "reference-model",
      now,
      executor:
        async () => ({
          completed: true,
          computeUnitsUsed,
          output
        })
    });

  const registry =
    new ProviderRegistry([
      {
        providerId:
          "provider.local.reference",
        publicKey:
          keys.publicKey
      }
    ]);

  return {
    keys,
    provider,
    registry
  };
}

test(
  "provider usage receipts are signed and registry verified",
  async () => {
    const {
      provider,
      registry
    } = makeProvider();

    const run =
      await provider.execute({
        modelContext: {
          taskId: "task",
          prompt: "private",
          repositoryContext:
            "private"
        },
        authorization: {
          grantId: "grant-1",
          computeUnits: 25
        }
      });

    assert.equal(
      verifyProviderUsageReceipt(
        run.usageReceipt,
        registry,
        {
          grantId: "grant-1",
          computeUnits: 25
        }
      ),
      true
    );

    assert.equal(
      verifyProviderUsageReceipt(
        {
          ...run.usageReceipt,
          computeUnitsUsed: 18
        },
        registry,
        {
          grantId: "grant-1",
          computeUnits: 25
        }
      ),
      false
    );
  }
);

test(
  "provider executor receives no sponsor identity",
  async () => {
    const keys =
      createProviderKeyPair();

    let observed;

    const provider =
      new SignedComputeProvider({
        providerId:
          "provider.test",
        privateKey:
          keys.privateKey,
        executor:
          async (envelope) => {
            observed = envelope;

            return {
              completed: true,
              computeUnitsUsed: 5
            };
          }
      });

    const registry =
      new ProviderRegistry([
        {
          providerId:
            "provider.test",
          publicKey:
            keys.publicKey
        }
      ]);

    await executeSponsoredProviderTask({
      task: makeTask({
        computeRequested: 10
      }),
      broker:
        makeBroker(),
      provider,
      providerRegistry:
        registry
    });

    const serialized =
      JSON.stringify(observed);

    assert.equal(
      serialized.includes(
        "ExampleCloud Sponsor"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      true
    );

    assert.deepEqual(
      Object.keys(
        observed.authorization
      ).sort(),
      [
        "computeUnits",
        "grantId"
      ]
    );
  }
);

test(
  "provider-attested execution settles signed usage rather than arbitrary output metadata",
  async () => {
    const broker =
      makeBroker();

    const {
      provider,
      registry
    } = makeProvider({
      computeUnitsUsed: 17
    });

    const execution =
      await executeSponsoredProviderTask({
        task: makeTask(),
        broker,
        provider,
        providerRegistry:
          registry
      });

    const pool =
      broker.pools[0];

    assert.equal(
      execution.funded,
      true
    );

    assert.equal(
      pool.availableCredits,
      83
    );

    assert.equal(
      pool.reservedCredits,
      0
    );

    assert.equal(
      pool.spentCredits,
      17
    );

    assert.equal(
      execution.receipt
        .computeUnitsUsed,
      17
    );

    assert.equal(
      execution.receipt
        .computeUnitsRefunded,
      8
    );

    assert.equal(
      execution.receipt
        .provider
        .signatureVerified,
      true
    );

    assert.equal(
      execution.receipt
        .provider
        .executionContextShared,
      true
    );

    assert.equal(
      execution.receipt
        .provider
        .sponsorIdentityShared,
      false
    );

    assert.equal(
      verifyReceiptHash(
        execution.receipt
      ),
      true
    );
  }
);

test(
  "provider receipt binds usage to the authorized grant",
  async () => {
    const broker =
      makeBroker();

    const keys =
      createProviderKeyPair();

    const registry =
      new ProviderRegistry([
        {
          providerId:
            "provider.bad-binding",
          publicKey:
            keys.publicKey
        }
      ]);

    const provider = {
      async execute({
        authorization
      }) {
        return {
          result: {
            completed: true,
            computeUnitsUsed: 10
          },
          usageReceipt:
            signReceipt(
              {
                schema:
                  "sponsorrail.provider-usage.v0.6",
                usageId:
                  "forged-binding",
                providerId:
                  "provider.bad-binding",
                grantId:
                  "different-grant",
                usageMetric:
                  "compute-units",
                modelClass:
                  "test",
                computeUnitsAuthorized:
                  authorization
                    .computeUnits,
                computeUnitsUsed: 10,
                completed: true,
                startedAt:
                  "2026-10-04T00:00:00.000Z",
                completedAt:
                  "2026-10-04T00:00:01.000Z"
              },
              keys.privateKey
            )
        };
      }
    };

    await assert.rejects(
      () =>
        executeSponsoredProviderTask({
          task: makeTask(),
          broker,
          provider,
          providerRegistry:
            registry
        }),
      /provider usage receipt verification failed/
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      broker.pools[0]
        .reservedCredits,
      0
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      0
    );
  }
);

test(
  "provider failure releases sponsor reservation",
  async () => {
    const broker =
      makeBroker();

    const keys =
      createProviderKeyPair();

    const provider =
      new SignedComputeProvider({
        providerId:
          "provider.crash",
        privateKey:
          keys.privateKey,
        executor:
          async () => {
            throw new Error(
              "provider unavailable"
            );
          }
      });

    const registry =
      new ProviderRegistry([
        {
          providerId:
            "provider.crash",
          publicKey:
            keys.publicKey
        }
      ]);

    await assert.rejects(
      () =>
        executeSponsoredProviderTask({
          task: makeTask(),
          broker,
          provider,
          providerRegistry:
            registry
        }),
      /provider unavailable/
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      broker.pools[0]
        .reservedCredits,
      0
    );
  }
);

test(
  "unregistered provider receipts are rejected",
  async () => {
    const {
      provider
    } = makeProvider();

    const run =
      await provider.execute({
        modelContext: {
          taskId: "task",
          prompt: "private",
          repositoryContext: ""
        },
        authorization: {
          grantId: "grant",
          computeUnits: 25
        }
      });

    const emptyRegistry =
      new ProviderRegistry();

    assert.equal(
      verifyProviderUsageReceipt(
        run.usageReceipt,
        emptyRegistry,
        {
          grantId: "grant",
          computeUnits: 25
        }
      ),
      false
    );
  }
);

test(
  "provider and SponsorRail receipts omit prompt source and model output",
  async () => {
    const {
      provider,
      registry
    } = makeProvider();

    const execution =
      await executeSponsoredProviderTask({
        task: makeTask(),
        broker:
          makeBroker(),
        provider,
        providerRegistry:
          registry
      });

    const serialized =
      JSON.stringify({
        sponsorRail:
          execution.receipt,
        provider:
          execution
            .providerUsageReceipt
      });

    assert.equal(
      serialized.includes(
        "ULTRA_SECRET_PROMPT"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "TOP_SECRET_SOURCE"
      ),
      false
    );

    assert.equal(
      serialized.includes(
        "PRIVATE_MODEL_OUTPUT"
      ),
      false
    );
  }
);

test(
  "provider-reported usage cannot exceed grant authority",
  async () => {
    const broker =
      makeBroker();

    const {
      provider,
      registry
    } = makeProvider({
      computeUnitsUsed: 26
    });

    await assert.rejects(
      () =>
        executeSponsoredProviderTask({
          task: makeTask(),
          broker,
          provider,
          providerRegistry:
            registry
        }),
      /provider reported usage above authorization/
    );

    assert.equal(
      broker.pools[0]
        .availableCredits,
      100
    );

    assert.equal(
      broker.pools[0]
        .spentCredits,
      0
    );
  }
);

test(
  "provider-attested flow works on SQLite transactional broker",
  {
    skip:
      Number(
        process.versions.node
          .split(".")[0]
      ) < 22
  },
  async () => {
    const {
      SqliteFundingBroker
    } =
      await loadSqliteBackend();

    const dir =
      mkdtempSync(
        join(
          tmpdir(),
          "sponsorrail-provider-"
        )
      );

    const broker =
      new SqliteFundingBroker(
        join(
          dir,
          "provider.db"
        )
      );

    broker.createPool({
      id: "pool",
      sponsorDisclosure:
        "ExampleCloud Sponsor",
      balanceCredits: 100
    });

    const {
      provider,
      registry
    } = makeProvider({
      computeUnitsUsed: 12
    });

    const execution =
      await executeSponsoredProviderTask({
        task: makeTask({
          computeRequested: 20
        }),
        broker,
        provider,
        providerRegistry:
          registry
      });

    const pool =
      broker.poolSnapshot(
        "pool"
      );

    assert.equal(
      pool.availableCredits,
      88
    );

    assert.equal(
      pool.spentCredits,
      12
    );

    assert.equal(
      execution.receipt
        .provider
        .signatureVerified,
      true
    );

    assert.equal(
      broker
        .receiptJournal()
        .length,
      1
    );

    broker.close();
  }
);
