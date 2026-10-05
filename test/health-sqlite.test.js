import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Worker
} from "node:worker_threads";

import {
  BlindSponsorPool,
  FundingBroker,
  ProviderRegistry,
  ProviderRouter,
  ProviderUnavailableError,
  SignedComputeProvider,
  createProviderKeyPair,
  executeRoutedSponsoredTask,
  loadSqliteHealthBackend
} from "../src/index.js";

const [major, minor] =
  process.versions.node
    .split(".")
    .map(Number);

const sqliteAvailable =
  major > 22 ||
  (
    major === 22 &&
    minor >= 5
  );

function dbPath() {
  const dir =
    mkdtempSync(
      join(
        tmpdir(),
        "sponsorrail-health-"
      )
    );

  return join(
    dir,
    "health.db"
  );
}

function runClaimWorker(
  database,
  providerId,
  now
) {
  return new Promise(
    (resolve, reject) => {
      const worker =
        new Worker(
          new URL(
            "../scripts/test-workers/sqlite-health-claim-worker.mjs",
            import.meta.url
          ),
          {
            workerData: {
              dbPath: database,
              providerId,
              now,
              failureThreshold: 1,
              cooldownMs: 100,
              halfOpenLeaseMs:
                1000
            }
          }
        );

      worker.once(
        "message",
        resolve
      );

      worker.once(
        "error",
        reject
      );

      worker.once(
        "exit",
        (code) => {
          if (code !== 0) {
            reject(
              new Error(
                `worker exited with code ${code}`
              )
            );
          }
        }
      );
    }
  );
}

function providerEntry(
  providerId,
  executor,
  priority = 0
) {
  const keys =
    createProviderKeyPair();

  const provider =
    new SignedComputeProvider({
      providerId,
      privateKey:
        keys.privateKey,
      executor,
      modelClass:
        `test:${providerId}`
    });

  return {
    provider,
    keys,
    registration: {
      providerId,
      provider,
      priority,
      capabilities: [
        "chat",
        "code"
      ]
    }
  };
}

test(
  "SQLite provider health survives tracker restart",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteProviderHealthTracker
    } =
      await loadSqliteHealthBackend();

    const database =
      dbPath();

    const first =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 1000,
          now: () => 1000
        }
      );

    first.recordFailure(
      "provider.flaky",
      {
        code:
          "PROVIDER_OFFLINE"
      }
    );

    assert.equal(
      first.status(
        "provider.flaky"
      ).state,
      "OPEN"
    );

    first.close();

    const restarted =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 1000,
          now: () => 1500
        }
      );

    const status =
      restarted.status(
        "provider.flaky"
      );

    assert.equal(
      status.state,
      "OPEN"
    );

    assert.equal(
      status.failures,
      1
    );

    assert.equal(
      status
        .lastFailureCode,
      "PROVIDER_OFFLINE"
    );

    restarted.close();
  }
);

test(
  "two independent workers cannot both acquire one half-open lease",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteProviderHealthTracker
    } =
      await loadSqliteHealthBackend();

    const database =
      dbPath();

    const setup =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 100,
          halfOpenLeaseMs:
            1000,
          now: () => 1000
        }
      );

    setup.recordFailure(
      "provider.flaky",
      {
        code:
          "PROVIDER_OFFLINE"
      }
    );

    setup.close();

    const [a, b] =
      await Promise.all([
        runClaimWorker(
          database,
          "provider.flaky",
          1200
        ),
        runClaimWorker(
          database,
          "provider.flaky",
          1200
        )
      ]);

    assert.equal(
      [a, b].filter(
        (result) =>
          result.acquired ===
          true
      ).length,
      1
    );

    assert.equal(
      [a, b].filter(
        (result) =>
          result.acquired ===
          false
      ).length,
      1
    );
  }
);

