import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactKind, ArtifactRef, Clock } from "@investigator/core";
import { fail, sha256Hex, sha256Prefixed, systemClock } from "@investigator/core";
import { assertRedactionStamp } from "./sqlite-metadata-store.js";
import type {
  ArtifactFilter,
  ArtifactStore,
  MetadataStore,
  PutArtifactRequest,
} from "./interfaces.js";

/**
 * Local filesystem ArtifactStore (ADR-0004).
 *
 *  - The store computes the hash. A caller-supplied hash is ignored, which removes the class of
 *    bug where a wrong hash is recorded alongside correct bytes.
 *  - `redactionApplied` is required by the request type, and re-checked here, so there is no code
 *    path that persists without proof redaction ran.
 *  - Content-addressed with a two-character shard, so 100 identical fixture screenshots occupy
 *    one file while each keeps its own ref and provenance.
 *  - No update method. Deletion happens only through `tombstone`, which keeps the ref and the
 *    recorded hash so a later reference resolves as expired rather than as fabricated.
 *
 * Bytes are written and hashed OUTSIDE the metadata transaction; only the ref row goes inside one
 * (ADR-0002). That ordering is what makes the crash-consistency sequence in the queue model work.
 */

const KIND_PREFIX: Record<ArtifactKind, string> = {
  trace: "TRACE",
  video: "VIDEO",
  screenshot: "SHOT",
  "dom-snapshot": "DOM",
  "network-log": "NET",
  "console-log": "CONSOLE",
  "storage-snapshot": "STORAGE",
  "raw-event-log": "RAWLOG",
  "normalized-evidence": "NORM",
  "run-manifest": "MANIFEST",
  proposal: "PROPOSAL",
  "effective-proposal": "EFFPROPOSAL",
  "approval-file": "APPROVALFILE",
  "intake-report": "REPORT",
  statistics: "STATS",
  "reproducer-package": "REPRO",
  report: "RPTOUT",
  "reset-script-output": "RESET",
  "storage-state": "STATE",
};

const EXTENSION: Partial<Record<ArtifactKind, string>> = {
  trace: "zip",
  video: "webm",
  screenshot: "png",
  "dom-snapshot": "html",
  "network-log": "jsonl",
  "console-log": "jsonl",
  "storage-snapshot": "json",
  "raw-event-log": "jsonl",
  "normalized-evidence": "json",
  "run-manifest": "json",
  proposal: "json",
  "effective-proposal": "json",
  "approval-file": "yaml",
  "intake-report": "md",
  statistics: "json",
  "reproducer-package": "zip",
  report: "md",
  "reset-script-output": "txt",
  "storage-state": "json",
};

export interface LocalArtifactStoreOptions {
  /** Investigation directory root, e.g. `.investigator/investigations`. */
  root: string;
  metadata: MetadataStore;
  clock?: Clock;
}

export class LocalArtifactStore implements ArtifactStore {
  private readonly root: string;
  private readonly metadata: MetadataStore;
  private readonly clock: Clock;

  constructor(opts: LocalArtifactStoreOptions) {
    this.root = opts.root;
    this.metadata = opts.metadata;
    this.clock = opts.clock ?? systemClock;
  }

  private dirFor(investigationId: string, kind: ArtifactKind, hashHex: string): string {
    return join(this.root, investigationId, "artifacts", kind, hashHex.slice(0, 2));
  }

  private pathFor(
    investigationId: string,
    kind: ArtifactKind,
    hashHex: string
  ): { dir: string; file: string } {
    const dir = this.dirFor(investigationId, kind, hashHex);
    const ext = EXTENSION[kind] ?? "bin";
    return { dir, file: join(dir, `${hashHex}.${ext}`) };
  }

  async put(req: PutArtifactRequest): Promise<ArtifactRef> {
    // Fail closed before touching the disk.
    assertRedactionStamp(req.redactionApplied, req.filename);

    const bytes = typeof req.bytes === "string" ? Buffer.from(req.bytes, "utf8") : Buffer.from(req.bytes);
    const hashHex = sha256Hex(bytes);
    const { dir, file } = this.pathFor(req.investigationId, req.kind, hashHex);

    mkdirSync(dir, { recursive: true });
    // Content-addressed, so an identical body is already correct on disk. Writing it again would
    // be harmless but wasteful, and skipping keeps `put` idempotent under retry.
    if (!existsSync(file)) {
      try {
        writeFileSync(file, bytes);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (/ENOSPC/.test(message)) {
          fail("STORE_DISK_FULL", "Disk full while writing artifact", {
            context: { filename: req.filename, bytes: bytes.byteLength },
            cause: e,
          });
        }
        fail("INTERNAL", `Cannot write artifact: ${message}`, {
          context: { filename: req.filename },
          cause: e,
        });
      }
    }

    const artifactId =
      req.artifactId ??
      `${KIND_PREFIX[req.kind]}-${req.runId ? `${req.runId.replace(/^RUN-/, "")}-` : ""}${hashHex.slice(0, 8)}`;

    const ref: ArtifactRef = {
      artifactId,
      kind: req.kind,
      filename: req.filename,
      contentType: req.contentType,
      byteLength: bytes.byteLength,
      sha256: sha256Prefixed(bytes),
      storedAt: this.clock.nowIso(),
      redactionApplied: req.redactionApplied,
      tombstoned: false,
    };
    if (req.runId) ref.runId = req.runId;

    // Ref row inside a short transaction; the bytes are already durable and hashed.
    await this.metadata.tx(async (t) => {
      const existing = await t.getArtifactRef(artifactId);
      if (existing) {
        if (existing.sha256 !== ref.sha256) {
          fail("ARTIFACT_HASH_MISMATCH", "Artifact id already exists with different content", {
            context: { artifactId, existing: existing.sha256, incoming: ref.sha256 },
          });
        }
        return;
      }
      await t.insertArtifactRef({ ...ref, investigationId: req.investigationId });
    });

    return ref;
  }

