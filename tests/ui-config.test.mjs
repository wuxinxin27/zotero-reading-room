import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(
  new URL("../addon/content/room.js", import.meta.url),
  "utf8",
);

class ClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
}

class Element {
  constructor(doc, name) {
    this.ownerDocument = doc;
    this.localName = name;
    this.namespaceURI = "http://www.w3.org/1999/xhtml";
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.listeners = new Map();
    this.classList = new ClassList();
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.focused = false;
    this.src = "";
  }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "class") {
      this.classList = new ClassList();
      for (const token of text.split(/\s+/).filter(Boolean)) {
        this.classList.add(token);
      }
    }
    if (name === "value") this.value = text;
    if (name === "checked") this.checked = true;
    if (name === "disabled") this.disabled = true;
    if (name === "src") this.src = text;
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "checked") this.checked = false;
    if (name === "disabled") this.disabled = false;
  }
  append(...nodes) {
    for (let node of nodes) {
      if (typeof node === "string") {
        const text = new Element(this.ownerDocument, "#text");
        text.textContent = node;
        node = text;
      }
      node.parentNode = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
  removeChild(node) {
    assert.equal(node.parentNode, this);
    node.remove();
    return node;
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    this.listeners.set(type,
      listeners.filter(entry => entry !== listener));
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of [...(this.listeners.get(event.type) || [])]) {
      listener(event);
    }
    return true;
  }
  focus() {
    this.focused = true;
    this.dispatchEvent({ type: "focus", target: this });
  }
  click() { this.dispatchEvent({ type: "click", target: this }); }
  setAttributeNS(_namespace, name, value) {
    this.setAttribute(name, value);
  }
  querySelectorAll() { return []; }
  get lastElementChild() { return this.children.at(-1) || null; }
}

class Document {
  constructor() {
    this.documentElement = new Element(this, "html");
    this.head = new Element(this, "head");
    this.body = new Element(this, "body");
    this.documentElement.append(this.head, this.body);
    this.title = "";
  }
  createElementNS(_namespace, name) { return new Element(this, name); }
  getElementsByTagNameNS(_namespace, name) {
    if (name === "head") return [this.head];
    if (name === "body") return [this.body];
    return [];
  }
}

function descendants(root, predicate) {
  const found = [];
  for (const child of root.children) {
    if (predicate(child)) found.push(child);
    found.push(...descendants(child, predicate));
  }
  return found;
}
function button(root, text) {
  return descendants(root, node => node.localName === "button"
    && node.textContent === text)[0];
}
function fieldByText(dialog, text) {
  const field = descendants(dialog, node => node.localName === "label"
    && descendants(node, child => child.localName === "span"
      && child.textContent === text).length)[0];
  assert.ok(field, `missing field ${text}`);
  return field;
}
function textOf(node) {
  return String(node.textContent || "")
    + node.children.map(textOf).join("");
}
function paper(id, title, focused = false) {
  return {
    id,
    key: `KEY${id}`,
    libraryID: 1,
    title,
    creators: ["Synthetic Author"],
    year: "2026",
    venue: "Synthetic Venue",
    itemType: "journalArticle",
    status: "unread",
    focused,
    hasAnalysis: id === 2,
  };
}

