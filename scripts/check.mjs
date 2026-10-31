import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { projectRoot, validateProject } from "./package-lib.mjs";

if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required");
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--tag")) throw new Error("Usage: node scripts/check.mjs [--tag vX.Y.Z]");
const { pkg, files } = await validateProject(projectRoot, { tag: args[1] });
const scripts = files.filter(file => file.name.endsWith(".js")).map(file => path.join(projectRoot, "addon", file.name));
async function collect(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(filename);
    else if (/\.(?:js|mjs)$/.test(entry.name)) scripts.push(filename);
  }
}
await collect(path.join(projectRoot, "scripts"));
await collect(path.join(projectRoot, "tests"));
for (const filename of scripts) {
  const result = spawnSync(process.execPath, ["--check", filename], { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `Syntax check failed: ${path.relative(projectRoot, filename)}`);
}
console.log(`Checked v${pkg.version}: manifest, runtime source boundary, ${scripts.length} JavaScript files`);
