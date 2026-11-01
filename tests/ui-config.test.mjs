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
  failChat = null,
  promptConfig = null,
  contextOverrides = {},
  sharedService = null,
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
  const analysisOutputContract =
    "Analysis application output protocol v1: return validated JSON.";
  const chatOutputContract =
    "Chat application output protocol v1: return answer and evidence.";
  const effectivePrompt = (prompt, contract) => `${prompt}\n\n${contract}`;
  const makePromptConfig = input => ({
    ...input,
    defaultSystemPrompt,
    defaultSynthesisInstruction,
    defaultChatSystemPrompt,
    analysisOutputContract,
    chatOutputContract,
    outputContractVersion: "1",
    effectiveAnalysisSystemPrompt:
      effectivePrompt(input.systemPrompt, analysisOutputContract),
    effectiveChatSystemPrompt:
      effectivePrompt(input.chatSystemPrompt, chatOutputContract),
    chatPromptHash: "test-chat-prompt-hash",
    promptHash: "test-prompt-hash",
    isCustom: input.systemPrompt !== defaultSystemPrompt
      || input.synthesisInstruction !== defaultSynthesisInstruction,
    isChatCustom: input.chatSystemPrompt !== defaultChatSystemPrompt,
  });
  let currentPrompt = promptConfig || makePromptConfig({
    systemPrompt: defaultSystemPrompt,
    synthesisInstruction: defaultSynthesisInstruction,
    chatSystemPrompt: defaultChatSystemPrompt,
    updatedAt: null,
  });
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
    normalizeItem(item) { return item && (item.parentID ? parents.get(item.parentID) : item) || null; },
    getState() {
      return {
        status: "unread",
        notes: "",
        checklist: {},
        analysis: cached ? cachedAnalysis : null,
      };
    },
    ...Object.fromEntries(["listLibraries", "listCollections", "listPapers",
      "loadCatalog", "setFocused", "analyzeBatch", "getBatchState"].map(name => [name, () => {
      calls.push({ type: name });
      throw new Error(`current-only view must never call ${name}`);
    }])),
    async describe(item) {
      calls.push({ type: "describe", item });
      const metadata = papers.find(entry => entry.id === item.id);
      return {
        item: { ...metadata, doi: "10.0000/synthetic" },
        attachments: [...attachments.values()].filter(value => value.parentID === item.id)
          .map(value => ({ id: value.id, key: value.key, title: value.title,
            contentType: value.attachmentContentType, available: true })),
        counts: { notes: 0, annotations: 0 },
        state: structuredClone(readings.get(item.id)),
      };
    },
    async setState(item, patch) {
      calls.push({ type: "setState", item, patch });
      const reading = { ...readings.get(item.id), ...patch,
        tagSync: Object.hasOwn(patch, "status") ? {
          status: "synced", tag: `阅读室/${patch.status}`,
        } : undefined,
      };
      readings.set(item.id, reading);
      return structuredClone(reading);
    },
    async saveAnalysisNote(item) {
      calls.push({ type: "saveAnalysisNote", item });
      return { created: true };
    },
    async syncStateNote(item) {
      calls.push({ type: "syncStateNote", item });
      return { changed: true, created: true };
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
      if (failChat) throw failChat;
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
    async getReaderAttachment(item, options) {
      calls.push({ type: "getReaderAttachment", item, options });
      const attachment = attachments.get(options.attachmentID);
      assert.equal(attachment.parentID, item.id);
      assert.equal(attachment.key, options.attachmentKey);
      return {
        id: attachment.id, key: attachment.key, libraryID: attachment.libraryID,
        title: attachment.title, path: "/synthetic/paper.pdf", available: true,
        contentType: "application/pdf",
      };
    },
    async analyze(item, options) {
      calls.push({ type: "analyze", item, options });
      options.onProgress({ status: "preparing", detail: "checking cache" });
      if (failAnalysis) throw failAnalysis;
      return cachedAnalysis;
    },
    cancelAnalysis(item) { calls.push({ type: "cancelAnalysis", item }); return false; },
    async getPromptConfig() {
      calls.push({ type: "getPromptConfig" });
      return { ...currentPrompt };
    },
    async savePromptConfig(input) {
      calls.push({ type: "savePromptConfig", input });
      promptSaves.push({ ...input });
      currentPrompt = makePromptConfig({
        ...input,
        updatedAt: "2026-11-01T01:00:00.000Z",
      });
      return { ...currentPrompt };
    },
    async resetPromptConfig() {
      calls.push({ type: "resetPromptConfig" });
      promptResets.push(true);
      currentPrompt = makePromptConfig({
        systemPrompt: defaultSystemPrompt,
        synthesisInstruction: defaultSynthesisInstruction,
        chatSystemPrompt: defaultChatSystemPrompt,
        updatedAt: "2026-11-01T02:00:00.000Z",
      });
      return { ...currentPrompt };
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
  const attachments = new Map([
    [101, { id: 101, key: "ATTACH01", parentID: 2, title: "Synthetic PDF" }],
    [102, { id: 102, key: "ATTACH02", parentID: 2, title: "Synthetic second PDF" }],
    [301, { id: 301, key: "ATTACH03", parentID: 3, title: "Gamma PDF" }],
  ].map(([id, attachment]) => [id, { ...attachment, libraryID: 1,
    attachmentContentType: "application/pdf", isAttachment() { return true; } }]));
  const readings = new Map(papers.map(metadata => [metadata.id, {
    status: "unread", notes: "Unsaved synthetic note", checklist: {},
    analysisJob: { status: "idle" },
    analysis: metadata.id === 2 && cached ? cachedAnalysis : null,
    analyses: metadata.id === 2 && cached ? {
      ATTACH01: cachedAnalysis,
      ATTACH02: { ...cachedAnalysis, source: { attachmentKey: "ATTACH02" },
        overview: "Second PDF cached overview." },
    } : {},
  }]));
  const nativeContext = { embedded: true, itemID: 2, parentItemID: 2,
    attachmentID: 101, attachmentKey: "ATTACH01", tabID: "reader-tab-2", ...contextOverrides };
  const readers = new Map([["reader-tab-2", { itemID: 101, async navigate() {} }]]);
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
      Items: {
        get(id) { return parents.get(Number(id)) || attachments.get(Number(id)) || null; },
        getAll() { throw new Error("must not enumerate Zotero library"); },
      },
      Reader: { getByTabID(tabID) { return readers.get(tabID) || null; },
        getByItemID() { throw new Error("must not select a fallback reader"); },
        async open() { throw new Error("current view must not open a different Reader"); } },
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
    service: sharedService || service,
    version: "0.2.0",
  });
  context.ReadingRoomWindow.start({
    window: win,
    document,
    itemID: 2,
    nativeContext,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return {
    context,
    win,
    parents,
    attachments,
    readings,
    readers,
    nativeContext,
    switchContext(next) { return win.ReadingRoomWindow.updateContext(next); },
    document,
    timers,
    clearedTimers,
    controllers,
    service: sharedService || service,
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
      const open = button(document.body, "提示词设置");
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

test("prompt settings display, edit, save and reset through real UI events", async () => {
  const h = await fixture();
  let dialog = await h.openPrompt();
  const system = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "分析学术指令（可编辑）")[0];
  const synthesis = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "综合阶段指令（可编辑）")[0];
  const chat = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "论文对话学术指令（可编辑）")[0];
  const promptText = textOf(dialog);
  const analysisProtocol = descendants(dialog, node =>
    node.localName === "pre"
    && node.getAttribute("aria-label") === "固定分析应用输出协议")[0];
  const analysisEffective = descendants(dialog, node =>
    node.localName === "pre"
    && node.getAttribute("aria-label") === "有效完整分析系统提示词")[0];
  const chatProtocol = descendants(dialog, node =>
    node.localName === "pre"
    && node.getAttribute("aria-label") === "固定对话应用输出协议")[0];
  const chatEffective = descendants(dialog, node =>
    node.localName === "pre"
    && node.getAttribute("aria-label") === "有效完整对话系统提示词")[0];
  assert.equal(system.value, "Default complete system prompt.");
  assert.equal(synthesis.value, "Default synthesis instruction.");
  assert.equal(chat.value, "Default complete chat system prompt.");
  assert.match(promptText, /可编辑的学术指令 \+ 固定应用输出协议 = 实际发送内容/);
  assert.ok(analysisProtocol);
  assert.ok(analysisEffective);
  assert.ok(chatProtocol);
  assert.ok(chatEffective);
  assert.equal(analysisProtocol.textContent,
    "Analysis application output protocol v1: return validated JSON.");
  assert.equal(chatProtocol.textContent,
    "Chat application output protocol v1: return answer and evidence.");
  assert.equal(analysisEffective.textContent,
    "Default complete system prompt.\n\n"
      + "Analysis application output protocol v1: return validated JSON.");
  assert.equal(chatEffective.textContent,
    "Default complete chat system prompt.\n\n"
      + "Chat application output protocol v1: return answer and evidence.");
  assert.ok(promptText.includes("固定分析应用输出协议（只读 · 版本 1）"));
  assert.ok(promptText.includes("固定对话应用输出协议（只读 · 版本 1）"));
  system.value = "Custom full system prompt.\nKeep strict JSON.";
  system.dispatchEvent({ type: "input", target: system });
  synthesis.value = "Custom synthesis instruction.";
  synthesis.dispatchEvent({ type: "input", target: synthesis });
  chat.value = "Custom full chat system prompt.";
  chat.dispatchEvent({ type: "input", target: chat });
  assert.equal(analysisProtocol.textContent,
    "Analysis application output protocol v1: return validated JSON.");
  assert.equal(analysisEffective.textContent,
    "Default complete system prompt.\n\n"
      + "Analysis application output protocol v1: return validated JSON.");
  assert.equal(system.value,
    "Custom full system prompt.\nKeep strict JSON.");
  assert.ok(textOf(dialog).includes("Default synthesis instruction."));
  button(dialog, "保存提示词").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.service.promptSaves.at(-1), {
    systemPrompt: "Custom full system prompt.\nKeep strict JSON.",
    synthesisInstruction: "Custom synthesis instruction.",
    chatSystemPrompt: "Custom full chat system prompt.",
  });
  assert.equal(h.service.calls.some(call =>
    ["analyze", "askPaper", "listModels", "listConfiguredModels"]
      .includes(call.type)), false);
  assert.ok(textOf(h.document.body).includes(
    "分析、综合与对话三项提示词已保存"));

  dialog = await h.openPrompt();
  button(dialog, "恢复默认值").click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.promptResets.length, 1);
  assert.ok(textOf(h.document.body).includes(
    "分析、综合与对话三项提示词已恢复"));
  const restored = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "分析学术指令（可编辑）")[0];
  const restoredChat = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "论文对话学术指令（可编辑）")[0];
  assert.equal(restored.value, "Default complete system prompt.");
  assert.equal(restoredChat.value, "Default complete chat system prompt.");
});

