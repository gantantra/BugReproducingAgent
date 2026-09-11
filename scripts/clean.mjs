// Remove build output and tsbuildinfo across every workspace.
import { rmSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs = [
  ...readdirSync(join(root, "packages")).map((p) => join(root, "packages", p)),
  join(root, "apps", "cli"),
];

for (const d of dirs) {
  for (const target of ["dist", "tsconfig.tsbuildinfo"]) {
    const p = join(d, target);
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      console.log(`removed ${p.replace(root + "\\", "").replace(root + "/", "")}`);
    }
  }
}
console.log("clean complete");
