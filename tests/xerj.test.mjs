import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { containedPath, exclusionReason, indexOutcome, mcpConfig, safeRelative,
  syncSnapshot, validateManifest } from '../scripts/xerj.mjs';

function manifest() {
  return { xerjVersion: '1.0.0-rc.100', port: 9217, project: { id: 'project', prefix: 'zrrlocal' },
    repositories: [{ id: 'reader', prefix: 'zrrreader', repository: 'zotero/reader', branch: 'master',
      commit: 'a'.repeat(40), sourcePaths: ['src', 'COPYING', 'README.md'] }] };
}

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(temporaryRoot, 'zrr-xerj-'));
  t.after(async () => {
    const relative = path.relative(temporaryRoot, root);
    assert.ok(relative.startsWith('zrr-xerj-') && !relative.includes(path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const sourceRoot = path.join(root, 'source');
  const snapshotRoot = path.join(root, 'snapshot');
  const provenanceFile = path.join(root, 'provenance', 'project.json');
  await fs.mkdir(sourceRoot);
  const put = async (name, content) => {
    const file = containedPath(sourceRoot, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  };
  const sync = tracked => syncSnapshot({ sourceRoot, snapshotRoot, provenanceFile,
    entry: manifest().project, commit: 'b'.repeat(40),
    tracked: tracked.map(item => typeof item === 'string' ? { path: item, mode: '100644', stage: '0' } : item) });
  return { root, sourceRoot, snapshotRoot, provenanceFile, put, sync };
}

test('source policy excludes private/generated paths, while preserving Zotero source and root licenses', () => {
  for (const name of ['.env', '.codex/config.toml', 'src/.secret.json', 'profile/prefs.js',
    'storage/paper.txt', 'cache/items.json', 'state-v2.json', 'src/admin.key', 'src/credentials.json',
    'src/env.json', 'local-test-results/result.json', 'screenshots/a.svg', 'dist/addon.js',
    'node_modules/a/index.js', 'papers/a.pdf', 'library.sqlite', 'src/a.min.js']) {
    assert.ok(exclusionReason(name), name);
  }
  for (const name of ['src/reader.ts', 'chrome/content/zotero/xpcom/reader.js', 'README.md', 'COPYING', 'LICENSE', 'AGENTS.md']) {
    assert.equal(exclusionReason(name), null, name);
  }
  assert.equal(exclusionReason('src/a.ts', ['src', 'README.md']), null);
  assert.equal(exclusionReason('chrome/content/zotero/xpcom/data/items.js',
    ['chrome/content/zotero/xpcom']), null);
  assert.equal(exclusionReason('data/private.json'), 'private-or-generated-directory');
  assert.equal(exclusionReason('src-other/a.ts', ['src']), 'outside-source-paths');
  assert.equal(exclusionReason('package.json', ['src']), 'outside-source-paths');
});

test('paths reject traversal, Windows aliases, absolute paths and alternate data streams', () => {
  for (const name of ['../outside.js', '/root.js', 'src/../../escape.js', 'src\\escape.js',
    'C:/secret.txt', 'src/a.ts:secret', 'src//a.ts', 'src/CON.txt', 'src/a. /b.ts', 'src/a\n.ts']) {
    assert.equal(safeRelative(name), false, name);
    assert.throws(() => containedPath(os.tmpdir(), name));
  }
  assert.equal(safeRelative('src/reader.ts'), true);
});

test('manifest pins local port, exact version, safe commit, origins, paths and distinct prefixes', () => {
  assert.equal(validateManifest(manifest()).repositories.length, 1);
  const changes = [
    value => { value.port = 9200; }, value => { value.xerjVersion = 'latest'; },
    value => { value.repositories[0].prefix = 'zrrlocal'; },
    value => { value.repositories[0].prefix = 'zrrlocal-sibling'; },
    value => { value.repositories[0].id = '../escape'; },
    value => { value.repositories[0].repository = 'https://example.com/repo'; },
    value => { value.repositories[0].commit = 'main'; },
    value => { value.repositories[0].branch = '--upload-pack=evil'; },
    value => { value.repositories[0].sourcePaths = ['../research']; },
  ];
  for (const change of changes) { const value = manifest(); change(value); assert.throws(() => validateManifest(value)); }
});

test('snapshot uses listed working-tree bytes and excludes binary, large, private and Git links', async t => {
  const f = await fixture(t);
  await f.put('src/reader.ts', 'export const page = 2;\n');
  await f.put('untracked.md', 'not in the Git list');
  await f.put('profile/private.json', 'private');
  await f.put('binary.txt', Buffer.from([0, 1, 2]));
  await f.put('invalid.txt', Buffer.from([0xff]));
  await f.put('huge.txt', Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await f.put('link.js', 'must not be read');
  const result = await f.sync(['src/reader.ts', 'profile/private.json', 'binary.txt', 'invalid.txt', 'huge.txt',
    { path: 'link.js', mode: '120000', stage: '0' }, { path: 'submodule', mode: '160000', stage: '0' }]);
  assert.equal(result.files, 1);
  assert.equal(await fs.readFile(path.join(f.snapshotRoot, 'src/reader.ts'), 'utf8'), 'export const page = 2;\n');
  assert.deepEqual(await fs.readdir(f.snapshotRoot), ['src']);
  const provenance = JSON.parse(await fs.readFile(f.provenanceFile, 'utf8'));
  assert.equal(provenance.files[0].path, 'src/reader.ts');
  assert.match(provenance.files[0].sha256, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(provenance).includes('export const'));
});

test('snapshot updates bytes and removes only its previously owned files', async t => {
  const f = await fixture(t);
  await f.put('src/a.js', 'first');
  await f.put('src/b.js', 'remove');
  await f.sync(['src/a.js', 'src/b.js']);
  await f.put('src/a.js', 'second');
  await f.sync(['src/a.js']);
  assert.equal(await fs.readFile(path.join(f.snapshotRoot, 'src/a.js'), 'utf8'), 'second');
  await assert.rejects(fs.stat(path.join(f.snapshotRoot, 'src/b.js')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(f.sourceRoot, 'src/b.js'), 'utf8'), 'remove');
  await fs.writeFile(path.join(f.snapshotRoot, 'unowned.txt'), 'preserve');
  await assert.rejects(f.sync(['src/a.js']), /unowned/);
  assert.equal(await fs.readFile(path.join(f.snapshotRoot, 'unowned.txt'), 'utf8'), 'preserve');
});

test('tampered ownership cannot remove a file outside the snapshot', async t => {
  const f = await fixture(t);
  await f.put('src/a.js', 'source');
  await f.sync(['src/a.js']);
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'preserve');
  const provenance = JSON.parse(await fs.readFile(f.provenanceFile, 'utf8'));
  provenance.ownedPaths.push('../outside.txt');
  await fs.writeFile(f.provenanceFile, JSON.stringify(provenance));
  await assert.rejects(f.sync([]), /ownership/);
  assert.equal(await fs.readFile(outside, 'utf8'), 'preserve');
});

test('filesystem directory links cannot pull outside text into snapshots', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'private.js'), 'outside data');
  await fs.symlink(outside, path.join(f.sourceRoot, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await f.sync(['linked/private.js'])).files, 0);
  assert.deepEqual(await fs.readdir(f.snapshotRoot), []);
});

test('snapshot and provenance must remain outside the source and snapshot respectively', async t => {
  const f = await fixture(t);
  const base = { sourceRoot: f.sourceRoot, snapshotRoot: f.snapshotRoot,
    provenanceFile: f.provenanceFile, entry: manifest().project, tracked: [], commit: 'a'.repeat(40) };
  await assert.rejects(syncSnapshot({ ...base, snapshotRoot: path.join(f.sourceRoot, 'snapshot') }), /separate/);
  await assert.rejects(syncSnapshot({ ...base, provenanceFile: path.join(f.snapshotRoot, 'provenance.json') }), /separate/);
});

test('exit 3 is successful only for completed-with-junk without refusals or stale files', () => {
  const done = 'xerj-done ok=true exit=3 reason=completed-with-junk datasets_refused=0 files_refused=0\n';
  assert.equal(indexOutcome(0, '', '').ok, true);
  assert.equal(indexOutcome(3, 'ok: searchable', done).ok, true);
  assert.equal(indexOutcome(3, '', done.replace('datasets_refused=0', 'datasets_refused=1')).ok, false);
  assert.equal(indexOutcome(3, '', done.replace('completed-with-junk', 'stale-resume-plan')).ok, false);
  assert.equal(indexOutcome(3, '', done + 'skipped').ok, true);
  assert.equal(indexOutcome(3, '', '').ok, false);
  assert.equal(indexOutcome(4, 'decision required', '').ok, false);
});

test('MCP config preserves unrelated settings, replaces only its block and contains no auth', () => {
  const existing = 'model = "example"\n[mcp_servers.other]\ncommand = "keep"\n'
    + '[mcp_servers.xerj_reading_room]\ncommand = "old"\n'
    + '[mcp_servers.xerj_reading_room.env]\nOLD = "discard"\n'
    + '[[unrelated.entries]]\nname = "preserve-array-table"\n'
    + '[projects."D:/somewhere"]\ntrust_level = "trusted"\n';
  const result = mcpConfig(existing, 'C:\\Program Files\\nodejs\\node.exe', 'D:\\repo\\scripts\\xerj.mjs');
  assert.ok(result.includes('[mcp_servers.other]\ncommand = "keep"'));
  assert.ok(result.includes('[projects."D:/somewhere"]\ntrust_level = "trusted"'));
  assert.ok(result.includes('[[unrelated.entries]]\nname = "preserve-array-table"'));
  assert.ok(!result.includes('OLD ='));
  assert.ok(!/API_KEY|XERJ_AUTH/.test(result));
  assert.equal((result.match(/\[mcp_servers\.xerj_reading_room\]/g) || []).length, 1);
  assert.equal(mcpConfig(result, 'C:\\Program Files\\nodejs\\node.exe', 'D:\\repo\\scripts\\xerj.mjs'), result);
  assert.throws(() => mcpConfig('[mcp_servers]\nxerj_reading_room = {}', 'node', 'helper'), /preserved/);
});
