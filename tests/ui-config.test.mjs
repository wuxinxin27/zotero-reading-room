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
    this.style = { display: "", gridTemplateColumns: "" };
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
  contains(node) {
    return node === this || this.children.some(child => child.contains?.(node));
  }
  getBoundingClientRect() {
    return { left: 0, right: 1000, top: 0, bottom: 800, width: 1000, height: 800 };
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
    this.listeners = new Map();
  }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    return true;
  }
  createElementNS(_namespace, name) {
    const element = new Element(this, name);
    if (name === "select") {
      let values = element.children;
      // HTMLCollection is iterable and array-like, but is not an Array.
      const collection = new Proxy({}, {
        get(_target, key) {
          const value = values[key];
          return typeof value === "function" ? value.bind(values) : value;
        },
      });
      Object.defineProperty(element, "children", {
        get() { return collection; },
        set(next) { values = Array.from(next); },
      });
    }
    return element;
  }
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
function choice(root, label) {
  const trigger = descendants(root, node => node.localName === "button"
    && node.getAttribute("aria-label") === label
    && node.getAttribute("aria-haspopup") === "listbox")[0];
  assert.ok(trigger, `missing choice ${label}`);
  const menu = descendants(root, node => node.localName === "div"
    && node.getAttribute("role") === "listbox"
    && node.getAttribute("id") === trigger.getAttribute("aria-controls"))[0];
  assert.ok(menu, `missing listbox ${label}`);
  return { trigger, menu };
}
function choose(root, label, optionText) {
  const { trigger, menu } = choice(root, label);
  trigger.click();
  const option = descendants(menu, node => node.localName === "button"
    && node.getAttribute("role") === "option"
    && node.textContent === optionText)[0];
  assert.ok(option, `missing option ${optionText}`);
  option.click();
  return trigger;
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

async function fixture({
  cached = false,
  failAnalysis = null,
  batchFactory = null,
  promptConfig = null,
  initialBatchState = null,
} = {}) {
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
    Event: class DOMEvent {
      constructor(type, options = {}) { this.type = type; Object.assign(this, options); }
      preventDefault() {}
      stopPropagation() {}
    },
    AbortController: FakeAbortController,
    requestAnimationFrame(callback) { callback(); return 1; },
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
  document.defaultView = win;
  const papers = [
    paper(1, "Synthetic Alpha"),
    paper(2, "Synthetic Beta", true),
    paper(3, "Synthetic Gamma"),
  ];
  const calls = [];
  const savedConfigs = [];
  const promptSaves = [];
  const promptResets = [];
  const defaultSystemPrompt = "Default complete system prompt.";
  const defaultSynthesisInstruction = "Default synthesis instruction.";
  const defaultChatSystemPrompt = "Default complete chat system prompt.";
  let currentPrompt = promptConfig || {
    systemPrompt: defaultSystemPrompt,
    synthesisInstruction: defaultSynthesisInstruction,
    chatSystemPrompt: defaultChatSystemPrompt,
    defaultSystemPrompt,
    defaultSynthesisInstruction,
    defaultChatSystemPrompt,
    chatPromptHash: "default-chat-prompt-hash",
    promptHash: "default-prompt-hash",
    isCustom: false,
    updatedAt: null,
  };
  let batchState = {
    id: null,
    status: "idle",
    force: false,
    entries: [],
    counts: {
      total: 0, queued: 0, running: 0, reused: 0,
      succeeded: 0, failed: 0, cancelled: 0,
    },
  };
  if (initialBatchState) batchState = initialBatchState;
  const cachedAnalysis = {
    mode: "model",
    source: { attachmentKey: "ATTACH01" },
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
    promptSaves,
    promptResets,
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
      return [
        { id: 1, name: "Synthetic Library",
          type: "user", editable: true },
        { id: 7, name: "Synthetic Group",
          type: "group", editable: false },
      ];
    },
    async listCollections(options = {}) {
      calls.push({ type: "listCollections", options });
      return [
        { id: 11, key: "COL11", libraryID: 1,
          name: "Methods", parentID: null },
        { id: 12, key: "COL12", libraryID: 1,
          name: "Nested", parentID: 11 },
        { id: 13, key: "COL13", libraryID: 1,
          name: "Empty folder", parentID: null },
        { id: 71, key: "COL71", libraryID: 7,
          name: "Group folder", parentID: null },
      ].filter(row => options.libraryID == null
        || row.libraryID === options.libraryID);
    },
    async listPapers(options) {
      calls.push({ type: "listPapers", options });
      let items = papers.map(entry => ({ ...entry }));
      if (options.collectionID === 12) {
        items = items.filter(entry => entry.id === 3);
      }
      else if (options.collectionID === 13) items = [];
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
        tagSync: Object.hasOwn(patch, "status") ? {
          status: "synced", tag: `阅读室/${patch.status}`,
        } : undefined,
        analysis: null,
      };
    },
    async getConversation(item, options) {
      calls.push({ type: "getConversation", item, options });
      return {
        attachmentID: options.attachmentID,
        attachmentKey: "ATTACH01",
        messages: [],
      };
    },
    async askPaper(item, question, options) {
      calls.push({ type: "askPaper", item, question, options });
      options.onProgress?.({ status: "extracting", detail: "extracting synthetic text" });
      return {
        attachmentID: options.attachmentID,
        attachmentKey: "ATTACH01",
        messages: [
          { id: "u1", role: "user", content: question,
            createdAt: "2026-11-01T03:00:00.000Z" },
          { id: "a1", role: "assistant", content: "Synthetic grounded answer.",
            createdAt: "2026-11-01T03:00:01.000Z", grounded: true,
            verificationNotice: "Synthetic verification notice.",
            evidence: [{ quote: "Synthetic source quote", pageIndex: 4,
              attachmentKey: "ATTACH01", verified: true }] },
        ],
      };
    },
    cancelChat(item) {
      calls.push({ type: "cancelChat", item });
      return true;
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
    async getPromptConfig() {
      calls.push({ type: "getPromptConfig" });
      return { ...currentPrompt };
    },
    async savePromptConfig(input) {
      calls.push({ type: "savePromptConfig", input });
      promptSaves.push({ ...input });
      currentPrompt = {
        ...input,
        defaultSystemPrompt,
        defaultSynthesisInstruction,
        defaultChatSystemPrompt,
        chatPromptHash: "custom-chat-prompt-hash",
        promptHash: "custom-prompt-hash",
        isCustom: input.systemPrompt !== defaultSystemPrompt
          || input.synthesisInstruction !== defaultSynthesisInstruction,
        updatedAt: "2026-11-01T01:00:00.000Z",
      };
      return { ...currentPrompt };
    },
    async resetPromptConfig() {
      calls.push({ type: "resetPromptConfig" });
      promptResets.push(true);
      currentPrompt = {
        systemPrompt: defaultSystemPrompt,
        synthesisInstruction: defaultSynthesisInstruction,
        chatSystemPrompt: defaultChatSystemPrompt,
        defaultSystemPrompt,
        defaultSynthesisInstruction,
        defaultChatSystemPrompt,
        chatPromptHash: "default-chat-prompt-hash",
        promptHash: "default-prompt-hash",
        isCustom: false,
        updatedAt: "2026-11-01T02:00:00.000Z",
      };
      return { ...currentPrompt };
    },
    getBatchState() {
      return JSON.parse(JSON.stringify(batchState));
    },
    async analyzeBatch(items, options) {
      calls.push({ type: "analyzeBatch", items, options });
      if (batchFactory) {
        return batchFactory({
          items,
          options,
          service: this,
          setState(value) { batchState = value; },
        });
      }
      const entries = items.map(item => {
        const id = typeof item === "number" ? item : item.itemID;
        const metadata = papers.find(entry => entry.id === id);
        return {
          itemID: id,
          libraryID: 1,
          key: metadata.key,
          title: metadata.title,
          status: "succeeded",
        };
      });
      batchState = {
        id: "batch-test",
        status: "completed",
        force: options.force,
        entries,
        counts: {
          total: entries.length, queued: 0, running: 0, reused: 0,
          succeeded: entries.length, failed: 0, cancelled: 0,
        },
        startedAt: "2026-11-01T01:00:00.000Z",
        finishedAt: "2026-11-01T01:01:00.000Z",
      };
      options.onProgress?.(JSON.parse(JSON.stringify(batchState)));
      return JSON.parse(JSON.stringify(batchState));
    },
    cancelBatch() {
      calls.push({ type: "cancelBatch" });
      return batchState.status === "running";
    },
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
      getMainWindow() {
        return {
          ZoteroPane: {
            getSelectedLibraryID() { return 1; },
            getSelectedCollection() { return { id: 11, libraryID: 1 }; },
          },
        };
      },
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
    nativeContext: {
      embedded: true,
      itemID: 2,
      tabID: "reader-tab-2",
    },
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
    async openPrompt() {
      const open = button(document.body, "分析提示词");
      assert.ok(open, "missing prompt button");
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
  assert.ok(listCalls.some(call => call.options.libraryID === 1
    && call.options.collectionID === 11));
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
    node => node.localName === "textarea"
      && node.getAttribute("aria-label") !== "询问当前论文")[0];
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
  const notes = descendants(h.document.body,
    node => node.localName === "textarea"
      && node.getAttribute("aria-label") !== "询问当前论文")[0];
  notes.value = "last edit before closing";
  notes.dispatchEvent({ type: "input", target: notes });
  for (const listener of h.windowListeners.get("unload") || []) listener();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.service.calls.some(call => call.type === "setState" && call.patch.notes === "last edit before closing"));
});

