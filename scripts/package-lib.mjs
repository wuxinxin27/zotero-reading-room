import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export const addonID = "zotero-reading-room@wuxinxin27.github.io";
export const requiredFiles = Object.freeze([
  "manifest.json", "bootstrap.js", "icon.svg",
  "content/core.js", "content/service.js", "content/reader.js", "content/room.js",
  "content/sidebar.js",
  "content/room.xhtml", "content/room.css",
  "locale/en-US/reading-room.ftl", "locale/zh-CN/reading-room.ftl",
]);
// Explicit runtime source types keep profile data, keys, logs and generated output out.
const sourceExtensions = new Set([".js", ".json", ".xhtml", ".css", ".svg", ".ftl"]);
const forbiddenParts = /^(?:\..*|node_modules|dist|coverage|profiles?|storage|cache|logs?|reading-room)$/i;
const forbiddenNames = /(?:^|[._-])(?:secrets?|credentials?|tokens?|passwords?|state-v\d+)(?:[._-]|$)/i;

export async function collectSources(addonDirectory) {
  const files = [];
  const rootStat = await fs.lstat(addonDirectory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("addon/ must be a real directory");
  async function visit(directory, prefix = "") {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks cannot be packaged: ${relative}`);
      if (forbiddenParts.test(entry.name) || forbiddenNames.test(entry.name) || /[\\\x00-\x1f\x7f]/.test(entry.name)) {
        throw new Error(`Non-source file or directory in addon/: ${relative}`);
      }
      if (entry.isDirectory()) await visit(path.join(directory, entry.name), relative + "/");
      else if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
        files.push({ name: relative, data: await fs.readFile(path.join(directory, entry.name)) });
      }
      else throw new Error(`Unsupported runtime source file: ${relative}`);
    }
  }
  await visit(addonDirectory);
  return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export async function validateProject(root = projectRoot, { tag } = {}) {
  const pkg = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  if (pkg.name !== "zotero-reading-room" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Invalid package name/version");
  for (const kind of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (Object.keys(pkg[kind] || {}).length) throw new Error(`This project requires zero npm dependencies (${kind})`);
  }
  const files = await collectSources(path.join(root, "addon"));
  const byName = new Map(files.map(file => [file.name, file.data]));
  for (const name of requiredFiles) {
    if (!byName.has(name) || !byName.get(name).length) throw new Error(`Required addon file is missing or empty: ${name}`);
  }
  const manifest = JSON.parse(byName.get("manifest.json").toString("utf8"));
  const target = manifest.applications?.zotero;
  if (manifest.manifest_version !== 2 || manifest.version !== pkg.version || target?.id !== addonID
      || target.strict_min_version !== "10.0" || target.strict_max_version !== "10.*") {
    throw new Error("Manifest must match package version, addon ID, and Zotero 10.0–10.* target");
  }
  if (tag !== undefined && tag !== `v${pkg.version}`) throw new Error(`Release tag must be v${pkg.version}`);
  if (target.update_url !== "https://github.com/wuxinxin27/zotero-reading-room/releases/latest/download/updates.json") {
    throw new Error("Zotero requires the declared HTTPS Release update_url");
  }
  return { pkg, manifest, files };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

// Standard ZIP32, stored entries, UTF-8 names, fixed 1980-01-01 UTC timestamp.
// No filesystem timestamps, platform permissions, compression versions or extra fields vary.
export function makeZip(files) {
  if (files.length > 65535) throw new Error("ZIP32 entry count exceeded");
  const localRecords = [];
  const centralRecords = [];
  let offset = 0;
  for (const { name, data } of files) {
    const filename = Buffer.from(name, "utf8");
    if (filename.length > 65535 || data.length > 0xffffffff || offset > 0xffffffff) throw new Error("ZIP32 size exceeded");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(filename.length, 26);
    localRecords.push(local, filename, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0x0021, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(central, filename);
    offset += local.length + filename.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralRecords);
  if (offset + centralDirectory.length > 0xffffffff) throw new Error("ZIP32 total size exceeded");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localRecords, centralDirectory, end]);
}

export async function buildPackage({ root = projectRoot, outputDirectory = path.join(root, "dist") } = {}) {
  const { pkg, manifest, files } = await validateProject(root);
  const filename = `${pkg.name}-${pkg.version}.xpi`;
  const archive = makeZip(files);
  const digest = createHash("sha256").update(archive).digest("hex");
  await fs.mkdir(outputDirectory, { recursive: true });
  await fs.writeFile(path.join(outputDirectory, filename), archive);
  await fs.writeFile(path.join(outputDirectory, "SHA256SUMS"), `${digest}  ${filename}\n`, "utf8");
  const target = manifest.applications.zotero;
  const updates = { addons: { [addonID]: { updates: [{
    version: pkg.version,
    update_link: `https://github.com/wuxinxin27/zotero-reading-room/releases/download/v${pkg.version}/${filename}`,
    update_hash: `sha256:${digest}`,
    applications: { zotero: { strict_min_version: target.strict_min_version, strict_max_version: target.strict_max_version } },
  }] } } };
  await fs.writeFile(path.join(outputDirectory, "updates.json"), JSON.stringify(updates, null, 2) + "\n", "utf8");
  return { filename, outputDirectory, sha256: digest, entries: files.length };
}