test("chat-only customization is labeled without changing editable prompts", async () => {
  const h = await fixture();
  let dialog = await h.openPrompt();
  const chat = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "论文对话学术指令（可编辑）")[0];
  chat.value = "Chat-only academic instruction.";
  chat.dispatchEvent({ type: "input", target: chat });
  button(dialog, "保存提示词").click();
  await new Promise(resolve => setImmediate(resolve));
  dialog = await h.openPrompt();
  assert.ok(textOf(dialog).includes("当前使用自定义对话提示词"));
  assert.equal(textOf(dialog).includes("当前使用自定义分析提示词"), false);
  const analysis = descendants(dialog, node =>
    node.localName === "textarea"
    && node.getAttribute("aria-label") === "分析学术指令（可编辑）")[0];
  const analysisProtocol = descendants(dialog, node =>
    node.localName === "pre"
    && node.getAttribute("aria-label") === "固定分析应用输出协议")[0];
  assert.equal(analysis.value, "Default complete system prompt.");
  assert.equal(analysisProtocol.textContent,
    "Analysis application output protocol v1: return validated JSON.");
});

test("prompt settings tolerate missing contract fields from an older service", async () => {
  const h = await fixture({
    promptConfig: {
      systemPrompt: "Legacy analysis prompt.",
      synthesisInstruction: "Legacy synthesis prompt.",
      chatSystemPrompt: "Legacy chat prompt.",
      defaultSystemPrompt: "Legacy default analysis.",
      defaultSynthesisInstruction: "Legacy default synthesis.",
      defaultChatSystemPrompt: "Legacy default chat.",
      isCustom: false,
      isChatCustom: false,
      updatedAt: null,
    },
  });
  const dialog = await h.openPrompt();
  assert.ok(textOf(dialog).includes("固定分析应用输出协议（只读 · 版本 未提供）"));
  assert.ok(textOf(dialog).includes("固定对话应用输出协议（只读 · 版本 未提供）"));
  assert.ok(textOf(dialog).includes("当前服务未提供此只读内容。"));
});