test("a failed switch keeps dirty edits available for a subsequent retry", async () => {
  const h = await fixture();
  const notes = descendants(h.document.body,
    node => node.localName === "textarea"
      && node.getAttribute("aria-label") !== "询问当前论文")[0];
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
  choose(dialog, "AI 协议", "Anthropic Messages");
  assert.equal(key.value, "");
  assert.ok(permissions.every(permission => !permission.checked));
  assert.equal(descendants(dialog,
    node => node.textContent === "Synthetic A").length, 0);
});

test("visible AI protocol listbox changes the backing value by click and keyboard", async () => {
  const h = await fixture();
  const dialog = await h.openSettings();
  const { trigger, menu } = choice(dialog, "AI 协议");
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  trigger.click();
  assert.equal(trigger.getAttribute("aria-expanded"), "true");
  assert.equal(menu.hasAttribute("hidden"), false);
  const anthropic = descendants(menu,
    node => node.getAttribute("role") === "option"
      && node.textContent === "Anthropic Messages")[0];
  assert.ok(anthropic);
  const backing = descendants(dialog, node => node.localName === "select"
    && node.getAttribute("aria-label") === "AI 协议")[0];
  assert.equal(Array.isArray(backing.children), false);
  let changeEvent;
  backing.addEventListener("change", event => { changeEvent = event; });
  anthropic.click();
  assert.ok(changeEvent instanceof h.document.defaultView.Event);
  assert.equal(changeEvent.bubbles, true);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.children[0].textContent, "Anthropic Messages");
  const provider = descendants(dialog,
    node => node.localName === "select"
      && node.getAttribute("aria-label") === "AI 协议")[0];
  assert.equal(provider.value, "anthropic");

  trigger.click();
  const gemini = descendants(menu,
    node => node.getAttribute("role") === "option"
      && node.textContent === "Google Gemini")[0];
  menu.dispatchEvent({ type: "keydown", key: "ArrowDown",
    target: gemini, preventDefault() {}, stopPropagation() {} });
  menu.dispatchEvent({ type: "keydown", key: "Enter",
    target: gemini, preventDefault() {}, stopPropagation() {} });
  assert.equal(provider.value, "gemini");
  assert.equal(gemini.getAttribute("tabindex"), "0");
  assert.equal(trigger.focused, true);

  trigger.click();
  menu.dispatchEvent({ type: "keydown", key: "Escape",
    target: menu, preventDefault() {}, stopPropagation() {} });
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  assert.equal(trigger.focused, true);
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

test("collection tree keeps nested and empty folders and scopes catalog selection", async () => {
  const h = await fixture();
  assert.ok(descendants(h.document.body,
    node => node.textContent === "Synthetic Library").length);
  assert.ok(descendants(h.document.body,
    node => node.textContent === "Empty folder").length);
  const methods = descendants(h.document.body,
    node => node.localName === "button"
      && node.textContent === "Methods")[0];
  assert.ok(methods);
  const toggle = descendants(h.document.body,
    node => node.localName === "button"
      && node.getAttribute("aria-label") === "展开 Methods")[0];
  assert.ok(toggle);
  toggle.click();
  const expandedToggle = descendants(h.document.body,
    node => node.localName === "button"
      && node.getAttribute("aria-label") === "收起 Methods")[0];
  assert.ok(expandedToggle);
  assert.equal(expandedToggle.getAttribute("aria-expanded"), "true");
  const nested = descendants(h.document.body,
    node => node.localName === "button"
      && node.textContent === "Nested")[0];
  assert.ok(nested);
  nested.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(descendants(h.document.body,
    node => node.localName === "button"
      && node.textContent === "Nested"
      && node.getAttribute("aria-current") === "true").length);
  const scoped = h.service.calls.filter(call =>
    call.type === "listPapers"
    && call.options.collectionID === 12).at(-1);
  assert.ok(scoped);
  assert.equal(scoped.options.libraryID, 1);
  assert.ok(descendants(h.document.body,
    node => node.textContent === "Synthetic Library / Methods / Nested").length);
  assert.ok(descendants(h.document.body,
    node => node.textContent === "Synthetic Gamma").length);
  assert.equal(descendants(h.document.body,
    node => node.textContent === "Synthetic Alpha").length, 0);
});

test("library trees never duplicate folders across libraries and remain available after selection", async () => {
  const h = await fixture();
  const libraries = descendants(h.document.body, node =>
    node.classList.contains("rr-tree-library"));
  assert.equal(libraries.length, 2);
  assert.equal(descendants(libraries[0], node => node.textContent === "Group folder").length, 0);
  assert.equal(descendants(libraries[1], node => node.textContent === "Methods").length, 0);
  choose(h.document.body, "选择文库", "Synthetic Group · 群组");
  await new Promise(resolve => setImmediate(resolve));
  const personal = descendants(h.document.body, node => node.localName === "button"
    && node.textContent === "Methods")[0];
  assert.ok(personal, "other library tree must remain available");
  personal.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.service.calls.some(call => call.type === "listPapers"
    && call.options.libraryID === 1 && call.options.collectionID === 11));
});

