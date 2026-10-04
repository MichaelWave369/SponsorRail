import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";

export const POOL_STORE_SCHEMA =
  "sponsorrail.store.v0.4";

const V03_STORE_SCHEMA =
  "sponsorrail.store.v0.3";

const V02_STORE_SCHEMA =
  "sponsorrail.pool-store.v0.2";

function emptyState() {
  return {
    schema: POOL_STORE_SCHEMA,
    pools: [],
    grants: [],
    settlements: [],
    receiptChain: {
      sequence: 0,
      headHash: null
    }
  };
}

export class JsonPoolStore {
  constructor(filePath) {
    if (!filePath) {
      throw new TypeError(
        "filePath is required"
      );
    }

    this.filePath =
      resolve(String(filePath));

    this.journalPath =
      `${this.filePath}.receipts.ndjson`;
  }

  loadState() {
    let document;

    try {
      document = JSON.parse(
        readFileSync(
          this.filePath,
          "utf8"
        )
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyState();
      }

      throw error;
    }

    if (
      document.schema ===
        V02_STORE_SCHEMA &&
      Array.isArray(document.pools)
    ) {
      return {
        ...emptyState(),
        pools: document.pools
      };
    }

    if (
      document.schema ===
      V03_STORE_SCHEMA
    ) {
      if (
        !Array.isArray(
          document.pools
        ) ||
        !Array.isArray(
          document.grants
        )
      ) {
        throw new Error(
          "unsupported SponsorRail v0.3 store document"
        );
      }

      return {
        schema:
          POOL_STORE_SCHEMA,
        pools: document.pools,
        grants: document.grants,
        settlements: [],
        receiptChain: {
          sequence:
            document.receiptChain
              ?.sequence ?? 0,
          headHash:
            document.receiptChain
              ?.headHash ?? null
        }
      };
    }

    if (
      document.schema !==
        POOL_STORE_SCHEMA ||
      !Array.isArray(
        document.pools
      ) ||
      !Array.isArray(
        document.grants
      ) ||
      !Array.isArray(
        document.settlements
      ) ||
      !document.receiptChain ||
      !Number.isInteger(
        document.receiptChain
          .sequence
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
      settlements:
        document.settlements,
      receiptChain: {
        sequence:
          document.receiptChain
            .sequence,
        headHash:
          document.receiptChain
            .headHash ?? null
      }
    };
  }

  saveState({
    pools = [],
    grants = [],
    settlements = [],
    receiptChain = {
      sequence: 0,
      headHash: null
    }
  }) {
    if (
      !Array.isArray(pools) ||
      !Array.isArray(grants) ||
      !Array.isArray(settlements)
    ) {
      throw new TypeError(
        "pools, grants, and settlements must be arrays"
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
      settlements,
      receiptChain
    };

    writeFileSync(
      tempPath,
      `${JSON.stringify(
        document,
        null,
        2
      )}\n`,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    renameSync(
      tempPath,
      this.filePath
    );
  }

  loadReceiptJournal() {
    let raw;

    try {
      raw = readFileSync(
        this.journalPath,
        "utf8"
      );
    } catch (error) {
      if (error?.code === "ENOENT") {
        return [];
      }

      throw error;
    }

    return raw
      .split("\n")
      .filter(Boolean)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch {
          throw new Error(
            `invalid receipt journal entry at line ${index + 1}`
          );
        }
      });
  }

  appendReceipt(receipt) {
    if (
      !receipt?.chain
        ?.receiptHash
    ) {
      throw new TypeError(
        "receipt with chain hash is required"
      );
    }

    const existing =
      this.loadReceiptJournal();

    const duplicate =
      existing.find(
        (entry) =>
          entry.chain
            ?.receiptHash ===
          receipt.chain
            .receiptHash
      );

    if (duplicate) {
      return false;
    }

    mkdirSync(
      dirname(this.journalPath),
      { recursive: true }
    );

    appendFileSync(
      this.journalPath,
      `${JSON.stringify(
        receipt
      )}\n`,
      {
        encoding: "utf8",
        mode: 0o600
      }
    );

    return true;
  }

  loadSnapshots() {
    return this.loadState().pools;
  }

  saveSnapshots(snapshots) {
    if (
      !Array.isArray(snapshots)
    ) {
      throw new TypeError(
        "snapshots must be an array"
      );
    }

    const state =
      this.loadState();

    this.saveState({
      ...state,
      pools: snapshots
    });
  }
}