test("prompt fields are sent by textContent without executing markup", async () => {
  const markup = "<img src=x onerror=alert(1)> protocol";
  const h = await fixture({
    promptConfig: {
      systemPrompt: "Analysis academic instruction.",
      synthesisInstruction: "Synthesis academic instruction.",
      chatSystemPrompt: "Chat academic instruction.",
      defaultSystemPrompt: "Default analysis.",
      defaultSynthesisInstruction: "Default synthesis.",
      defaultChatSystemPrompt: "Default chat.",
      analysisOutputContract: markup,
      chatOutputContract: markup,
      effectiveAnalysisSystemPrompt: markup,
      effectiveChatSystemPrompt: markup,
      outputContractVersion: "1",
      isCustom: false,
      isChatCustom: false,
      updatedAt: null,
    },
  });
  const dialog = await h.openPrompt();
  const protocol = descendants(dialog, node =>
    node.localName === "pre"
    && node.getAttribute("aria-label") === "固定分析应用输出协议")[0];
  assert.equal(protocol.textContent, markup);
  assert.equal(protocol.children.length, 0);
  assert.equal(source.includes("innerHTML"), false);
});

test("model failures show their task and safe code without raw transport details", async () => {
  const analysis = new Error(
    "Safe analysis message. endpoint=/secret/path raw-model-output reasoning");
  analysis.code = "MODEL_OUTPUT_TRUNCATED";
  const analysisView = await fixture({ failAnalysis: analysis });
  button(analysisView.document.body, "AI 分析").click();
  await new Promise(resolve => setImmediate(resolve));
  const analysisText = textOf(analysisView.document.body);
  assert.ok(analysisText.includes("分析失败 [MODEL_OUTPUT_TRUNCATED]"));
  assert.ok(analysisText.includes(
    "模型输出被长度限制截断；请提高模型输出上限或精简提示词后重试。"));
  assert.equal(analysisText.includes("endpoint=/secret/path"), false);
  assert.equal(analysisText.includes("raw-model-output"), false);

  const chat = new Error("Safe chat message.");
  chat.code = "CHAT_ANSWER_INVALID";
  const chatView = await fixture({ failChat: chat });
  questionInput(chatView).value = "Synthetic invalid answer";
  button(chatView.document.body, "发送").click();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  const chatText = textOf(chatView.document.body);
  assert.ok(chatText.includes("对话失败 [CHAT_ANSWER_INVALID]"));
  assert.ok(chatText.includes(
    "模型未返回有效的 answer 文本；请核对对话提示词及模型输出。"));
  assert.equal(chatText.includes("分析失败 [CHAT_ANSWER_INVALID]"), false);
});