test(
  "half-open lease expires and can be acquired by another process",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteProviderHealthTracker
    } =
      await loadSqliteHealthBackend();

    const database =
      dbPath();

    let now = 1000;

    const first =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 100,
          halfOpenLeaseMs:
            100,
          now: () => now
        }
      );

    first.recordFailure(
      "provider.flaky"
    );

    now = 1200;

    assert.equal(
      first.tryAcquireHalfOpen(
        "provider.flaky"
      ),
      true
    );

    const second =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 100,
          halfOpenLeaseMs:
            100,
          now: () => 1250
        }
      );

    assert.equal(
      second.tryAcquireHalfOpen(
        "provider.flaky"
      ),
      false
    );

    const third =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 100,
          halfOpenLeaseMs:
            100,
          now: () => 1400
        }
      );

    assert.equal(
      third.tryAcquireHalfOpen(
        "provider.flaky"
      ),
      true
    );

    first.close();
    second.close();
    third.close();
  }
);

test(
  "shared durable health routes another router around an open provider",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteProviderHealthTracker
    } =
      await loadSqliteHealthBackend();

    const database =
      dbPath();

    const primary =
      providerEntry(
        "provider.primary",
        async () => {
          throw new ProviderUnavailableError(
            "offline",
            {
              code:
                "PROVIDER_OFFLINE"
            }
          );
        },
        5
      );

    const backup =
      providerEntry(
        "provider.backup",
        async () => ({
          completed: true,
          computeUnitsUsed: 2
        })
      );

    const registry =
      new ProviderRegistry([
        {
          providerId:
            primary.provider
              .providerId,
          publicKey:
            primary.keys
              .publicKey
        },
        {
          providerId:
            backup.provider
              .providerId,
          publicKey:
            backup.keys
              .publicKey
        }
      ]);

    const healthA =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 60_000
        }
      );

    const routerA =
      new ProviderRouter(
        [
          primary.registration,
          backup.registration
        ],
        {
          healthTracker:
            healthA
        }
      );

    const brokerA =
      new FundingBroker([
        new BlindSponsorPool({
          id: "pool-a",
          sponsorDisclosure:
            "Sponsor",
          balanceCredits: 100
        })
      ]);

    await executeRoutedSponsoredTask({
      task: {
        id: "first",
        taskClass:
          "software-development",
        computeRequested: 10,
        privacy: "blind",
        allowSponsorship: true,
        prompt: "private"
      },
      broker:
        brokerA,
      router:
        routerA,
      providerRegistry:
        registry,
      routingPreferences: {
        requiredCapabilities: [
          "chat",
          "code"
        ]
      },
      maxAttempts: 2
    });

    healthA.close();

    const healthB =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 60_000
        }
      );

    const routerB =
      new ProviderRouter(
        [
          primary.registration,
          backup.registration
        ],
        {
          healthTracker:
            healthB
        }
      );

    const discovery =
      await routerB.discover({
        id: "second",
        taskClass:
          "software-development",
        computeRequested: 10,
        privacy: "blind",
        prompt: "private"
      });

    const primaryCandidate =
      discovery.candidates
        .find(
          (candidate) =>
            candidate
              .providerId ===
            "provider.primary"
        );

    assert.equal(
      primaryCandidate
        .circuitState,
      "OPEN"
    );

    assert.equal(
      primaryCandidate
        .eligible,
      false
    );

    healthB.close();
  }
);


test(
  "shared health database rejects conflicting circuit policy",
  {
    skip:
      !sqliteAvailable
  },
  async () => {
    const {
      SqliteProviderHealthTracker
    } =
      await loadSqliteHealthBackend();

    const database =
      dbPath();

    const first =
      new SqliteProviderHealthTracker(
        database,
        {
          failureThreshold: 1,
          cooldownMs: 1000,
          halfOpenLeaseMs:
            500
        }
      );

    first.close();

    assert.throws(
      () =>
        new SqliteProviderHealthTracker(
          database,
          {
            failureThreshold: 2,
            cooldownMs: 1000,
            halfOpenLeaseMs:
              500
          }
        ),
      /configuration mismatch/
    );
  }
);
