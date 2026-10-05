import {
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

if (!sqliteAvailable) {
  console.log(
    "Durable health demo skipped: node:sqlite requires Node 22.5+."
  );
} else {
  const {
    mkdtempSync
  } =
    await import(
      "node:fs"
    );

  const {
    join
  } =
    await import(
      "node:path"
    );

  const {
    tmpdir
  } =
    await import(
      "node:os"
    );

  const {
    SqliteProviderHealthTracker
  } =
    await loadSqliteHealthBackend();

  const database =
    join(
      mkdtempSync(
        join(
          tmpdir(),
          "sponsorrail-health-demo-"
        )
      ),
      "health.db"
    );

  let now = 1000;

  const first =
    new SqliteProviderHealthTracker(
      database,
      {
        failureThreshold: 1,
        cooldownMs: 100,
        halfOpenLeaseMs: 500,
        now: () => now
      }
    );

  console.log(
    "Initial:",
    first.status(
      "provider.demo"
    )
  );

  first.recordFailure(
    "provider.demo",
    {
      code:
        "DEMO_UNAVAILABLE"
    }
  );

  console.log(
    "After failure:",
    first.status(
      "provider.demo"
    )
  );

  first.close();

  now = 1200;

  const restarted =
    new SqliteProviderHealthTracker(
      database,
      {
        failureThreshold: 1,
        cooldownMs: 100,
        halfOpenLeaseMs: 500,
        now: () => now
      }
    );

  console.log(
    "After restart:",
    restarted.status(
      "provider.demo"
    )
  );

  console.log(
    "Half-open lease acquired:",
    restarted
      .tryAcquireHalfOpen(
        "provider.demo"
      )
  );

  restarted.recordSuccess(
    "provider.demo"
  );

  console.log(
    "After successful trial:",
    restarted.status(
      "provider.demo"
    )
  );

  restarted.close();
}
