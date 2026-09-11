// The reliability strategy requires the nine non-performance gate specs to run TWICE in the
// same CI job: a test that passes once and fails once fails the gate.
//
// The performance spec is excluded from the repeat because it is a wall-clock budget
// measurement, not a flake check, and running it twice would double CI time for no signal.
import { spawnSync } from "node:child_process";

const PERF = "same_test_100_runs";
const args = ["vitest", "run", "--project", "reliability"];

for (const pass of [1, 2]) {
  const extra = pass === 2 ? ["--exclude", `**/${PERF}.spec.ts`] : [];
  console.log(`\n=== reliability gate, pass ${pass} of 2 ===\n`);
  const r = spawnSync("npx", [...args, ...extra], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) {
    console.error(`\nreliability gate FAILED on pass ${pass}`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nreliability gate passed twice");