test("persisted analysis errors keep their code and fixed task message", async () => {
  const h = await fixture();
  const originalDescribe = h.service.describe;
  h.service.describe = async item => {
    const description = await originalDescribe(item);
    description.state.analysisJob = {
      status: "error",
      code: "MODEL_OUTPUT_TRUNCATED",
      detail: "endpoint=/secret/path raw-model-output",
    };
    return description;
  };
  await h.switchContext({
    ...h.nativeContext,
    tabID: "reader-tab-2",
    attachmentID: 102,
    attachmentKey: "ATTACH02",
  });
  await new Promise(resolve => setImmediate(resolve));
  const text = textOf(h.document.body);
  assert.ok(text.includes("分析失败 [MODEL_OUTPUT_TRUNCATED]"));
  assert.ok(text.includes(
    "模型输出被长度限制截断；请提高模型输出上限或精简提示词后重试。"));
  assert.equal(text.includes("endpoint=/secret/path"), false);
  assert.equal(text.includes("raw-model-output"), false);
});

test("legacy persisted analysis errors omit a safe code instead of guessing", async () => {
  const h = await fixture();
  const originalDescribe = h.service.describe;
  h.service.describe = async item => {
    const description = await originalDescribe(item);
    description.state.analysisJob = {
      status: "error",
      detail: "endpoint=/secret/path raw-model-output",
    };
    return description;
  };
  await h.switchContext({
    ...h.nativeContext,
    tabID: "reader-tab-2",
    attachmentID: 102,
    attachmentKey: "ATTACH02",
  });
  await new Promise(resolve => setImmediate(resolve));
  const text = textOf(h.document.body);
  assert.ok(text.includes("分析失败 [ANALYSIS_FAILED]"));
  assert.ok(text.includes("分析未完成；此前的阅读状态与分析仍保留。"));
  assert.equal(text.includes("endpoint=/secret/path"), false);
  assert.equal(text.includes("raw-model-output"), false);
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
  const request = h.service.calls.find(call => call.type === "askPaper");
  assert.equal(request.item.id, 2);
  assert.equal(request.options.signal.aborted, true);
  assert.equal(h.service.calls.some(call => call.type === "cancelChat"), false);
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
  for (const removed of ["listLibraries", "listCollections", "listPapers", "loadCatalog",
    "analyzeBatch", "getBatchState", "fallbackReaderForContext", "beginAttachmentSwitch",
    "attachmentSelect", "batchUnavailable"]) assert.equal(source.includes(removed), false, removed);
});