  private async resolve(ref: ArtifactRef | string): Promise<ArtifactRef & { investigationId: string }> {
    if (typeof ref !== "string") {
      const row = await this.metadata.read((t) => t.getArtifactRef(ref.artifactId));
      if (!row) {
        fail("INTERNAL", "Artifact ref is not registered", { context: { artifactId: ref.artifactId } });
      }
      return row;
    }
    const row = await this.metadata.read((t) => t.getArtifactRef(ref));
    if (!row) fail("INTERNAL", "Unknown artifact id", { context: { artifactId: ref } });
    return row;
  }

  async get(ref: ArtifactRef | string): Promise<Uint8Array> {
    const row = await this.resolve(ref);
    if (row.tombstoned) {
      fail("EVIDENCE_CATEGORY_MISSING", "Artifact was expired by retention", {
        context: { artifactId: row.artifactId, reason: row.tombstoneReason ?? null },
      });
    }
    const hashHex = row.sha256.replace(/^sha256:/, "");
    const { file } = this.pathFor(row.investigationId, row.kind, hashHex);
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (e) {
      fail("EVIDENCE_CORRUPTED", "Artifact bytes are missing from disk", {
        context: { artifactId: row.artifactId },
        cause: e,
      });
    }
    // Verify on read. An artifact that fails here would otherwise silently support a claim.
    const observed = sha256Prefixed(bytes);
    if (observed !== row.sha256) {
      fail("ARTIFACT_HASH_MISMATCH", "Artifact content does not match its recorded hash", {
        context: { artifactId: row.artifactId, expected: row.sha256, observed },
      });
    }
    return bytes;
  }

  async getText(ref: ArtifactRef | string): Promise<string> {
    return Buffer.from(await this.get(ref)).toString("utf8");
  }

  async head(ref: ArtifactRef | string): Promise<ArtifactRef> {
    return this.resolve(ref);
  }

  async verify(ref: ArtifactRef | string): Promise<{ ok: boolean; observedSha256: string }> {
    const row = await this.resolve(ref);
    const hashHex = row.sha256.replace(/^sha256:/, "");
    const { file } = this.pathFor(row.investigationId, row.kind, hashHex);
    if (!existsSync(file)) return { ok: false, observedSha256: "" };
    const bytes = readFileSync(file);
    const observed = sha256Prefixed(bytes);
    const sizeOk = statSync(file).size === row.byteLength;
    return { ok: observed === row.sha256 && sizeOk, observedSha256: observed };
  }

  async list(investigationId: string, filter?: ArtifactFilter): Promise<ArtifactRef[]> {
    const rows = await this.metadata.read((t) => t.listArtifactRefs(investigationId, filter?.kind));
    return rows.filter((r) => {
      if (filter?.runId && r.runId !== filter.runId) return false;
      if (!filter?.includeTombstoned && r.tombstoned) return false;
      return true;
    });
  }

  async tombstone(ref: ArtifactRef | string, reason: string): Promise<ArtifactRef> {
    const row = await this.resolve(ref);
    const hashHex = row.sha256.replace(/^sha256:/, "");
    const { file } = this.pathFor(row.investigationId, row.kind, hashHex);
    const at = this.clock.nowIso();

    // The row keeps the hash and byte length, so a restored backup copy can still be verified
    // against the claim it supported (ADR-0018).
    const db = (this.metadata as unknown as { raw(): { prepare(s: string): { run(...a: unknown[]): unknown } } }).raw();
    db.prepare(
      "UPDATE artifact_refs SET tombstoned = 1, tombstoned_at = ?, tombstone_reason = ? WHERE artifact_id = ?"
    ).run(at, reason, row.artifactId);

    if (existsSync(file)) {
      // Only remove the blob if no other live ref points at the same content.
      const stillReferenced = await this.metadata.read(async (t) => {
        const all = await t.listArtifactRefs(row.investigationId, row.kind);
        return all.some((r) => r.sha256 === row.sha256 && !r.tombstoned);
      });
      if (!stillReferenced) {
        const { rmSync } = await import("node:fs");
        rmSync(file, { force: true });
      }
    }

    return { ...row, tombstoned: true, tombstonedAt: at, tombstoneReason: reason };
  }
}

export const ARTIFACT_KIND_PREFIX = KIND_PREFIX;
export const ARTIFACT_EXTENSION = EXTENSION;
