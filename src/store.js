import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const POOL_STORE_SCHEMA = "sponsorrail.pool-store.v0.2";

export class JsonPoolStore {
  constructor(filePath) {
    if (!filePath) throw new TypeError("filePath is required");
    this.filePath = resolve(String(filePath));
  }

  loadSnapshots() {
    try {
      const document = JSON.parse(readFileSync(this.filePath, "utf8"));

      if (document.schema !== POOL_STORE_SCHEMA || !Array.isArray(document.pools)) {
        throw new Error("unsupported SponsorRail pool store schema");
      }

      return document.pools;
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  saveSnapshots(snapshots) {
    if (!Array.isArray(snapshots)) {
      throw new TypeError("snapshots must be an array");
    }

    mkdirSync(dirname(this.filePath), { recursive: true });

    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    const document = {
      schema: POOL_STORE_SCHEMA,
      pools: snapshots
    };

    writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });

    renameSync(tempPath, this.filePath);
  }
}