const tick = () => new Promise(resolve => setImmediate(resolve));
function notesInput(h) {
  return descendants(h.document.body, node => node.localName === "textarea"
    && node.getAttribute("aria-label") !== "询问当前论文")[0];
}
function questionInput(h) {
  return descendants(h.document.body, node => node.localName === "textarea"
    && node.getAttribute("aria-label") === "询问当前论文")[0];
}
function gammaContext(h) {
  h.readers.set("reader-tab-3", { itemID: 301, async navigate() {} });
  return { ...h.nativeContext, itemID: 3, parentItemID: 3,
    attachmentID: 301, attachmentKey: "ATTACH03", tabID: "reader-tab-3" };
}
function secondPDFContext(h) {
  h.readers.set("reader-tab-2", { itemID: 102, async navigate() {} });
  return { ...h.nativeContext, attachmentID: 102, attachmentKey: "ATTACH02" };
}
function assertNoCatalog(h) {
  assert.equal(h.service.calls.some(call => ["listLibraries", "listCollections",
    "listPapers", "loadCatalog", "setFocused", "analyzeBatch", "getBatchState"].includes(call.type)), false);
}

test("mount reuses only the current PDF cache and renders no catalog or attachment chooser", async () => {
  const h = await fixture({ cached: true });
  const text = textOf(h.document.body);
  assert.ok(text.includes("Synthetic Beta"));
  assert.ok(text.includes("Synthetic PDF"));
  assert.ok(text.includes("Cached overview."));
  assert.equal(text.includes("Second PDF cached overview."), false);
  assert.equal(text.includes("Synthetic Alpha"), false);
  assert.equal(descendants(h.document.body, node => node.localName === "select"
    || node.localName === "nav" || node.localName === "input" && node.getAttribute("type") === "search"
    || /rr-(?:navigation|catalog|collections|focused|batch|search)/.test(node.getAttribute("class") || "")).length, 0);
  assert.equal(/关注此论文|批量分析|搜索文献|选择用于原文/.test(text), false);
  assert.equal(h.service.calls.some(call => ["analyze", "askPaper", "listModels", "listConfiguredModels"].includes(call.type)), false);
  assertNoCatalog(h);
});

test("status, notes, checklist, explicit notes, analysis and chat stay scoped without catalog enumeration", async () => {
  const h = await fixture({ cached: true });
  button(h.document.body, "已读").click();
  await tick();
  const notes = notesInput(h);
  notes.value = "current-parent notes";
  notes.dispatchEvent({ type: "input" });
  const checklist = descendants(h.document.body, node => node.localName === "input"
    && node.getAttribute("type") === "checkbox")[0];
  checklist.checked = true;
  checklist.dispatchEvent({ type: "change" });
  button(h.document.body, "保存为新的 Zotero 分析笔记").click();
  button(h.document.body, "同步阅读记录到个人库笔记").click();
  button(h.document.body, "AI 分析").click();
  await tick();
  questionInput(h).value = "What is current?";
  button(h.document.body, "发送").click();
  await tick();
  await h.switchContext(gammaContext(h));
  assert.ok(h.service.calls.some(call => call.type === "setState"
    && call.item.id === 2 && call.patch.notes === "current-parent notes" && call.patch.checklist.problem === true));
  for (const type of ["saveAnalysisNote", "syncStateNote", "analyze", "askPaper"]) {
    assert.equal(h.service.calls.find(call => call.type === type)?.item.id, 2, type);
  }
  assertNoCatalog(h);
});

