import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export const POOL_STORE_SCHEMA =
  "sponsorrail.store.v0.3";

const LEGACY_POOL_STORE_SCHEMA =
  "sponsorrail.pool-store.v0.2";

function emptyState() {
  return {
    schema: POOL_STORE_SCHEMA,
    pools: [],
    grants: [],
    receiptChain: {
      sequence: 0,
      headHash: null
    }
  };
}

export class JsonPoolStore {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError("filePath is required");
    }

    this.filePath = resolve(String(filePath));
  }

  loadState() {
    let document;

    try {
      document = JSON.parse(
        readFileSync(this.filePath, "utf8")
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyState();
      }

      throw error;
    }

    if (
      document.schema === LEGACY_POOL_STORE_SCHEMA &&
      Array.isArray(document.pools)
    ) {
      return {
        ...emptyState(),
        pools: document.pools
      };
    }

    if (
      document.schema !== POOL_STORE_SCHEMA ||
      !Array.isArray(document.pools) ||
      !Array.isArray(document.grants) ||
      !document.receiptChain ||
      !Number.isInteger(
        document.receiptChain.sequence
      )
    ) {
      throw new Error(
        "unsupported SponsorRail store schema"
      );
    }

    return {
      schema: POOL_STORE_SCHEMA,
      pools: document.pools,
      grants: document.grants,
      receiptChain: {
        sequence:
          document.receiptChain.sequence,
        headHash:
          document.receiptChain.headHash ?? null
      }
    };
  }

  saveState({
    pools = [],
    grants = [],
    receiptChain = {
      sequence: 0,
      headHash: null
    }
  }) {
    if (
      !Array.isArray(pools) ||
      !Array.isArray(grants)
    ) {
      throw new TypeError(
        "pools and grants must be arrays"
      );
    }

    mkdirSync(
      dirname(this.filePath),
      { recursive: true }
    );

    const tempPath =
      `${this.filePath}.${process.pid}.tmp`;

    const document = {
      schema: POOL_STORE_SCHEMA,
      pools,
      grants,
      receiptChain
    };

    writeFileSync(
      tempPath,
      `${JSON.stringify(document, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    renameSync(tempPath, this.filePath);
  }

  loadSnapshots() {
    return this.loadState().pools;
  }

  saveSnapshots(snapshots) {
    if (!Array.isArray(snapshots)) {
      throw new TypeError(
        "snapshots must be an array"
      );
    }

    const state = this.loadState();

    this.saveState({
      ...state,
      pools: snapshots
    });
  }
}