async function fixture({ cached = false, failAnalysis = null } = {}) {
  const windowListeners = new Map();
  const document = new Document();
  const timers = [];
  const clearedTimers = new Set();
  const controllers = [];
  class FakeAbortController {
    constructor() {
      const listeners = new Set();
      this.signal = {
        aborted: false,
        addEventListener(_type, listener) { listeners.add(listener); },
        removeEventListener(_type, listener) { listeners.delete(listener); },
        fire() { for (const listener of listeners) listener(); },
      };
      controllers.push(this);
    }
    abort() {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.fire();
    }
  }
  const parents = new Map();
  for (let id = 1; id <= 4; id++) {
    parents.set(id, {
      id,
      key: `KEY${id}`,
      libraryID: 1,
      deleted: false,
      isRegularItem() { return true; },
    });
  }
  const win = {
    document,
    AbortController: FakeAbortController,
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout(id) { clearedTimers.add(id); },
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) || [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
  };
  const papers = [
    paper(1, "Synthetic Alpha"),
    paper(2, "Synthetic Beta", true),
    paper(3, "Synthetic Gamma"),
  ];
  const calls = [];
  const savedConfigs = [];
  const cachedAnalysis = {
    mode: "model",
    model: "cached-model",
    provider: "openai",
    createdAt: "2026-10-31T00:00:00.000Z",
    overview: "Cached overview.",
    readingGuide: "Read methods first.",
    overviewEvidence: [],
    readingGuideEvidence: [],
    dimensions: [],
    figureTableReferences: [],
    coverage: { analyzedCharacters: 10, extractedCharacters: 20 },
    limitations: [],
  };
  const service = {
    calls,
    savedConfigs,
    normalizeItem(item) { return item || null; },
    getState() {
      return {
        status: "unread",
        notes: "",
        checklist: {},
        analysis: cached ? cachedAnalysis : null,
      };
    },
    async listLibraries() {
      return [{ id: 1, name: "Synthetic Library",
        type: "user", editable: true }];
    },
    async listPapers(options) {
      calls.push({ type: "listPapers", options });
      let items = papers.map(entry => ({ ...entry }));
      if (options.focusOnly) items = items.filter(entry => entry.focused);
      if (options.query) {
        items = items.filter(entry =>
          entry.title.toLowerCase().includes(options.query.toLowerCase()));
      }
      return {
        items: items.slice(options.offset, options.offset + options.limit),
        total: items.length,
        offset: options.offset,
        limit: options.limit,
      };
    },
    async setFocused(item, value) {
      calls.push({ type: "setFocused", item, value });
      const target = papers.find(entry => entry.id === item.id);
      if (target) target.focused = value;
    },
    async describe(item) {
      calls.push({ type: "describe", item });
      const metadata = papers.find(entry => entry.id === item.id);
      return {
        item: { ...metadata, doi: "10.0000/synthetic" },
        attachments: [{ id: 101, key: "ATTACH01",
          title: "Synthetic PDF", contentType: "application/pdf",
          available: true }],
        counts: { notes: 0, annotations: 0 },
        state: {
          status: metadata && metadata.status || "unread",
          notes: "Unsaved synthetic note",
          checklist: {},
          analysisJob: { status: "idle" },
          analysis: item.id === 2 && cached ? cachedAnalysis : null,
        },
      };
    },
    async setState(item, patch) {
      calls.push({ type: "setState", item, patch });
      return {
        status: patch.status || "unread",
        notes: patch.notes || "",
        checklist: patch.checklist || {},
        analysis: null,
      };
    },
    async getReaderAttachment() {
      return {
        id: 101,
        key: "ATTACH01",
        libraryID: 1,
        title: "Synthetic PDF",
        path: "/synthetic/paper.pdf",
        available: true,
        contentType: "application/pdf",
      };
    },
    async analyze(item, options) {
      calls.push({ type: "analyze", item, options });
      options.onProgress({ status: "preparing", detail: "checking cache" });
      if (failAnalysis) throw failAnalysis;
      return cachedAnalysis;
    },
    cancelAnalysis() { return false; },
    async getAIConfig() {
      return {
        provider: "openai",
        endpoint: "http://127.0.0.1:11434/v1/chat/completions",
        model: "saved-model",
        allowRemoteDiscovery: false,
        allowRemoteAnalysis: false,
        consentOrigin: null,
        consentProvider: null,
        rememberKey: true,
        hasApiKey: true,
        configured: true,
        keyStorageAvailable: true,
        updatedAt: "2026-10-31T00:00:00.000Z",
      };
    },
    async saveAIConfig(config, options) {
      savedConfigs.push({ config, options });
      calls.push({ type: "saveAIConfig", config, options });
      return { ...config, hasApiKey: !!options.apiKey };
    },
    async listConfiguredModels(options) {
      calls.push({ type: "listConfiguredModels", options });
      return {
        endpoint: "http://127.0.0.1:11434/v1/models",
        models: [
          { id: "synthetic-a", name: "Synthetic A" },
          { id: "synthetic-b", name: "Synthetic B" },
        ],
      };
    },
    async listModels(options) {
      calls.push({ type: "listModels", options });
      return {
        endpoint: `${options.endpoint.replace(/\/$/, "")}/models`,
        models: [
          { id: "synthetic-a", name: "Synthetic A" },
          { id: "synthetic-b", name: "Synthetic B" },
        ],
      };
    },
    async flush() {},
  };
  const context = vm.createContext({
    window: win,
    document,
    URL,
    AbortController: FakeAbortController,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    Zotero: {
      Libraries: {
        get() { return { libraryType: "user" }; },
        userLibraryID: 1,
      },
      getMainWindows() { return []; },
      getMainWindow() { return win; },
      Items: { get(id) { return parents.get(Number(id)) || null; } },
      Reader: { async open() {} },
      debug() {},
    },
    Services: {
      wm: { getMostRecentWindow() { return win; } },
    },
    ReadingRoomCore: {
      API_PROVIDERS: [
        { id: "openai", label: "OpenAI 兼容",
          defaultEndpoint: "http://127.0.0.1:11434/v1/chat/completions",
          endpointHint: "OpenAI hint" },
        { id: "anthropic", label: "Anthropic Messages",
          defaultEndpoint: "https://api.anthropic.com/v1",
          endpointHint: "Anthropic hint" },
        { id: "gemini", label: "Google Gemini",
          defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta",
          endpointHint: "Gemini hint" },
        { id: "ollama", label: "Ollama 原生",
          defaultEndpoint: "http://127.0.0.1:11434",
          endpointHint: "Ollama hint" },
      ],
    },
  });
  vm.runInContext(source, context, { filename: "room.js" });
  context.ReadingRoomUI.startup({
    rootURI: "file:///test/",
    cssURL: "file:///test/room.css",
    iconURL: "file:///test/icon.svg",
    service,
    version: "0.2.0",
  });
  context.ReadingRoomWindow.start({
    window: win,
    document,
    itemID: 2,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return {
    context,
    document,
    timers,
    clearedTimers,
    controllers,
    service,
    windowListeners,
    async openSettings() {
      const open = button(document.body, "模型设置");
      assert.ok(open, "missing settings button");
      open.click();
      await Promise.resolve();
      await Promise.resolve();
      const dialog = descendants(document.body,
        node => node.getAttribute("role") === "dialog")[0];
      assert.ok(dialog);
      return dialog;
    },
  };
}

test("workspace uses catalog and prior analysis without model request", async () => {
  const h = await fixture({ cached: true });
  assert.ok(descendants(h.document.body,
    node => node.textContent === "Synthetic Alpha").length);
  assert.ok(descendants(h.document.body,
    node => node.textContent === "Cached overview.").length);
  assert.equal(h.service.calls.some(call => call.type === "analyze"), false);
  assert.equal(h.service.calls.some(call => call.type === "listModels"), false);
  assert.equal(h.service.calls.some(
    call => call.type === "listConfiguredModels"), false);
  const listCalls = h.service.calls.filter(
    call => call.type === "listPapers");
  assert.ok(listCalls.some(call => call.options.libraryID === null));
});

test("AI button analyzes directly and handles preparing state", async () => {
  const h = await fixture({ cached: true });
  const run = button(h.document.body, "AI 分析");
  assert.ok(run);
  run.click();
  await new Promise(resolve => setImmediate(resolve));
  const call = h.service.calls.find(entry => entry.type === "analyze");
  assert.ok(call);
  assert.equal(call.options.force, false);
  assert.equal(descendants(h.document.body,
    node => node.getAttribute("role") === "dialog").length, 0);
});

test("missing configuration points to independent model settings", async () => {
  const error = new Error("AI configuration required");
  error.code = "AI_CONFIG_REQUIRED";
  const h = await fixture({ failAnalysis: error });
  button(h.document.body, "AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(descendants(h.document.body,
    node => node.textContent.includes("请点击“模型设置”")).length);
  assert.equal(descendants(h.document.body,
    node => node.getAttribute("role") === "dialog").length, 0);
});

test("focus changes persist and refresh focused chips", async () => {
  const h = await fixture();
  const focusButtons = descendants(h.document.body,
    node => node.localName === "button"
      && node.getAttribute("aria-label") === "关注此论文");
  assert.ok(focusButtons.length >= 2);
  focusButtons[0].click();
  await new Promise(resolve => setImmediate(resolve));
  const call = h.service.calls.find(entry => entry.type === "setFocused");
  assert.ok(call);
  assert.equal(call.value, true);
});

test("switching papers flushes pending notes before describe", async () => {
  const h = await fixture();
  const notes = descendants(h.document.body,
    node => node.localName === "textarea")[0];
  notes.value = "changed synthetic notes";
  notes.dispatchEvent({ type: "input", target: notes });
  const target = descendants(h.document.body,
    node => node.localName === "button"
      && descendants(node,
        child => child.textContent === "Synthetic Gamma").length)[0];
  assert.ok(target);
  target.click();
  await new Promise(resolve => setImmediate(resolve));
  const setState = h.service.calls.find(call =>
    call.type === "setState"
      && call.patch.notes === "changed synthetic notes");
  assert.ok(setState);
  assert.ok(h.service.calls.filter(
    call => call.type === "describe").length >= 2);
});

test("closing a room flushes notes before its debounce timer", async () => {
  const h = await fixture();
  const notes = descendants(h.document.body, node => node.localName === "textarea")[0];
  notes.value = "last edit before closing";
  notes.dispatchEvent({ type: "input", target: notes });
  for (const listener of h.windowListeners.get("unload") || []) listener();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.service.calls.some(call => call.type === "setState" && call.patch.notes === "last edit before closing"));
});