test("the complete five-field context binds exactly the second PDF and its cached analysis", async () => {
  const h = await fixture({ cached: true });
  await h.switchContext(secondPDFContext(h));
  await tick();
  assert.ok(textOf(h.document.body).includes("Synthetic second PDF"));
  assert.ok(textOf(h.document.body).includes("Second PDF cached overview."));
  assert.equal(textOf(h.document.body).includes("Cached overview."), false);
  const readerCall = h.service.calls.filter(call => call.type === "getReaderAttachment").at(-1);
  assert.equal(readerCall.options.attachmentID, 102);
  assert.equal(readerCall.options.attachmentKey, "ATTACH02");
  button(h.document.body, "AI 分析").click();
  await tick();
  questionInput(h).value = "Second PDF question";
  button(h.document.body, "发送").click();
  await tick();
  for (const type of ["analyze", "askPaper", "getConversation"]) {
    assert.equal(h.service.calls.filter(call => call.type === type).at(-1).options.attachmentID, 102, type);
  }
  assertNoCatalog(h);
});

for (const field of ["itemID", "parentItemID", "attachmentID", "attachmentKey", "tabID"]) {
  test(`a missing ${field} refuses analysis and chat without falling back to the first PDF`, async () => {
    const h = await fixture({ contextOverrides: { [field]: undefined } });
    assert.equal(button(h.document.body, "AI 分析").disabled, true);
    assert.equal(button(h.document.body, "发送").disabled, true);
    button(h.document.body, "AI 分析").click();
    questionInput(h).value = "must refuse";
    button(h.document.body, "发送").click();
    await tick();
    assert.equal(h.service.calls.some(call => ["analyze", "askPaper", "getConversation", "getReaderAttachment"].includes(call.type)), false);
    assert.ok(textOf(h.document.body).includes("不可用") || textOf(h.document.body).includes("未匹配"));
    assertNoCatalog(h);
  });
}

for (const [name, contextOverrides] of [
  ["attachment key", { attachmentKey: "WRONGKEY" }],
  ["attachment ID", { attachmentID: 102 }],
  ["parent item", { parentItemID: 3 }],
  ["unknown tab", { tabID: "old-tab" }],
  ["numeric field type", { attachmentID: "101" }],
]) {
  test(`an incorrect ${name} refuses analysis and chat without a Reader fallback`, async () => {
    const h = await fixture({ contextOverrides });
    assert.equal(button(h.document.body, "AI 分析").disabled, true);
    assert.equal(button(h.document.body, "发送").disabled, true);
    button(h.document.body, "AI 分析").click();
    questionInput(h).value = "must refuse";
    button(h.document.body, "发送").click();
    await tick();
    assert.equal(h.service.calls.some(call => ["analyze", "askPaper", "getConversation", "getReaderAttachment"].includes(call.type)), false);
    assertNoCatalog(h);
  });
}

for (const [name, patch] of [
  ["library", { libraryID: 7 }],
  ["parent", { parentID: 3 }],
  ["key", { key: "WRONGKEY" }],
  ["ID", { id: 999 }],
  ["content type", { attachmentContentType: "text/html" }],
  ["deleted attachment", { deleted: true }],
]) {
  test(`the attachment's ${name} must match the current parent and context`, async () => {
    const h = await fixture();
    Object.assign(h.attachments.get(102), patch);
    await h.switchContext(secondPDFContext(h));
    assert.equal(button(h.document.body, "AI 分析").disabled, true);
    assert.equal(button(h.document.body, "发送").disabled, true);
    assert.equal(h.service.calls.filter(call => call.type === "getReaderAttachment").length, 1);
  });
}

test("a Reader identity change is revalidated when analysis, chat and source navigation are clicked", async () => {
  const h = await fixture();
  questionInput(h).value = "get sources";
  button(h.document.body, "发送").click();
  await tick();
  const before = h.service.calls.length;
  let navigations = 0;
  h.readers.set("reader-tab-2", { itemID: 102, async navigate() { navigations++; } });
  button(h.document.body, "AI 分析").click();
  questionInput(h).value = "must refuse after reader change";
  button(h.document.body, "发送").click();
  button(h.document.body, "“Synthetic source quote”").click();
  await tick();
  assert.equal(h.service.calls.slice(before).some(call => ["analyze", "askPaper"].includes(call.type)), false);
  assert.equal(navigations, 0);
});

