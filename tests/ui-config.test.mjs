import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../addon/content/room.js", import.meta.url), "utf8");

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
  }
  setAttribute(name, value) {
    const text = String(value);
    this.attributes.set(name, text);
    if (name === "class") {
      this.classList = new ClassList();
      for (const token of text.split(/\s+/).filter(Boolean)) this.classList.add(token);
    }
    if (name === "value") this.value = text;
    if (name === "checked") this.checked = true;
    if (name === "disabled") this.disabled = true;
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) {
    this.attributes.delete(name);
    if (name === "checked") this.checked = false;
    if (name === "disabled") this.disabled = false;
  }
  append(...nodes) {
    for (const node of nodes) {
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
    this.listeners.set(type, listeners.filter(entry => entry !== listener));
  }
  dispatchEvent(event) {
    event.target ||= this;
    for (const listener of [...(this.listeners.get(event.type) || [])]) listener(event);
    return true;
  }
  focus() { this.focused = true; this.dispatchEvent({ type: "focus", target: this }); }
  click() { this.dispatchEvent({ type: "click", target: this }); }
  setAttributeNS(_namespace, name, value) { this.setAttribute(name, value); }
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

async function fixture({ listModels } = {}) {
  const document = new Document();
  const timers = [];
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
  const selected = {
    id: 1, key: "PAPER001", libraryID: 1, deleted: false,
    isRegularItem() { return true; },
  };
  const win = {
    document, AbortController: FakeAbortController,
    setTimeout(callback) { timers.push(callback); return timers.length; },
    clearTimeout() {},
    addEventListener() {},
  };
  const service = {
    calls: [],
    normalizeItem(item) { return item || null; },
    async describe() {
      return {
        item: { title: "Synthetic", year: "2026", venue: "", creators: [], key: "PAPER001" },
        attachments: [], counts: { notes: 0, annotations: 0 },
        state: { status: "unread", notes: "", checklist: {}, analysisJob: { status: "idle" } },
      };
    },
    async getLibraryStats() {
      return { total: 1, byStatus: {}, byYear: {}, byType: {} };
    },
    async listModels(options) {
      this.calls.push(options);
      return listModels ? listModels(options) : { endpoint: "http://127.0.0.1:11434/v1/models", models: [
        { id: "synthetic-a", name: "Synthetic A" },
        { id: "synthetic-b", name: "Synthetic B" },
      ] };
    },
  };
  const context = vm.createContext({
    window: win, document, URL, AbortController: FakeAbortController,
    setTimeout: win.setTimeout, clearTimeout: win.clearTimeout,
    Zotero: {
      Libraries: { get() { return { libraryType: "user" }; } },
      getMainWindows() { return []; },
      getMainWindow() { return win; },
      Items: { get() { return selected; } },
      Libraries: { get() { return { libraryType: "user" }; }, userLibraryID: 1 },
      debug() {},
    },
    Services: {},
    ReadingRoomCore: {
      API_PROVIDERS: [
        { id: "openai", label: "OpenAI 兼容", defaultEndpoint: "http://127.0.0.1:11434/v1/chat/completions", endpointHint: "OpenAI hint" },
        { id: "anthropic", label: "Anthropic Messages", defaultEndpoint: "https://api.anthropic.com/v1", endpointHint: "Anthropic hint" },
        { id: "gemini", label: "Google Gemini", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", endpointHint: "Gemini hint" },
        { id: "ollama", label: "Ollama 原生", defaultEndpoint: "http://127.0.0.1:11434", endpointHint: "Ollama hint" },
      ],
    },
  });
  vm.runInContext(source, context, { filename: "room.js" });
  context.ReadingRoomUI.startup({
    rootURI: "file:///test/", cssURL: "file:///test/room.css", iconURL: "file:///test/icon.svg",
    service, version: "0.2.0",
  });
  context.ReadingRoomWindow.start({ window: win, document, itemID: 1 });
  await new Promise(resolve => setImmediate(resolve));
  const run = () => descendants(document.body, node => node.localName === "button" && node.textContent === "AI 分析…")[0];
  return {
    context, document, timers, controllers, service, run,
    async open() {
      run().click();
      await Promise.resolve();
      const dialog = descendants(document.body, node => node.getAttribute("role") === "dialog")[0];
      assert.ok(dialog);
      return dialog;
    },
  };
}

function fieldByText(dialog, text) {
  const field = descendants(dialog, node => node.localName === "label"
    && descendants(node, child => child.localName === "span" && child.textContent === text).length)[0];
  assert.ok(field, `missing field ${text}`);
  return field;
}

test("model discovery starts only after opening settings and is debounced", async () => {
  const h = await fixture();
  assert.equal(h.service.calls.length, 0, "startup and reading must not probe endpoints");
  const dialog = await h.open();
  assert.equal(h.service.calls.length, 0);
  assert.equal(h.timers.length, 1);
  assert.equal(descendants(dialog, node => node.localName === "select")[0].value, "openai");
  assert.equal(descendants(dialog, node => node.localName === "input" && node.getAttribute("type") === "url")[0].value,
    "http://127.0.0.1:11434/v1/chat/completions");
  h.timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.calls.length, 1);
  assert.equal(h.service.calls[0].provider, "openai");
  assert.equal(h.service.calls[0].allowRemote, false);
});

test("protocol choices come from the Core catalog and the initial OpenAI endpoint stays compatible", async () => {
  const h = await fixture();
  const dialog = await h.open();
  const select = descendants(dialog, node => node.localName === "select")[0];
  assert.deepEqual(select.children.map(option => option.textContent), [
    "OpenAI 兼容", "Anthropic Messages", "Google Gemini", "Ollama 原生",
  ]);
  assert.equal(select.value, "openai");
  assert.equal(descendants(dialog, node => node.localName === "input" && node.getAttribute("type") === "url")[0].value,
    "http://127.0.0.1:11434/v1/chat/completions");
});

test("endpoint edits cancel and ignore late model results", async () => {
  let release;
  const h = await fixture({ listModels: () => new Promise(resolve => { release = resolve; }) });
  const dialog = await h.open();
  h.timers.shift()();
  await Promise.resolve();
  assert.equal(h.service.calls.length, 1);
  assert.equal(h.controllers[0].signal.aborted, false);
  const endpoint = descendants(dialog, node => node.localName === "input" && node.getAttribute("type") === "url")[0];
  endpoint.value = "http://127.0.0.1:11434/v2";
  endpoint.dispatchEvent({ type: "input", target: endpoint });
  assert.equal(h.controllers[0].signal.aborted, true);
  release({ endpoint: "http://127.0.0.1:11434/v1/models", models: [{ id: "stale", name: "Stale" }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(descendants(dialog, node => node.localName === "button" && node.textContent === "Stale").length, 0);
  assert.equal(descendants(dialog, node => node.localName === "div" && /空模型|获取/.test(node.textContent)
    && /Stale/.test(node.textContent)).length, 0);
});

test("every close path resolves null and aborts discovery", async () => {
  let release;
  const h = await fixture({ listModels: () => new Promise(resolve => { release = resolve; }) });
  const dialog = await h.open();
  h.timers.shift()();
  await Promise.resolve();
  const close = descendants(dialog, node => node.localName === "button" && node.getAttribute("aria-label") === "关闭 AI 分析设置")[0];
  close.click();
  assert.equal(h.controllers[0].signal.aborted, true);
  assert.equal(descendants(h.document.body, node => node.getAttribute("role") === "dialog").length, 0);
  release({ endpoint: "http://127.0.0.1:11434/v1/models", models: [{ id: "late", name: "Late" }] });
  await new Promise(resolve => setImmediate(resolve));
});

test("backdrop and Escape use the same cleanup path", async () => {
  let release;
  const h = await fixture({ listModels: () => new Promise(resolve => { release = resolve; }) });
  let dialog = await h.open();
  h.timers.shift()();
  await Promise.resolve();
  const overlay = dialog.parentNode;
  overlay.dispatchEvent({ type: "click", target: overlay });
  assert.equal(h.controllers[0].signal.aborted, true);
  assert.equal(descendants(h.document.body, node => node.getAttribute("role") === "dialog").length, 0);
  release({ endpoint: "http://127.0.0.1:11434/v1/models", models: [{ id: "late", name: "Late" }] });
  await new Promise(resolve => setImmediate(resolve));

  dialog = await h.open();
  h.timers.shift()();
  await Promise.resolve();
  const overlayAgain = dialog.parentNode;
  overlayAgain.dispatchEvent({ type: "keydown", key: "Escape", target: dialog, preventDefault() {} });
  assert.equal(h.controllers[1].signal.aborted, true);
  assert.equal(descendants(h.document.body, node => node.getAttribute("role") === "dialog").length, 0);
  release({ endpoint: "http://127.0.0.1:11434/v1/models", models: [{ id: "late-2", name: "Late 2" }] });
  await new Promise(resolve => setImmediate(resolve));
});

test("changing provider clears the old list and key while model text stays editable", async () => {
  const h = await fixture();
  const dialog = await h.open();
  h.timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  const model = fieldByText(dialog, "模型（可搜索或手工输入）").children[1];
  assert.equal(descendants(dialog, node => node.localName === "button" && node.textContent === "Synthetic A").length, 1);
  const key = descendants(dialog, node => node.localName === "input" && node.getAttribute("type") === "password")[0];
  key.value = "synthetic-memory-key";
  model.value = "manual-model";
  model.dispatchEvent({ type: "input", target: model });
  assert.equal(model.value, "manual-model");
  const select = descendants(dialog, node => node.localName === "select")[0];
  select.value = "anthropic";
  // Native select changes the live value property, not its initial value attribute.
  assert.equal(select.getAttribute("value"), "openai");
  select.dispatchEvent({ type: "change", target: select });
  assert.equal(descendants(dialog, node => node.localName === "button" && node.textContent === "Synthetic A").length, 0);
  assert.equal(descendants(dialog, node => node.localName === "input" && node.getAttribute("type") === "url")[0].value,
    "https://api.anthropic.com/v1");
  assert.equal(key.value, "");
});

test("source keeps XML/XHTML creation and does not include hard-coded model suggestions", () => {
  assert.equal(source.includes("doc.createElement("), false);
  assert.equal(source.includes(".innerHTML"), false);
  for (const model of ["llama3.3", "qwen3", "mistral-small"]) assert.equal(source.includes(model), false);
  assert.match(source, /allowRemote,\s+signal: controller\.signal,\s+item,/s);
});

test("remote model discovery consent cannot authorize sending paper text", async () => {
  const h = await fixture();
  const dialog = await h.open();
  const endpoint = descendants(dialog, node => node.getAttribute("type") === "url")[0];
  endpoint.value = "https://first.example/v1";
  endpoint.dispatchEvent({ type: "input", target: endpoint });
  while (h.timers.length) h.timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.calls.length, 0);
  const discoveryConsent = descendants(dialog, node => node.localName === "input"
    && (node.getAttribute("aria-label") || "").includes("获取模型列表"))[0];
  assert.ok(discoveryConsent);
  discoveryConsent.checked = true;
  discoveryConsent.dispatchEvent({ type: "change", target: discoveryConsent });
  while (h.timers.length) h.timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.calls.length, 1);
  assert.equal(h.service.calls[0].allowRemote, true);
  const model = fieldByText(dialog, "模型（可搜索或手工输入）").children[1];
  model.value = "manual-model";
  descendants(dialog, node => node.localName === "button" && node.textContent === "开始 AI 分析")[0].click();
  assert.equal(descendants(h.document.body, node => node.getAttribute("role") === "dialog").length, 1);
  assert.ok(descendants(dialog, node => node.textContent.includes("远程正文分析必须勾选")).length);
  descendants(dialog, node => node.localName === "button" && node.textContent === "取消")[0].click();
});

test("changing remote host clears keys, both permissions, and old model choices", async () => {
  const h = await fixture({ listModels: async options => ({ endpoint: options.endpoint + "/models",
    models: [{ id: "host-a-model", name: "Host A model" }] }) });
  const dialog = await h.open();
  const endpoint = descendants(dialog, node => node.getAttribute("type") === "url")[0];
  const key = descendants(dialog, node => node.getAttribute("type") === "password")[0];
  endpoint.value = "https://first.example/v1";
  endpoint.dispatchEvent({ type: "input", target: endpoint });
  key.value = "synthetic-host-specific-key";
  key.dispatchEvent({ type: "input", target: key });
  const permissions = descendants(dialog, node => node.localName === "input" && node.getAttribute("type") === "checkbox");
  assert.equal(permissions.length, 2);
  for (const permission of permissions) {
    permission.checked = true;
    permission.dispatchEvent({ type: "change", target: permission });
  }
  while (h.timers.length) h.timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.service.calls.length, 1);
  assert.equal(h.service.calls[0].apiKey, "synthetic-host-specific-key");
  assert.equal(descendants(dialog, node => node.textContent === "Host A model").length, 1);
  endpoint.value = "https://second.example/v1";
  endpoint.dispatchEvent({ type: "input", target: endpoint });
  while (h.timers.length) h.timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(key.value, "");
  assert.ok(permissions.every(permission => !permission.checked));
  assert.equal(descendants(dialog, node => node.textContent === "Host A model").length, 0);
  assert.equal(h.service.calls.length, 1);
  descendants(dialog, node => node.localName === "button" && node.textContent === "取消")[0].click();
});