test("attachment choices populate after selecting a paper", async () => {
  const h = await fixture();
  const { trigger, menu } = choice(h.document.body, "选择用于原文与分析的本地 PDF");
  trigger.click();
  const options = descendants(menu, node => node.getAttribute("role") === "option");
  assert.equal(options.length, 1);
  assert.equal(options[0].textContent, "Synthetic PDF");
  options[0].click();
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
});

test("focused-paper shortcuts survive selecting an empty collection", async () => {
  const h = await fixture();
  const empty = descendants(h.document.body, node => node.localName === "button"
    && node.textContent === "Empty folder")[0];
  empty.click();
  await new Promise(resolve => setImmediate(resolve));
  const chips = descendants(h.document.body, node => node.classList.contains("rr-focus-chip"));
  assert.ok(chips.some(node => node.textContent === "Synthetic Beta"));
  const query = h.service.calls.filter(call => call.type === "listPapers"
    && call.options.focusOnly).at(-1).options;
  assert.equal(query.libraryID, null);
  assert.equal(query.collectionID, null);
});

test("scope switch flushes dirty notes and search resets page and scope", async () => {
  const h = await fixture();
  const notes = descendants(h.document.body,
    node => node.localName === "textarea")[0];
  notes.value = "scope switch must save";
  notes.dispatchEvent({ type: "input", target: notes });
  choose(h.document.body, "选择文库", "Synthetic Group · 群组");
  await new Promise(resolve => setImmediate(resolve));
  const groupFolder = descendants(h.document.body,
    node => node.localName === "button"
      && node.textContent === "Group folder")[0];
  assert.ok(groupFolder);
  groupFolder.click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  // Switching a directory scope updates only the catalog query; it does not
  // replace the current paper, so dirty notes remain queued for paper switch.
  const draft = descendants(h.document.body,
    node => node.localName === "textarea")[0];
  assert.equal(draft.value, "scope switch must save");
  const scoped = h.service.calls.filter(call =>
    call.type === "listPapers"
    && call.options.libraryID === 7
    && call.options.collectionID === 71).at(-1);
  assert.ok(scoped);
  const search = descendants(h.document.body,
    node => node.localName === "input"
      && node.getAttribute("type") === "search")[0];
  search.value = "Gamma";
  search.dispatchEvent({ type: "input", target: search });
  const callback = h.timers.at(-1);
  callback();
  await new Promise(resolve => setImmediate(resolve));
  const searched = h.service.calls.filter(call =>
    call.type === "listPapers"
    && call.options.query === "Gamma").at(-1);
  assert.ok(searched);
  assert.equal(searched.options.offset, 0);
  assert.equal(searched.options.libraryID, 7);
  assert.equal(searched.options.collectionID, 71);
});

