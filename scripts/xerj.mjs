#!/usr/bin/env node
// Local-only XERJ workflow. Credentials, clones, logs and index state stay outside Git.
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const helper = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(helper), '..');
const runtimeLocation = path.join(process.platform === 'win32'
  ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  : path.join(os.homedir(), '.cache'), 'XERJ', 'zotero-reading-room');
let runtimeRoot = runtimeLocation;
const maxBytes = 2 * 1024 * 1024;
const suffixes = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.md', '.json',
  '.css', '.html', '.xhtml', '.ftl', '.svg', '.toml', '.yaml', '.yml', '.txt',
  '.xml', '.sh', '.py', '.rs', '.c', '.h', '.cpp', '.hpp']);
const privateDirectory = /^(?:node_modules|bower_components|vendor|third_party|thirdparty|dist|build|target|coverage|screenshots|local-test-results|runtime|profiles?|storage|cache|caches|data|logs?|tmp|temp|__pycache__)$/i;
const privateFile = /^(?:env(?:\.|$)|(?:admin[.-]?)?keys?(?:\.|$)|credentials?(?:\.|$)|secrets?(?:\.|$)|passwords?(?:\.|$)|tokens?(?:\.|$)|profiles?(?:\.|$)|prefs\.js$|user\.js$|state-v.*\.json$)/i;

export function safeRelative(value) {
  if (typeof value !== 'string' || !value || /[\\:\x00-\x1f\x7f*?"<>|]/u.test(value)) return false;
  return !path.posix.isAbsolute(value) && value.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[. ]$/.test(part)
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function containedPath(root, relative) {
  if (!safeRelative(relative)) throw new Error('Unsafe relative path');
  const result = path.resolve(root, ...relative.split('/'));
  const rel = path.relative(path.resolve(root), result);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('Path escapes its owned root');
  }
  return result;
}

export function exclusionReason(relative, sourcePaths) {
  if (!safeRelative(relative)) return 'unsafe-path';
  const parts = relative.split('/');
  const name = parts.at(-1);
  if (parts.some(part => part.startsWith('.'))) return 'hidden';
  // Zotero's public xpcom/data directory contains the Items/Search API source.
  // Only pinned reference roots with explicit sourcePaths may include it.
  if (parts.slice(0, -1).some(part => privateDirectory.test(part)
      && !(sourcePaths && part.toLowerCase() === 'data'))) return 'private-or-generated-directory';
  if (privateFile.test(name) || /\.(?:min\.(?:js|css)|map|lock)$/i.test(name)) return 'private-or-generated-file';
  if (sourcePaths && !sourcePaths.some(selected => relative === selected || relative.startsWith(`${selected}/`))) return 'outside-source-paths';
  if (!suffixes.has(path.posix.extname(name).toLowerCase())
      && !/^(?:LICENSE|COPYING|AGENTS)(?:[.-][a-z0-9-]+)?$/i.test(name)) return 'not-source-text';
  return null;
}

export function validateManifest(value) {
  if (!value || value.xerjVersion !== '1.0.0-rc.100' || value.port !== 9217
      || value.project?.id !== 'project' || !Array.isArray(value.repositories) || !value.repositories.length) {
    throw new Error('Unsupported XERJ manifest (expected rc.100, local port 9217 and project)');
  }
  const entries = [value.project, ...value.repositories];
  const ids = new Set();
  const prefixes = [];
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9]{1,39}$/.test(entry.id || '') || ids.has(entry.id)
        || ['all', 'references'].includes(entry.id)) throw new Error('Invalid or duplicate source ID');
    if (!/^[a-z][a-z0-9]{2,39}$/.test(entry.prefix || '') || prefixes.includes(entry.prefix)) {
      throw new Error('Prefixes must be distinct lowercase alphanumeric names');
    }
    ids.add(entry.id);
    prefixes.push(entry.prefix);
    if (entry === value.project) continue;
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(entry.repository || '')
        || !/^[a-f0-9]{40}$/.test(entry.commit || '')
        || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(entry.branch || '')
        || /\.\.|\/\/|\/\.|[/.]$/.test(entry.branch)
        || !Array.isArray(entry.sourcePaths) || !entry.sourcePaths.length
        || entry.sourcePaths.some(p => !safeRelative(p) || p.split('/').some(s => s.startsWith('.')))) {
      throw new Error(`Invalid pinned repository: ${entry.id}`);
    }
  }
  return value;
}