test("an unchanged context and host selection preserve unsaved notes without rereading", async () => {
  const h = await fixture({ cached: true });
  const notes = notesInput(h);
  notes.value = "still dirty";
  notes.dispatchEvent({ type: "input" });
  await h.switchContext({ ...h.nativeContext, hostWindow: {} });
  await h.win.ReadingRoomWindow.selectItem(h.parents.get(2));
  assert.equal(notes.value, "still dirty");
  assert.equal(h.service.calls.filter(call => call.type === "describe").length, 1);
  assert.equal(h.service.calls.filter(call => call.type === "setState").length, 0);
});

test("switching current Zotero context flushes dirty notes before reading the new parent", async () => {
  const h = await fixture();
  const notes = notesInput(h);
  notes.value = "changed synthetic notes";
  notes.dispatchEvent({ type: "input" });
  await h.switchContext(gammaContext(h));
  const saveIndex = h.service.calls.findIndex(call => call.type === "setState"
    && call.item.id === 2 && call.patch.notes === "changed synthetic notes");
  const describeIndex = h.service.calls.findIndex(call => call.type === "describe" && call.item.id === 3);
  assert.ok(saveIndex >= 0 && saveIndex < describeIndex);
  assert.equal(notes.value, "Unsaved synthetic note");
  await h.switchContext(h.nativeContext);
  assert.equal(notes.value, "changed synthetic notes");
  assertNoCatalog(h);
});

test("switching PDFs of the same parent shares notes and checklist while keeping attachment caches separate", async () => {
  const h = await fixture({ cached: true });
  const notes = notesInput(h);
  notes.value = "shared parent notes";
  notes.dispatchEvent({ type: "input" });
  const checklist = descendants(h.document.body, node => node.localName === "input"
    && node.getAttribute("type") === "checkbox")[0];
  checklist.checked = true;
  checklist.dispatchEvent({ type: "change" });
  await h.switchContext(secondPDFContext(h));
  assert.equal(notes.value, "shared parent notes");
  assert.ok(textOf(h.document.body).includes("Second PDF cached overview."));
  assert.equal(h.readings.get(2).checklist.problem, true);
  h.readers.set("reader-tab-2", { itemID: 101, async navigate() {} });
  await h.switchContext(h.nativeContext);
  assert.equal(notes.value, "shared parent notes");
  assert.ok(textOf(h.document.body).includes("Cached overview."));
  assert.equal(textOf(h.document.body).includes("Second PDF cached overview."), false);
});

test("a failed context switch retains dirty notes and retries the save on the next host update", async () => {
  const h = await fixture();
  const notes = notesInput(h);
  notes.value = "keep this after a disk failure";
  notes.dispatchEvent({ type: "input" });
  const next = gammaContext(h);
  const original = h.service.setState;
  h.service.setState = async () => { throw new Error("synthetic disk failure"); };
  await h.switchContext(next);
  assert.equal(notes.value, "keep this after a disk failure");
  assert.equal(h.service.calls.filter(call => call.type === "describe").length, 1);
  assert.ok(textOf(h.document.body).includes("synthetic disk failure"));
  h.service.setState = original;
  await h.switchContext(next);
  assert.equal(h.readings.get(2).notes, "keep this after a disk failure");
  assert.equal(h.service.calls.filter(call => call.type === "describe").at(-1).item.id, 3);
});

