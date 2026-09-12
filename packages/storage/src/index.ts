/**
 * @investigator/storage
 *
 * The four portability seams and their MVP adapters. PostgreSQL, S3/MinIO, Redis/BullMQ, and a
 * central secret manager are designed but unimplemented (ADR-0001); config values naming them are
 * rejected at load with a message that points at the ADR.
 */

export * from "./interfaces.js";
export * from "./migrations.js";
export * from "./sqlite-metadata-store.js";
export * from "./local-artifact-store.js";
export * from "./sqlite-work-queue.js";
export * from "./env-secret-store.js";
export * from "./credential-store.js";
export * from "./workspace.js";