test("navigation collapse updates the root workspace class and restores it", async () => {
  const h = await fixture();
  const workspace = descendants(h.document.body,
    node => node.localName === "div"
      && node.classList.contains("rr-workspace"))[0];
  const navigation = descendants(h.document.body,
    node => node.localName === "aside")[0];
  assert.ok(workspace && navigation);
  const collapse = button(h.document.body, "展开");
  assert.ok(workspace.classList.contains("navigation-collapsed"));
  assert.ok(navigation.classList.contains("collapsed"));
  assert.equal(collapse.getAttribute("aria-expanded"), "false");
  collapse.click();
  assert.equal(workspace.classList.contains("navigation-collapsed"), false);
  assert.equal(navigation.classList.contains("collapsed"), false);
  assert.equal(collapse.getAttribute("aria-expanded"), "true");
  collapse.click();
  assert.ok(workspace.classList.contains("navigation-collapsed"));
});

test("prompt settings display, edit, save and reset through real UI events", async () => {
  const h = await fixture();
  let dialog = await h.openPrompt();
  const system = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "完整系统提示词")[0];
  const synthesis = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "综合阶段指令")[0];
  const chat = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "论文对话系统提示词")[0];
  assert.equal(system.value, "Default complete system prompt.");
  assert.equal(synthesis.value, "Default synthesis instruction.");
  assert.equal(chat.value, "Default complete chat system prompt.");
  assert.ok(textOf(dialog).includes("Default complete system prompt."));
  assert.ok(textOf(dialog).includes("Default complete chat system prompt."));
  system.value = "Custom full system prompt.\nKeep strict JSON.";
  system.dispatchEvent({ type: "input", target: system });
  synthesis.value = "Custom synthesis instruction.";
  synthesis.dispatchEvent({ type: "input", target: synthesis });
  chat.value = "Custom full chat system prompt.";
  chat.dispatchEvent({ type: "input", target: chat });
  assert.ok(textOf(dialog).includes("Default synthesis instruction."));
  button(dialog, "保存提示词").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.service.promptSaves.at(-1), {
    systemPrompt: "Custom full system prompt.\nKeep strict JSON.",
    synthesisInstruction: "Custom synthesis instruction.",
    chatSystemPrompt: "Custom full chat system prompt.",
  });
  assert.equal(h.service.calls.some(call =>
    ["analyze", "analyzeBatch", "listModels", "listConfiguredModels"]
      .includes(call.type)), false);

  dialog = await h.openPrompt();
  button(dialog, "恢复默认值").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.promptResets.length, 1);
  const restored = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "完整系统提示词")[0];
  const restoredChat = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "论文对话系统提示词")[0];
  assert.equal(restored.value, "Default complete system prompt.");
  assert.equal(restoredChat.value, "Default complete chat system prompt.");
});