async function maybeRead(file) {
  try { return await fs.readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Check every existing component; neither source reads nor snapshot writes follow links.
async function regularPath(root, relative, { createParents = false } = {}) {
  const destination = containedPath(root, relative);
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Root must be a real directory');
  let cursor = root;
  const parts = relative.split('/');
  for (let i = 0; i < parts.length; i++) {
    cursor = path.join(cursor, parts[i]);
    let stat;
    try { stat = await fs.lstat(cursor); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (i === parts.length - 1) return { destination, stat: null };
      if (!createParents) return { destination, stat: null };
      await fs.mkdir(cursor, { mode: 0o700 });
      stat = await fs.lstat(cursor);
    }
    if (stat.isSymbolicLink()) throw new Error('Symbolic links are excluded');
    if (i < parts.length - 1 && !stat.isDirectory()) throw new Error('Path parent is not a directory');
    if (i === parts.length - 1) return { destination, stat };
  }
}

async function privateDir(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || normalize(await fs.realpath(directory)) !== normalize(directory)) throw new Error('Runtime directory must not contain links');
  if (process.platform !== 'win32') await fs.chmod(directory, 0o700);
}

async function writeJson(file, data) {
  await privateDir(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await fs.rename(temporary, file);
}

function environment(key) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('XERJ_')) delete env[name];
  env.XERJ_DISABLE_FEEDBACK = 'true';
  if (key) {
    env.XERJ_API_KEY = key;
    env.XERJ_AUTH = `ApiKey ${key}`;
  }
  return env;
}

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { input, outLog, errLog, captureLimit = 65536, requireComplete = false, ...spawnOptions } = options;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { truncated ||= stdout.length + chunk.length > captureLimit; stdout = (stdout + chunk).slice(-captureLimit); outLog?.write(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-65536); errLog?.write(chunk); });
    child.on('error', () => reject(new Error(`Could not execute ${path.basename(command)}`)));
    child.on('close', code => {
      if (truncated && requireComplete) reject(new Error('Command output exceeded the safe capture limit; refusing a partial file list'));
      else resolve({ code, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // Early child exit is reported by its exit code.
    child.stdin.end(input || '');
  });
}

async function git(root, args, input) {
  const hooks = path.join(runtimeRoot, 'empty-hooks');
  await privateDir(hooks);
  const result = await execute('git', ['-c', `core.hooksPath=${hooks}`, '-c', 'core.fsmonitor=false',
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-C', root, ...args], {
    env: { ...environment(), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    input, captureLimit: 32 * 1024 * 1024, requireComplete: true,
  });
  if (result.code !== 0) throw new Error(`Git ${args[0]} failed (exit ${result.code}); no build or install commands were run`);
  return result.stdout;
}

async function verifyReference(entry, root, requirePinned = true, requireClean = true) {
  const stat = await fs.lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Reference root must be a real directory');
  const expected = `https://github.com/${entry.repository}.git`;
  const origin = (await git(root, ['config', '--get', 'remote.origin.url'])).trim();
  const effective = (await git(root, ['remote', 'get-url', 'origin'])).trim();
  if (origin !== expected || effective !== expected) throw new Error(`Unexpected origin for ${entry.id}`);
  if (requireClean && (await git(root, ['status', '--porcelain', '--untracked-files=no'])).trim()) {
    throw new Error(`Tracked modifications in ${entry.id}; refusing to change or index the reference`);
  }
  if (requirePinned && (await git(root, ['rev-parse', 'HEAD'])).trim() !== entry.commit) {
    throw new Error(`${entry.id} is not at its manifest commit; run clone first`);
  }
}

async function cloneReferences(manifest) {
  const references = path.join(runtimeRoot, 'references');
  await privateDir(references);
  for (const entry of manifest.repositories) {
    const destination = containedPath(references, entry.id);
    const existing = await fs.lstat(destination).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) throw new Error(`Unsafe clone location: ${entry.id}`);
    if (!existing) {
      await git(references, ['clone', '--depth=1', '--filter=blob:none', '--no-checkout', '--sparse',
        '--branch', entry.branch, `https://github.com/${entry.repository}.git`, destination]);
    }
    await verifyReference(entry, destination, false, Boolean(existing));
    const hasCommit = await execute('git', ['-C', destination, 'cat-file', '-e', `${entry.commit}^{commit}`], { env: environment() });
    if (hasCommit.code !== 0) await git(destination, ['fetch', '--depth=1', 'origin', entry.commit]);
    await git(destination, ['sparse-checkout', 'set', '--no-cone', '--stdin'], entry.sourcePaths.map(p => `/${p}`).join('\n') + '\n');
    await git(destination, ['checkout', '--detach', entry.commit]);
    await verifyReference(entry, destination);
    console.log(`${entry.id}: pinned ${entry.commit.slice(0, 12)} (source only)`);
  }
}

export async function trackedSourceFiles(root) {
  // --stage supplies the Git mode so symlinks/submodules are rejected before reading.
  const output = await git(root, ['ls-files', '--cached', '--stage', '-z']);
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error('Invalid Git index record');
    return { mode: match[1], stage: match[3], path: match[4] };
  });
}