test("changing context cancels only this view's owned signals and ignores late analysis and chat results", async () => {
  const h = await fixture({ cached: true });
  let finishAnalysis;
  let finishChat;
  let oldProgress;
  h.service.analyze = (item, options) => new Promise(resolve => {
    h.service.calls.push({ type: "analyze", item, options });
    oldProgress = options.onProgress;
    finishAnalysis = resolve;
  });
  h.service.askPaper = (item, question, options) => new Promise(resolve => {
    h.service.calls.push({ type: "askPaper", item, options });
    finishChat = resolve;
  });
  // A pending chat can coexist with an explicitly requested analysis.
  questionInput(h).value = "pending old question";
  button(h.document.body, "发送").click();
  button(h.document.body, "AI 分析").click();
  const oldAnalysis = h.service.calls.find(call => call.type === "analyze");
  const oldChat = h.service.calls.find(call => call.type === "askPaper");
  assert.ok(oldAnalysis && oldChat);
  await h.switchContext(secondPDFContext(h));
  assert.equal(oldAnalysis.options.signal.aborted, true);
  assert.equal(oldChat.options.signal.aborted, true);
  assert.equal(h.service.calls.some(call => ["cancelChat", "cancelAnalysis"].includes(call.type)), false);
  oldProgress({ status: "error", detail: "STALE PROGRESS" });
  finishAnalysis({ mode: "model", overview: "STALE ANALYSIS", dimensions: [] });
  finishChat({ messages: [{ role: "assistant", content: "STALE CHAT" }] });
  await tick();
  assert.equal(/STALE/.test(textOf(h.document.body)), false);
  assert.ok(textOf(h.document.body).includes("Second PDF cached overview."));
  assert.equal(button(h.document.body, "AI 分析").disabled, false);
});

test("newer context wins over an older delayed describe response", async () => {
  const h = await fixture();
  const original = h.service.describe;
  let release;
  let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  h.service.describe = async item => {
    if (item.id === 3) {
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return original(item);
  };
  const old = h.switchContext(gammaContext(h));
  await pending;
  const latest = h.switchContext(h.nativeContext);
  release();
  await Promise.all([old, latest]);
  assert.ok(textOf(h.document.body).includes("Synthetic Beta"));
  assert.equal(textOf(h.document.body).includes("Synthetic Gamma"), false);
  assert.equal(button(h.document.body, "发送").disabled, false);
});

test("disposal aborts only owned analysis signals and prevents late errors from touching the disposed view", async () => {
  const h = await fixture();
  let rejectAnalysis;
  h.service.analyze = (item, options) => new Promise((resolve, reject) => {
    h.service.calls.push({ type: "analyze", item, options });
    rejectAnalysis = reject;
  });
  button(h.document.body, "AI 分析").click();
  await h.win.ReadingRoomWindow.dispose();
  const request = h.service.calls.find(call => call.type === "analyze");
  assert.equal(request.options.signal.aborted, true);
  rejectAnalysis(new Error("late disposed failure"));
  await tick();
  assert.equal(textOf(h.document.body).includes("late disposed failure"), false);
  assert.equal(h.service.calls.some(call => call.type === "cancelAnalysis"), false);
});


test("two iframe runtimes sharing a service never cancel each other's same-parent chat", async () => {
  const first = await fixture();
  let release;
  first.service.askPaper = (item, question, options) => new Promise(resolve => {
    first.service.calls.push({ type: "askPaper", item, question, options });
    release = () => resolve({ messages: [] });
  });
  questionInput(first).value = "keep first view running";
  button(first.document.body, "发送").click();
  const request = first.service.calls.find(call => call.type === "askPaper");
  const second = await fixture({ sharedService: first.service });
  await second.switchContext(gammaContext(second));
  await second.win.ReadingRoomWindow.dispose();
  assert.equal(request.options.signal.aborted, false);
  assert.equal(button(first.document.body, "取消对话").disabled, false);
  await first.win.ReadingRoomWindow.dispose();
  assert.equal(request.options.signal.aborted, true);
  release();
  await tick();
  assert.equal(first.service.calls.some(call => ["cancelChat", "cancelAnalysis"].includes(call.type)), false);
});

test("a late status save from the previous parent cannot replace the current parent's state", async () => {
  const h = await fixture();
  let complete;
  h.service.setState = (item, patch) => new Promise(resolve => {
    h.service.calls.push({ type: "setState", item, patch });
    complete = () => resolve({ status: "read", notes: "old notes", checklist: {},
      tagSync: { status: "synced", tag: "阅读室/已读" } });
  });
  button(h.document.body, "已读").click();
  await h.switchContext(gammaContext(h));
  complete();
  await tick();
  assert.equal(notesInput(h).value, "Unsaved synthetic note");
  const active = descendants(h.document.body, node => node.getAttribute("data-status") === "unread"
    && node.classList.contains("active"))[0];
  assert.ok(active);
  assert.equal(textOf(h.document.body).includes("阅读状态已保存，并同步为原生标签"), false);
});