test("a failed switch keeps dirty edits available for a subsequent retry", async () => {
  const h = await fixture();
  const notes = descendants(h.document.body, node => node.localName === "textarea")[0];
  notes.value = "keep this after a disk failure";
  notes.dispatchEvent({ type: "input", target: notes });
  const target = descendants(h.document.body, node => node.localName === "button"
    && descendants(node, child => child.textContent === "Synthetic Gamma").length)[0];
  const original = h.service.setState;
  h.service.setState = async () => { throw new Error("synthetic disk failure"); };
  target.click();
  await new Promise(resolve => setImmediate(resolve));
  h.service.setState = original;
  target.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.service.calls.some(call => call.type === "setState" && call.patch.notes === "keep this after a disk failure"));
});

test("settings load config without exposing plaintext key", async () => {
  const h = await fixture();
  const dialog = await h.openSettings();
  const key = descendants(dialog,
    node => node.localName === "input"
      && node.getAttribute("type") === "password")[0];
  assert.equal(key.value, "");
  assert.ok(descendants(dialog,
    node => node.localName === "p"
      && node.textContent.includes("已安全保存")).length);
  const remember = descendants(dialog,
    node => node.localName === "input"
      && node.getAttribute("type") === "checkbox")[0];
  assert.equal(remember.checked, true);
});