async function listSnapshotFiles(root, prefix = '') {
  const files = [];
  for (const entry of await fs.readdir(prefix ? containedPath(root, prefix) : root, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (!safeRelative(relative) || entry.isSymbolicLink()) throw new Error('Unexpected unsafe entry in snapshot');
    if (entry.isDirectory()) files.push(...await listSnapshotFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Unexpected non-file in snapshot');
  }
  return files;
}

// Exported for synthetic safety tests. No Git, server or user profile is required.
export async function syncSnapshot({ sourceRoot, snapshotRoot, provenanceFile, entry, tracked, commit }) {
  const within = (root, candidate) => {
    const rel = path.relative(path.resolve(root), path.resolve(candidate));
    return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`));
  };
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(snapshotRoot) || !path.isAbsolute(provenanceFile)
      || within(sourceRoot, snapshotRoot) || within(snapshotRoot, sourceRoot)
      || within(snapshotRoot, provenanceFile)) throw new Error('Snapshots and provenance require separate absolute roots');
  await privateDir(snapshotRoot);
  const previousText = await maybeRead(provenanceFile);
  const previous = previousText ? JSON.parse(previousText) : null;
  if (previous && (previous.version !== 1 || previous.id !== entry.id || previous.prefix !== entry.prefix
      || previous.sourceRoot !== sourceRoot || previous.snapshotRoot !== snapshotRoot
      || !Array.isArray(previous.ownedPaths) || previous.ownedPaths.some(p => !safeRelative(p)))) {
    throw new Error('Snapshot ownership metadata does not match this source');
  }
  const owned = new Set(previous?.ownedPaths || []);
  for (const relative of await listSnapshotFiles(snapshotRoot)) {
    if (!owned.has(relative)) throw new Error('Snapshot contains an unowned file; refusing to overwrite or index it');
  }
  const files = [];
  const excluded = {};
  const exclude = reason => { excluded[reason] = (excluded[reason] || 0) + 1; };
  for (const item of tracked) {
    const reason = exclusionReason(item.path, entry.sourcePaths);
    if (reason) { exclude(reason); continue; }
    if (!['100644', '100755'].includes(item.mode) || item.stage !== '0') { exclude('git-link-or-unmerged'); continue; }
    let inspected;
    try { inspected = await regularPath(sourceRoot, item.path); }
    catch { exclude('filesystem-link-or-unsafe'); continue; }
    if (!inspected.stat?.isFile()) { exclude('missing-or-not-file'); continue; }
    if (inspected.stat.size > maxBytes) { exclude('over-2MiB'); continue; }
    const handle = await fs.open(inspected.destination, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    let bytes;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) { exclude('over-2MiB-or-not-file'); continue; }
      bytes = await handle.readFile();
    } finally { await handle.close(); }
    if (bytes.length > maxBytes || bytes.includes(0)) { exclude('binary-or-over-2MiB'); continue; }
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { exclude('not-utf8'); continue; }
    files.push({ path: item.path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), content: bytes });
  }
  // Claim only checked paths before writing so an interrupted copy remains recoverable.
  const ownership = { version: 1, id: entry.id, prefix: entry.prefix, sourceRoot, snapshotRoot,
    commit, createdAt: new Date().toISOString(), ownedPaths: [...new Set([...owned, ...files.map(f => f.path)])],
    exclusions: excluded, files: files.map(({ content, ...metadata }) => metadata) };
  await writeJson(provenanceFile, ownership);
  for (const file of files) {
    const { destination, stat } = await regularPath(snapshotRoot, file.path, { createParents: true });
    if (stat && !stat.isFile()) throw new Error('Snapshot destination is not a regular file');
    const current = stat ? await fs.readFile(destination) : null;
    if (!current?.equals(file.content)) await fs.writeFile(destination, file.content, { mode: 0o600 });
  }
  const keep = new Set(files.map(file => file.path));
  for (const relative of owned) {
    if (keep.has(relative)) continue;
    const { destination, stat } = await regularPath(snapshotRoot, relative);
    if (stat && !stat.isFile()) throw new Error('Owned removal target is not a regular file');
    if (stat) await fs.unlink(destination); // No recursive deletion, ever.
  }
  ownership.ownedPaths = [...keep];
  await writeJson(provenanceFile, ownership);
  return { files: files.length, exclusions: excluded, snapshotRoot };
}

async function executable() {
  const binary = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'Programs', 'xerj', 'xerj.exe') : 'xerj';
  const result = await execute(binary, ['--version', '--disable-feedback'], { env: environment() });
  if (result.code !== 0 || !/\bv?1\.0\.0-rc\.100\b/.test(result.stdout + result.stderr)) {
    throw new Error('Install the pinned XERJ 1.0.0-rc.100 binary before using this helper');
  }
  return binary;
}

async function readKey() {
  const key = (await maybeRead(path.join(runtimeRoot, 'data', 'admin.key')))?.trim();
  if (key && !/[\r\n\x00-\x1f]/.test(key)) return key;
  return null;
}

async function listening(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(1200);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

async function ownedHealth(url, key) {
  if (!key) return false;
  try {
    const unauthenticated = await fetch(`${url}/_cluster/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
    if (![401, 403].includes(unauthenticated.status)) return false;
    const response = await fetch(`${url}/_cluster/health`, {
      headers: { Authorization: `ApiKey ${key}` }, signal: AbortSignal.timeout(2500), redirect: 'error',
    });
    if (!response.ok) return false;
    const health = await response.json();
    return health.cluster_name === 'xerj' && !health.timed_out && ['green', 'yellow'].includes(health.status);
  } catch { return false; }
}

async function ensureNode(manifest, binary, start = true) {
  const url = `http://127.0.0.1:${manifest.port}`;
  let key = await readKey();
  if (await ownedHealth(url, key)) return { url, key, reused: true };
  if (await listening(manifest.port)) throw new Error('Local port 9217 is occupied by an unverified node; refusing to reuse or stop it');
  if (!start) throw new Error('Owned local XERJ node is not running; use start');
  for (const port of [manifest.port + 1, manifest.port + 2]) {
    if (await listening(port)) throw new Error(`Required local port ${port} is occupied; refusing to start`);
  }
  await privateDir(runtimeRoot);
  await privateDir(path.join(runtimeRoot, 'data'));
  const logs = path.join(runtimeRoot, 'logs');
  await privateDir(logs);
  const stamp = `${Date.now()}-${randomUUID()}`;
  const stdout = await fs.open(path.join(logs, `server-${stamp}.stdout.log`), 'wx', 0o600);
  const stderr = await fs.open(path.join(logs, `server-${stamp}.stderr.log`), 'wx', 0o600);
  let child;
  let failed = false;
  try {
    child = spawn(binary, ['--bind', '127.0.0.1', '--port', String(manifest.port), '--data-dir',
      path.join(runtimeRoot, 'data'), '--embed-mode', 'lexical', '--no-auto-port', '--disable-feedback'], {
      cwd: runtimeRoot, env: environment(), detached: true, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd],
    });
    child.on('error', () => { failed = true; });
    child.on('exit', () => { failed = true; });
    child.unref();
  } finally { await stdout.close(); await stderr.close(); }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline && !failed) {
    key = await readKey();
    if (await ownedHealth(url, key)) {
      await writeJson(path.join(runtimeRoot, 'server.json'), { pid: child.pid, url, dataDir: path.join(runtimeRoot, 'data') });
      return { url, key, reused: false };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error('Local XERJ did not become healthy within 45s; inspect private runtime logs (startup logs can contain setup tokens)');
}

function sources(manifest, selector, referencesAllowed = true) {
  const entries = [manifest.project, ...manifest.repositories];
  if (selector === 'all') return entries;
  if (selector === 'references' && referencesAllowed) return manifest.repositories;
  const entry = entries.find(candidate => candidate.id === selector);
  if (!entry) throw new Error(`Unknown source: ${selector}`);
  return [entry];
}

export function indexOutcome(code, stdout, stderr) {
  const terminal = [...stderr.matchAll(/^xerj-done\s+(.+)$/gm)].at(-1)?.[1] || '';
  if (code === 0) return { ok: true, summary: terminal || 'complete (exit 0)' };
  const refused = /(?:datasets_refused|files_refused|skipped_appeared)=(?!0(?:\s|$))\S+/.test(terminal);
  const ok = code === 3 && /(?:^|\s)ok=true(?:\s|$)/.test(terminal)
    && /(?:^|\s)reason=completed-with-junk(?:\s|$)/.test(terminal)
    && !refused && !/stale-resume-plan|\b(?:dataset|mapping)\b[^\n]*\b(?:refused|rejected)\b/i.test(stdout + stderr);
  return { ok, summary: terminal || `incomplete (exit ${code})` };
}

async function indexSources(manifest, entries, binary, node, dryRun) {
  for (const entry of entries) {
    const root = entry.id === 'project' ? projectRoot : path.join(runtimeRoot, 'references', entry.id);
    if (entry.id !== 'project') await verifyReference(entry, root);
    const commit = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const snapshotRoot = path.join(runtimeRoot, 'snapshots', entry.id);
    const snapshot = await syncSnapshot({ sourceRoot: root, snapshotRoot,
      provenanceFile: path.join(runtimeRoot, 'provenance', `${entry.id}.json`), entry,
      tracked: await trackedSourceFiles(root), commit });
    if (!snapshot.files) throw new Error(`${entry.id}: no eligible tracked text files`);
    const state = path.join(runtimeRoot, 'state', entry.id);
    await privateDir(state);
    const logs = path.join(runtimeRoot, 'logs');
    await privateDir(logs);
    const label = `${entry.id}-${Date.now()}-${randomUUID()}`;
    const outLog = (await fs.open(path.join(logs, `${label}.stdout.log`), 'wx', 0o600)).createWriteStream();
    const errLog = (await fs.open(path.join(logs, `${label}.stderr.log`), 'wx', 0o600)).createWriteStream();
    let result;
    try {
      result = await execute(binary, ['autoindex', snapshotRoot, '--url', node.url, '--prefix', entry.prefix,
        '--state-dir', state, '--no-graph', '--no-semantic', '--code-analyzer', 'code', '--workers', '2',
        '--progress', 'plain', '--disable-feedback', ...(dryRun ? ['--dry-run'] : [])],
      { env: environment(node.key), outLog, errLog });
    } finally { outLog.end(); errLog.end(); }
    const outcome = indexOutcome(result.code, result.stdout, result.stderr);
    console.log(`${entry.id}: ${snapshot.files} snapshot files; excluded=${Object.values(snapshot.exclusions).reduce((a, b) => a + b, 0)}; ${dryRun ? 'dry-run; ' : ''}${outcome.summary.slice(0, 1500)}`);
    if (!outcome.ok) throw new Error(`${entry.id}: indexing is incomplete (exit ${result.code}); inspect private log ${label}; no reset or approval flags were applied`);
  }
}

export function mcpConfig(existing, nodePath, scriptPath) {
  if (existing.includes('"""') || existing.includes("'''")) throw new Error('Multiline TOML requires manual MCP configuration; existing config preserved');
  const lines = existing.split(/\r?\n/);
  const kept = [];
  let ours = false;
  let parent = false;
  for (const line of lines) {
    const table = /^\s*(\[\[?)([^\]]+)(\]\]?)\s*(?:#.*)?$/.exec(line);
    if (table) {
      if (table[1].length !== table[3].length) throw new Error('Unsupported TOML table; existing config preserved');
      const name = table[2].replace(/["']/g, '').replace(/\s/g, '');
      ours = name === 'mcp_servers.xerj_reading_room' || name.startsWith('mcp_servers.xerj_reading_room.');
      parent = name === 'mcp_servers';
    }
    if (parent && /^\s*["']?xerj_reading_room["']?\s*=/.test(line)) throw new Error('Inline MCP definition requires manual configuration; existing config preserved');
    if (!ours) kept.push(line);
  }
  const quote = value => JSON.stringify(value);
  return `${kept.join('\n').trimEnd()}\n\n[mcp_servers.xerj_reading_room]\ncommand = ${quote(nodePath)}\nargs = [${quote(scriptPath)}, "mcp"]\nenabled_tools = ["xerj_search", "xerj_def", "xerj_batch_search", "xerj_map"]\nstartup_timeout_sec = 60\nenv = { XERJ_DISABLE_FEEDBACK = "true" }\n`;
}

async function configureMcp() {
  if ((await git(projectRoot, ['ls-files', '--', '.codex/config.toml'])).trim()) throw new Error('Local MCP config must not be tracked');
  const ignored = await execute('git', ['-C', projectRoot, 'check-ignore', '-q', '--', '.codex/config.toml'], { env: environment() });
  if (ignored.code !== 0) throw new Error('Ignore .codex/config.toml in this project before configuring MCP');
  const { destination, stat } = await regularPath(projectRoot, '.codex/config.toml', { createParents: true });
  if (stat && !stat.isFile()) throw new Error('MCP config must be a regular local file');
  const updated = mcpConfig((await maybeRead(destination)) || '', process.execPath, helper);
  await fs.writeFile(destination, updated, { mode: 0o600 });
  console.log('Configured local ignored .codex/config.toml (four retrieval tools; no credentials stored)');
}

async function proxyMcp(binary, node) {
  const child = spawn(binary, ['mcp', '--url', node.url, '--disable-feedback'], {
    cwd: runtimeRoot, env: environment(node.key), windowsHide: true, stdio: 'inherit',
  });
  await new Promise((resolve, reject) => {
    child.on('error', () => reject(new Error('Could not start local XERJ MCP proxy')));
    child.on('close', code => { process.exitCode = code ?? 1; resolve(); });
  });
}

export async function main(args = process.argv.slice(2)) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required');
  const [action, ...rest] = args;
  if (!action || action === '--help') {
    console.log('xref: start | status | clone | index [project|all|ID] [--dry-run] | search [project|references|all|ID] "words" | def [project|ID] "symbol" | configure-mcp | mcp');
    return;
  }
  if (!['start', 'status', 'clone', 'index', 'search', 'def', 'configure-mcp', 'mcp'].includes(action)) throw new Error('Unknown xref command; use --help');
  const manifest = validateManifest(JSON.parse(await fs.readFile(path.join(projectRoot, 'config', 'reference-repositories.json'), 'utf8')));
  await fs.mkdir(runtimeLocation, { recursive: true, mode: 0o700 });
  const runtimeStat = await fs.lstat(runtimeLocation);
  if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) throw new Error('Runtime root must be a real directory');
  // Windows packaged apps can redirect LOCALAPPDATA without a filesystem link.
  // Canonicalize this owned root once; child-path link checks remain strict.
  runtimeRoot = await fs.realpath(runtimeLocation);
  if (action === 'configure-mcp') { if (rest.length) throw new Error('Unexpected arguments'); return configureMcp(); }
  if (action === 'clone') { if (rest.length) throw new Error('Unexpected arguments'); return cloneReferences(manifest); }
  const binary = await executable();
  if (['start', 'status', 'mcp'].includes(action)) {
    if (rest.length) throw new Error('Unexpected arguments');
    const node = await ensureNode(manifest, binary, action !== 'status');
    if (action === 'mcp') return proxyMcp(binary, node);
    console.log(`Owned authenticated XERJ healthy at ${node.url}; ${node.reused ? 'reused' : 'started'}; lexical, local only`);
    return;
  }
  if (action === 'index') {
    const dryRun = rest.includes('--dry-run');
    const selectors = rest.filter(arg => arg !== '--dry-run');
    if (selectors.length > 1 || rest.some(arg => arg.startsWith('-') && arg !== '--dry-run')) throw new Error('Usage: index [project|all|ID] [--dry-run]');
    const entries = sources(manifest, selectors[0] || 'project', false);
    const node = await ensureNode(manifest, binary);
    return indexSources(manifest, entries, binary, node, dryRun);
  }
  const knownSelectors = ['project', 'references', 'all', ...manifest.repositories.map(entry => entry.id)];
  const selector = knownSelectors.includes(rest[0]) ? rest.shift() : 'project';
  if (action === 'def' && ['all', 'references'].includes(selector)) throw new Error('def requires project or one reference ID');
  const query = rest.join(' ').trim();
  if (!query || query.startsWith('-') || query.length > 4000 || /[\x00-\x1f]/.test(query)) throw new Error('Supply a plain query or symbol (1–4000 characters)');
  const entries = sources(manifest, selector);
  const node = await ensureNode(manifest, binary);
  for (const entry of entries) {
    const result = await execute(binary, [action, '--url', node.url, '--prefix', entry.prefix,
      ...(action === 'search' ? ['-k', '3', '--full', '700'] : []), query, '--disable-feedback'], { env: environment(node.key) });
    if (result.code !== 0) throw new Error(`${entry.id}: ${action} failed (exit ${result.code})`);
    console.log(`[${entry.id}]\n${result.stdout.slice(0, 16000).trim()}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`xref: ${error.message}`); process.exitCode = 1; });
}
