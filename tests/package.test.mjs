import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { addonID, buildPackage, requiredFiles, validateProject } from "../scripts/package-lib.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reading-room-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pkg = { name: "zotero-reading-room", version: "0.1.0" };
  const manifest = { manifest_version: 2, version: "0.1.0", applications: { zotero: {
    id: addonID, strict_min_version: "10.0", strict_max_version: "10.*",
    update_url: "https://github.com/wuxinxin27/zotero-reading-room/releases/latest/download/updates.json",
  } } };
  const sources = new Map(requiredFiles.map(name => [name, name === "icon.svg" ? "123456789" : "synthetic source\n"]));
  sources.set("manifest.json", JSON.stringify(manifest));
  for (const [name, content] of sources) {
    await fs.mkdir(path.dirname(path.join(root, "addon", name)), { recursive: true });
    await fs.writeFile(path.join(root, "addon", name), content);
  }
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify(pkg));
  // Must never be included by a recursive project-root archive.
  await fs.writeFile(path.join(root, "private-library.json"), "PRIVATE_SENTINEL");
  return { root, pkg, manifest, sources };
}

// Read central-directory records independently of the packager, then follow local offsets.
function readZip(bytes) {
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  assert.equal(bytes.readUInt16LE(end + 20), 0);
  assert.equal(bytes.readUInt16LE(end + 4), 0);
  const count = bytes.readUInt16LE(end + 10);
  assert.equal(bytes.readUInt16LE(end + 8), count);
  let cursor = bytes.readUInt32LE(end + 16);
  assert.equal(cursor + bytes.readUInt32LE(end + 12), end);
  const result = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const size = bytes.readUInt32LE(cursor + 24);
    assert.equal(bytes.readUInt16LE(cursor + 10), 0, "portable stored ZIP entry");
    assert.equal(bytes.readUInt32LE(cursor + 20), size);
    assert.equal(bytes.readUInt16LE(cursor + 8), 0x0800);
    assert.equal(bytes.readUInt32LE(cursor + 38) >>> 16, 0o100644);
    const local = bytes.readUInt32LE(cursor + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    assert.equal(bytes.readUInt16LE(local + 26), nameLength);
    assert.equal(bytes.readUInt16LE(local + 28), 0);
    assert.equal(bytes.subarray(local + 30, local + 30 + nameLength).toString("utf8"), name);
    assert.equal(bytes.readUInt32LE(local + 14), bytes.readUInt32LE(cursor + 16));
    assert.equal(bytes.readUInt32LE(local + 22), size);
    assert(!result.has(name), "no duplicate archive paths");
    result.set(name, { content: bytes.subarray(local + 30 + nameLength, local + 30 + nameLength + size), crc: bytes.readUInt32LE(cursor + 16) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(cursor, end);
  return result;
}

test("XPI is a reproducible standard ZIP with only addon sources and verifiable SHA-256", async t => {
  const { root, sources } = await fixture(t);
  const result = await buildPackage({ root });
  assert.equal(result.filename, "zotero-reading-room-0.1.0.xpi");
  const archivePath = path.join(result.outputDirectory, result.filename);
  const first = await fs.readFile(archivePath);
  const entries = readZip(first);
  assert.deepEqual([...entries.keys()], [...sources.keys()].sort());
  for (const [name, content] of sources) assert.equal(entries.get(name).content.toString("utf8"), content);
  assert.equal(entries.get("icon.svg").crc, 0xcbf43926, "CRC-32 standard test vector");
  assert.equal(first.includes(Buffer.from("PRIVATE_SENTINEL")), false);
  const digest = createHash("sha256").update(first).digest("hex");
  assert.equal(await fs.readFile(path.join(result.outputDirectory, "SHA256SUMS"), "utf8"), `${digest}  ${result.filename}\n`);
  for (const name of sources.keys()) await fs.utimes(path.join(root, "addon", name), 1234567890, 1234567890);
  await buildPackage({ root });
  assert.deepEqual(await fs.readFile(archivePath), first, "source mtimes do not affect package bytes");
});

test("missing runtime resources stop the build", async t => {
  const { root } = await fixture(t);
  await fs.unlink(path.join(root, "addon", "content", "room.xhtml"));
  await assert.rejects(buildPackage({ root }), /Required addon file.*room.xhtml/);
  await assert.rejects(fs.access(path.join(root, "dist")), { code: "ENOENT" });
});

test("version, identity, supported host range and release tags are enforced", async t => {
  const { root, manifest } = await fixture(t);
  await validateProject(root, { tag: "v0.1.0" });
  await assert.rejects(validateProject(root, { tag: "v0.2.0" }), /Release tag/);
  for (const mutate of [
    value => { value.version = "0.2.0"; },
    value => { value.applications.zotero.id = "different@example.invalid"; },
    value => { value.applications.zotero.strict_min_version = "7.0"; },
    value => { value.applications.zotero.strict_max_version = "*"; },
  ]) {
    const value = structuredClone(manifest);
    mutate(value);
    await fs.writeFile(path.join(root, "addon", "manifest.json"), JSON.stringify(value));
    await assert.rejects(validateProject(root), /Manifest must match/);
  }
});

test("private files placed inside addon fail closed", async t => {
  const { root } = await fixture(t);
  for (const name of [".env", "state-v1.json", "credentials.json", "library.sqlite", "article.pdf"]) {
    const filename = path.join(root, "addon", name);
    await fs.writeFile(filename, "synthetic private data");
    await assert.rejects(buildPackage({ root }), /Non-source|Unsupported runtime source/);
    await fs.unlink(filename);
  }
});

test("npm dependencies cannot silently enter the dependency-free toolchain", async t => {
  const { root, pkg } = await fixture(t);
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ ...pkg, dependencies: { accidental: "1.0.0" } }));
  await assert.rejects(validateProject(root), /zero npm dependencies/);
});

test("directory links cannot import files from outside addon", async t => {
  const { root } = await fixture(t);
  const outside = path.join(root, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "private.json"), "synthetic private data");
  try {
    await fs.symlink(outside, path.join(root, "addon", "linked"), process.platform === "win32" ? "junction" : "dir");
  }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip("OS does not permit creating a test directory link");
    throw error;
  }
  await assert.rejects(buildPackage({ root }), /Symlinks cannot be packaged/);
});

test("Zotero 10 update URL is required and release metadata matches the exact XPI", async t => {
  const { root, manifest } = await fixture(t);
  const built = await buildPackage({ root });
  const metadata = JSON.parse(await fs.readFile(path.join(built.outputDirectory, "updates.json"), "utf8"));
  const update = metadata.addons[addonID].updates[0];
  assert.equal(update.version, "0.1.0");
  assert.equal(update.update_hash, `sha256:${built.sha256}`);
  assert.equal(update.update_link, `https://github.com/wuxinxin27/zotero-reading-room/releases/download/v0.1.0/${built.filename}`);
  assert.equal(update.applications.zotero.strict_min_version, "10.0");
  delete manifest.applications.zotero.update_url;
  await fs.writeFile(path.join(root, "addon", "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(validateProject(root), /update_url/);
});