test("host or provider change clears key, permissions, and models", async () => {
  const h = await fixture();
  const dialog = await h.openSettings();
  const provider = fieldByText(dialog, "AI 协议").children[1];
  const endpoint = fieldByText(dialog, "API 端点").children[1];
  const key = fieldByText(dialog, "API 密钥").children[1];
  key.value = "synthetic-memory-key";
  endpoint.value = "https://first.example/v1";
  endpoint.dispatchEvent({ type: "input", target: endpoint });
  const remoteRows = descendants(dialog,
    node => node.localName === "label"
      && node.hasAttribute("data-ai-permission"));
  const permissions = remoteRows.flatMap(row =>
    descendants(row, child => child.localName === "input"));
  assert.equal(permissions.length, 2);
  for (const permission of permissions) {
    permission.checked = true;
    permission.dispatchEvent({ type: "change", target: permission });
  }
  provider.value = "anthropic";
  provider.dispatchEvent({ type: "change", target: provider });
  assert.equal(key.value, "");
  assert.ok(permissions.every(permission => !permission.checked));
  assert.equal(descendants(dialog,
    node => node.textContent === "Synthetic A").length, 0);
});

test("remote consent saves current origin and provider together", async () => {
  const h = await fixture();
  const dialog = await h.openSettings();
  const endpoint = fieldByText(dialog, "API 端点").children[1];
  endpoint.value = "https://first.example/v1";
  endpoint.dispatchEvent({ type: "input", target: endpoint });
  const remoteRows = descendants(dialog,
    node => node.localName === "label"
      && node.hasAttribute("data-ai-permission"));
  for (const row of remoteRows) {
    const permission = descendants(row,
      child => child.localName === "input")[0];
    permission.checked = true;
    permission.dispatchEvent({ type: "change", target: permission });
  }
  button(dialog, "保存模型设置").click();
  await new Promise(resolve => setImmediate(resolve));
  const saved = h.service.savedConfigs.at(-1);
  assert.ok(saved);
  assert.equal(saved.config.consentOrigin, "https://first.example");
  assert.equal(saved.config.consentProvider, "openai");
  assert.equal(saved.config.allowRemoteAnalysis, true);
  assert.equal(saved.config.allowRemoteDiscovery, true);
});

test("missing consentProvider does not restore remote permissions", async () => {
  const h = await fixture();
  h.service.getAIConfig = async () => ({
    provider: "openai",
    endpoint: "https://remote.example/v1",
    model: "saved-model",
    allowRemoteDiscovery: true,
    allowRemoteAnalysis: true,
    consentOrigin: "https://remote.example",
    rememberKey: true,
    hasApiKey: false,
    configured: true,
    keyStorageAvailable: true,
  });
  const dialog = await h.openSettings();
  const remoteRows = descendants(dialog,
    node => node.localName === "label"
      && node.hasAttribute("data-ai-permission"));
  const permissions = remoteRows.flatMap(row =>
    descendants(row, child => child.localName === "input"));
  assert.ok(permissions.every(permission => !permission.checked));
});

test("source uses safe DOM APIs and has no extractive mode entry", () => {
  assert.equal(source.includes("innerHTML"), false);
  assert.equal(source.includes("doc.createElement("), false);
  assert.equal(source.includes("抽取式预读"), false);
  assert.equal(source.includes('runAnalysis("extractive")'), false);
  assert.match(source,
    /\["preparing", "extracting", "analyzing", "saving"\]/);
  assert.match(source, /consentProvider/);
  assert.match(source, /listConfiguredModels/);
});