test("batch selection persists across pages and starts only after review", async () => {
  const h = await fixture();
  const pageChecks = descendants(h.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select");
  assert.equal(pageChecks.length, 3);
  pageChecks[0].checked = true;
  pageChecks[0].dispatchEvent({ type: "change", target: pageChecks[0] });
  button(h.document.body, "下一页").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(textOf(h.document.body).includes("已选 1 篇"));
  button(h.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = descendants(h.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  assert.ok(dialog);
  assert.ok(textOf(dialog).includes("已明确选择 1 篇"));
  assert.ok(textOf(dialog).includes("Synthetic Alpha"));
  assert.equal(h.service.calls.some(call => call.type === "analyzeBatch"),
    false);
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const call = h.service.calls.find(entry =>
    entry.type === "analyzeBatch");
  assert.deepEqual(Array.from(call.items, item => ({ itemID: item.itemID })),
    [{ itemID: 1 }]);
  assert.equal(call.options.force, false);
  assert.ok(textOf(h.document.body).includes("批量分析已完成"));
});

test("current filtered selection enumerates every page and caps explicitly", async () => {
  const h = await fixture();
  const addAll = button(h.document.body, "加入当前筛选全部");
  addAll.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(textOf(h.document.body).includes("已选 3 篇"));
  const selectionCalls = h.service.calls.filter(call =>
    call.type === "listPapers"
    && call.options.query === ""
    && call.options.libraryID === 1
    && call.options.collectionID === 11);
  assert.ok(selectionCalls.length >= 2);
  assert.ok(selectionCalls.every(call =>
    call.options.offset % call.options.limit === 0));
  button(h.document.body, "清空选择").click();
  assert.ok(textOf(h.document.body).includes("已选 0 篇"));
});

test("batch progress locks manual analysis and allows failed-item retry", async () => {
  let release;
  const h = await fixture({
    cached: true,
    batchFactory({ items, options, setState }) {
      const running = {
        id: "batch-running",
        status: "running",
        force: false,
        currentItemID: 1,
        entries: [{
          itemID: 1,
          libraryID: 1,
          key: "KEY1",
          title: "Synthetic Alpha",
          status: "running",
          stage: "analyzing",
        }],
        counts: {
          total: 1, queued: 0, running: 1, reused: 0,
          succeeded: 0, failed: 0, cancelled: 0,
        },
      };
      setState(running);
      options.onProgress?.(running);
      return new Promise(resolve => {
        release = () => {
          const failed = {
            ...running,
            status: "completed",
            entries: [{
              ...running.entries[0],
              status: "failed",
              error: { code: "MODEL_TIMEOUT", message: "模型请求超时。" },
            }],
            counts: {
              total: 1, queued: 0, running: 0, reused: 0,
              succeeded: 0, failed: 1, cancelled: 0,
            },
          };
          setState(failed);
          resolve(failed);
        };
      });
    },
  });
  const pageCheck = descendants(h.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select")[0];
  pageCheck.checked = true;
  pageCheck.dispatchEvent({ type: "change", target: pageCheck });
  button(h.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = descendants(h.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(button(h.document.body, "AI 分析").disabled, true);
  assert.equal(button(h.document.body, "重新分析").disabled, true);
  assert.equal(button(h.document.body, "模型设置").disabled, true);
  assert.equal(button(h.document.body, "分析提示词").disabled, true);
  assert.equal(button(dialog, "关闭").disabled, false);
  assert.ok(textOf(h.document.body).includes("批量分析进行中"));
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(textOf(h.document.body).includes("重试 1 篇失败项"));
  assert.equal(button(h.document.body, "AI 分析").disabled, false);
});

test("existing cached batch results render without duplicate work", async () => {
  const h = await fixture({
    cached: true,
    batchFactory({ items, options, setState }) {
      const reused = {
        id: "batch-cache",
        status: "completed",
        force: false,
        entries: [{
          itemID: items[0].itemID,
          libraryID: 1,
          key: "KEY2",
          title: "Synthetic Beta",
          status: "reused",
        }],
        counts: {
          total: 1, queued: 0, running: 0, reused: 1,
          succeeded: 0, failed: 0, cancelled: 0,
        },
      };
      setState(reused);
      options.onProgress?.(reused);
      return reused;
    },
  });
  const beta = descendants(h.document.body, node =>
    node.localName === "button"
    && descendants(node, child => child.textContent === "Synthetic Beta").length
    && node.getAttribute("class") === "rr-paper-open")[0];
  beta.click();
  await new Promise(resolve => setImmediate(resolve));
  const checks = descendants(h.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select");
  checks[1].checked = true;
  checks[1].dispatchEvent({ type: "change", target: checks[1] });
  button(h.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = descendants(h.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.calls.some(call => call.type === "analyze"),
    false);
  assert.ok(textOf(h.document.body).includes("复用缓存"));
  assert.ok(textOf(h.document.body).includes("Cached overview."));
});

test("cancelled batch marks pending items and preserves persisted monitor on reopen", async () => {
  const h = await fixture({
    batchFactory({ items, options, setState }) {
      const running = {
        id: "batch-cancel",
        status: "running",
        force: false,
        entries: items.map((item, index) => ({
          itemID: item.itemID,
          libraryID: 1,
          key: `KEY${item.itemID}`,
          title: index ? "Synthetic Gamma" : "Synthetic Alpha",
          status: index ? "queued" : "running",
        })),
        counts: {
          total: 2, queued: 1, running: 1, reused: 0,
          succeeded: 0, failed: 0, cancelled: 0,
        },
      };
      setState(running);
      options.onProgress?.(running);
      return new Promise(resolve => {
        const cancelled = {
          ...running,
          status: "cancelled",
          entries: running.entries.map(entry => ({
            ...entry,
            status: "cancelled",
          })),
          counts: {
            total: 2, queued: 0, running: 0, reused: 0,
            succeeded: 0, failed: 0, cancelled: 2,
          },
        };
        setState(cancelled);
        resolve(cancelled);
      });
    },
  });
  const checks = descendants(h.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select");
  for (const check of checks.slice(0, 2)) {
    check.checked = true;
    check.dispatchEvent({ type: "change", target: check });
  }
  button(h.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = descendants(h.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));
  button(dialog, "取消批次").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(h.service.calls.some(call => call.type === "cancelBatch"));
  assert.ok(textOf(h.document.body).includes("批量分析已取消"));
  const persisted = h.service.getBatchState();
  assert.equal(persisted.counts.cancelled, 2);
});

test("reopening a room restores the latest persisted batch without starting work", async () => {
  const first = await fixture({
    batchFactory({ items, options, setState }) {
      const completed = {
        id: "batch-reopen",
        status: "completed",
        force: false,
        entries: [{
          itemID: items[0].itemID,
          libraryID: 1,
          key: "KEY1",
          title: "Synthetic Alpha",
          status: "succeeded",
        }],
        counts: {
          total: 1, queued: 0, running: 0, reused: 0,
          succeeded: 1, failed: 0, cancelled: 0,
        },
      };
      setState(completed);
      options.onProgress?.(completed);
      return completed;
    },
  });
  const check = descendants(first.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select")[0];
  check.checked = true;
  check.dispatchEvent({ type: "change", target: check });
  button(first.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  let dialog = descendants(first.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(first.service.getBatchState().status, "completed");
  const persisted = first.service.getBatchState();
  assert.ok(textOf(first.document.body).includes("批量分析已完成"));
  assert.equal(persisted.entries[0].status, "succeeded");
});

test("new room reads persisted batch state on mount without model calls", async () => {
  const first = await fixture({
    batchFactory({ items, options, setState }) {
      const completed = {
        id: "batch-persist",
        status: "completed",
        force: false,
        entries: [{
          itemID: items[0].itemID,
          libraryID: 1,
          key: "KEY1",
          title: "Synthetic Alpha",
          status: "succeeded",
        }],
        counts: {
          total: 1, queued: 0, running: 0, reused: 0,
          succeeded: 1, failed: 0, cancelled: 0,
        },
      };
      setState(completed);
      options.onProgress?.(completed);
      return completed;
    },
  });
  const check = descendants(first.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select")[0];
  check.checked = true;
  check.dispatchEvent({ type: "change", target: check });
  button(first.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = descendants(first.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));

  const second = await fixture({
    initialBatchState: first.service.getBatchState(),
  });
  assert.ok(textOf(second.document.body).includes("批量分析已完成"));
  assert.equal(second.service.calls.some(call =>
    ["analyze", "analyzeBatch"].includes(call.type)), false);
  button(second.document.body, "批次状态").click();
  await new Promise(resolve => setImmediate(resolve));
  const statusDialog = descendants(second.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  assert.ok(textOf(statusDialog).includes("Synthetic Alpha"));
  assert.ok(textOf(statusDialog).includes("已完成"));
});

test("narrow room CSS keeps prompt and batch controls reflowable", async () => {
  const css = await fs.readFile(
    new URL("../addon/content/room.css", import.meta.url), "utf8",
  );
  assert.match(css, /@media \(max-width: 480px\)/);
  assert.match(css, /\.rr-selection-bar \{[^}]*flex-wrap: wrap/s);
  assert.match(css, /\.rr-batch-preview-row \{[^}]*grid-template-columns:/s);
  assert.match(css, /\.rr-modal \{[^}]*width: min\(650px, calc\(100vw - 36px\)\)/s);
});

test("batch review cancels a running queue when the window unloads", async () => {
  let release;
  const h = await fixture({
    batchFactory({ items, options, setState }) {
      const running = {
        id: "batch-unload",
        status: "running",
        force: false,
        entries: [{
          itemID: items[0].itemID,
          libraryID: 1,
          key: "KEY1",
          title: "Synthetic Alpha",
          status: "running",
        }],
        counts: {
          total: 1, queued: 0, running: 1, reused: 0,
          succeeded: 0, failed: 0, cancelled: 0,
        },
      };
      setState(running);
      options.onProgress?.(running);
      return new Promise(resolve => {
        release = () => resolve(running);
      });
    },
  });
  const check = descendants(h.document.body, node =>
    node.localName === "input"
    && node.getAttribute("class") === "rr-paper-select")[0];
  check.checked = true;
  check.dispatchEvent({ type: "change", target: check });
  button(h.document.body, "批量 AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const dialog = descendants(h.document.body,
    node => node.getAttribute("role") === "dialog")[0];
  button(dialog, "开始批量分析").click();
  await new Promise(resolve => setImmediate(resolve));
  for (const listener of h.windowListeners.get("unload") || []) listener();
  assert.ok(h.service.calls.some(call => call.type === "cancelBatch"));
  release();
  await new Promise(resolve => setImmediate(resolve));
});

test("embedded layout hides its PDF workspace and shows paper chat without model calls on open", async () => {
  const h = await fixture();
  assert.equal(h.document.documentElement.getAttribute("data-embedded"), "true");
  const hiddenSource = descendants(h.document.body, node =>
    node.getAttribute("class") === "rr-source-pane")[0];
  assert.equal(hiddenSource, undefined,
    "embedded layout must not append the redundant PDF pane");
  assert.ok(descendants(h.document.body, node =>
    node.getAttribute("class") === "rr-reading-grid rr-reading-grid-embedded").length);
  assert.ok(textOf(h.document.body).includes("论文对话"));
  assert.ok(textOf(h.document.body).includes("仅基于当前 PDF"));
  assert.equal(h.service.calls.some(call => call.type === "askPaper"), false);
  assert.equal(h.service.calls.some(call => call.type === "getConversation")
    && h.service.calls.filter(call => call.type === "getConversation").every(
      call => call.item && call.options.attachmentID === 101), true);
});

test("paper chat sends explicit text, renders verified sources and navigates native PDF", async () => {
  const h = await fixture();
  const navigate = [];
  h.context.Zotero.Reader.getByTabID = tabID => ({
    tabID,
    itemID: 101,
    async navigate(location) { navigate.push(location); },
  });
  const input = descendants(h.document.body, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "询问当前论文")[0];
  const send = button(h.document.body, "发送");
  assert.ok(input);
  assert.ok(send);
  assert.equal(send.disabled, false);
  input.value = "What is the synthetic method?";
  send.click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const call = h.service.calls.find(entry => entry.type === "askPaper");
  assert.ok(call);
  assert.equal(call.question, "What is the synthetic method?");
  assert.equal(call.options.attachmentID, 101);
  assert.ok(textOf(h.document.body).includes("Synthetic grounded answer."));
  assert.ok(textOf(h.document.body).includes("Synthetic verification notice."));
  assert.ok(textOf(h.document.body).includes("本次原文逐字匹配"));
  const source = button(h.document.body, "“Synthetic source quote”");
  assert.ok(source);
  source.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(navigate)), [{ pageIndex: 4 }]);
});

test("chat cancellation is scoped to the owned paper and preserves old history", async () => {
  let release;
  const h = await fixture();
  h.service.askPaper = (item, question, options) => new Promise((resolve, reject) => {
    h.service.calls.push({ type: "askPaper", item, question, options });
    options.signal?.addEventListener("abort", () => reject(Object.assign(
      new Error("cancelled"), { code: "CANCELLED" },
    )));
    release = () => resolve({
      attachmentID: options.attachmentID,
      attachmentKey: "ATTACH01",
      messages: [],
    });
  });
  const input = descendants(h.document.body, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "询问当前论文")[0];
  input.value = "Cancel this question";
  button(h.document.body, "发送").click();
  await new Promise(resolve => setImmediate(resolve));
  button(h.document.body, "取消对话").click();
  await new Promise(resolve => setImmediate(resolve));
  const cancelled = h.service.calls.find(call => call.type === "cancelChat");
  assert.ok(cancelled);
  assert.equal(cancelled.item.id, 2);
  assert.ok(textOf(h.document.body).includes("此前保存的问答仍保留"));
  release();
  await new Promise(resolve => setImmediate(resolve));
});

test("tag sync failures are shown as local-only warnings instead of saved-to-native claims", async () => {
  const h = await fixture();
  h.service.setState = async (item, patch) => {
    h.service.calls.push({ type: "setState", item, patch });
    return {
      status: patch.status,
      notes: "", checklist: {},
      tagSync: {
        status: "error",
        tag: "阅读室/已读",
        code: "TAG_SYNC_FAILED",
        message: "本地阅读状态已保存；原生标签写入失败，请再次选择状态重试。",
      },
    };
  };
  const status = descendants(h.document.body, node =>
    node.localName === "button"
    && node.getAttribute("data-status") === "read")[0];
  assert.ok(status);
  status.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(textOf(h.document.body).includes("原生标签写入失败"));
  assert.ok(textOf(h.document.body).includes("点击状态可重试"));
  assert.equal(textOf(h.document.body).includes("阅读状态已保存为“已读”"), false);
});

test("idle view disposal leaves another view's chat request untouched", async () => {
  const h = await fixture();
  for (const listener of h.windowListeners.get("unload") || []) listener();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.calls.some(call => call.type === "cancelChat"), false);
});

test("native catalog selection opens the requested native reader rather than replacing this tab's paper", async () => {
  const h = await fixture();
  const shown = [];
  h.context.Zotero.ReadingRoom = { async show(options) { shown.push(options); } };
  const target = descendants(h.document.body, node => node.localName === "button"
    && descendants(node, child => child.textContent === "Synthetic Gamma").length)[0];
  target.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].itemID, 3);
  assert.equal(h.service.calls.filter(call => call.type === "describe").length, 1);
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
  assert.match(source, /getPromptConfig/);
  assert.match(source, /analyzeBatch/);
  assert.match(source, /getBatchState/);
});
