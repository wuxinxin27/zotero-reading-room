import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(
  new URL("../addon/content/reader.js", import.meta.url),
  "utf8",
);

class Element {
  constructor(doc, name) {
    this.ownerDocument = doc;
    this.localName = name;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  append(...nodes) {
    for (const node of nodes) {
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
}

class Document {
  constructor() {
    this.documentElement = new Element(this, "html");
    this.head = new Element(this, "head");
    this.body = new Element(this, "body");
    this.documentElement.append(this.head, this.body);
  }
  createElementNS(_namespace, name) {
    const element = new Element(this, name);
    if (name === "canvas") {
      element.width = 1;
      element.height = 1;
      element.context = { fillStyle: "" };
      element.getContext = () => element.context;
      element.toDataURL = () => `data:image/png;synthetic-${element.width}`;
    }
    return element;
  }
  getElementById(id) {
    const visit = root => {
      for (const child of root.children) {
        if (child.attributes.get("id") === id) return child;
        const found = visit(child);
        if (found) return found;
      }
      return null;
    };
    return visit(this.documentElement);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const hostDocument = new Document();
  const viewerDocument = new Document();
  const container = hostDocument.createElementNS("x", "div");
  const listeners = new Map();
  const timers = [];
  const cleared = [];
  const reads = [];
  const setAllCalls = [];
  const dispatched = [];
  const eventListeners = new Map();
  let closeCalled = false;
  let firstPageResolve;
  const firstPagePromise = new Promise(resolve => {
    firstPageResolve = resolve;
  });
  const renderTask = deferred();
  const pages = {
    1: {
      getViewport({ scale }) {
        return { width: 600 * scale, height: 800 * scale };
      },
      render() {
        return {
          promise: renderTask.promise,
          cancel() { renderTask.reject(Object.assign(
            new Error("cancelled"), { name: "RenderingCancelledException" },
          )); },
        };
      },
    },
  };
  // Simulate an awaited content Promise returning an Xray-wrapped page.
  const wrappedPage = {};
  const application = {
    initializedPromise: Promise.resolve(),
    firstPagePromise,
    pagesCount: 1,
    pdfViewer: {
      firstPagePromise,
      currentScaleValue: "",
      currentPageNumber: 1,
    },
    pdfDocument: {
      async getPage(number) {
        assert.equal(number, 1);
        return wrappedPage;
      },
    },
    pdfLinkService: {
      goToPage(page) { dispatched.push({ type: "page", page }); },
    },
    eventBus: {
      on(type, listener) { eventListeners.set(type, listener); },
      off(type, listener) {
        assert.equal(eventListeners.get(type), listener);
        eventListeners.delete(type);
      },
      dispatch(type, detail) { dispatched.push({ type, detail }); },
    },
    async open(payload) {
      assert.equal(payload.data.byteLength, 4);
      firstPageResolve();
    },
    async close() { closeCalled = true; },
  };
  const viewerWindow = {
    document: viewerDocument,
    Object,
    PDFViewerApplication: application,
    PDFViewerApplicationOptions: {
      setAll(values) { setAllCalls.push(values); },
    },
  };
  const hostWindow = {
    document: hostDocument,
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout(id) { cleared.push(id); },
    addEventListener(type, listener, capture, wantsUntrusted) {
      if (type === "webviewerloaded") {
        assert.equal(capture, false);
        assert.equal(wantsUntrusted, true, "chrome listener must accept PDF.js content events");
      }
      const values = listeners.get(type) || [];
      values.push(listener);
      listeners.set(type, values);
    },
    removeEventListener(type, listener) {
      listeners.set(type,
        (listeners.get(type) || []).filter(entry => entry !== listener));
    },
  };
  const Cu = {
    waiveXrays(value) { return value === wrappedPage ? pages[1] : value; },
    cloneInto(value) { return value; },
  };
  const context = vm.createContext({
    window: hostWindow,
    document: hostDocument,
    setTimeout: hostWindow.setTimeout,
    clearTimeout: hostWindow.clearTimeout,
    Cu,
    IOUtils: {
      async read(path) {
        reads.push(path);
        return new Uint8Array([1, 2, 3, 4]);
      },
    },
  });
  vm.runInContext(source, context, { filename: "reader.js" });
  const controller = context.ReadingRoomPDF.mount({
    window: hostWindow,
    container,
    attachment: {
      id: 1,
      key: "ATTACH01",
      title: "Synthetic",
      path: "/synthetic/paper.pdf",
      available: true,
      contentType: "application/pdf",
    },
  });
  const frame = container.children[0];
  assert.equal(frame.localName, "iframe");
  frame.contentWindow = viewerWindow;
  const webviewerLoaded = listeners.get("webviewerloaded")[0];
  webviewerLoaded({ detail: { source: viewerWindow } });
  await controller.initialized;
  return {
    controller,
    frame,
    viewerWindow,
    application,
    setAllCalls,
    dispatched,
    eventListeners,
    reads,
    renderTask,
    get closeCalled() { return closeCalled; },
  };
}

test("mount configures PDF.js before loading local bytes", async () => {
  const h = await fixture();
  assert.equal(h.frame.attributes.get("src"),
    "resource://zotero/reader/pdf/web/viewer.html?file=");
  assert.equal(h.frame.attributes.has("sandbox"), false);
  assert.equal(h.reads[0], "/synthetic/paper.pdf");
  assert.equal(h.setAllCalls.length, 1);
  const options = h.setAllCalls[0];
  assert.equal(options.defaultUrl, "");
  assert.equal(options.textLayerMode, 1);
  assert.equal(options.annotationMode, 1);
  assert.equal(options.annotationEditorMode, -1);
  assert.equal(options.enableScripting, false);
  assert.equal(options.isEvalSupported, false);
  assert.equal(options.disableAutoFetch, true);
  assert.equal(h.application.pdfViewer.currentScaleValue, "page-width");
  assert.equal(h.eventListeners.has("pagechanging"), true);
});

test("navigate uses physical pages and find contract without guessing", async () => {
  const h = await fixture();
  await h.controller.navigate({ pageIndex: 0, quote: "verified quote" });
  assert.deepEqual(h.dispatched[0], { type: "page", page: 1 });
  assert.equal(h.dispatched[1].type, "find");
  assert.deepEqual({ ...h.dispatched[1].detail }, {
    type: "",
    query: "verified quote",
    caseSensitive: false,
    entireWord: false,
    highlightAll: true,
    findPrevious: false,
    matchDiacritics: false,
  });
  const before = h.dispatched.length;
  await h.controller.navigate({ quote: "" });
  assert.equal(h.dispatched.length, before);
  await assert.rejects(h.controller.navigate({ pageIndex: 1 }), /超出文档范围/);
  assert.equal(h.dispatched.length, before);
});

test("page preview is lazy, serialized, cached, and bounded", async () => {
  const h = await fixture();
  const pending = h.controller.previewPage({ pageIndex: 0 });
  await Promise.resolve();
  h.renderTask.resolve();
  const first = await pending;
  assert.match(first, /^data:image\/png;/);
  const second = await h.controller.previewPage({ pageIndex: 0 });
  assert.equal(second, first);
  assert.equal(h.controller.pageCount, 1);
});

test("destroy removes find/page listeners, closes app, then removes frame", async () => {
  const h = await fixture();
  assert.equal(h.frame.parentNode.localName, "div");
  await h.controller.destroy();
  assert.equal(h.eventListeners.has("pagechanging"), false);
  assert.equal(h.closeCalled, true);
  assert.equal(h.frame.parentNode, null);
});

test("unavailable local attachment never creates a viewer iframe", () => {
  const hostDocument = new Document();
  const hostWindow = {
    document: hostDocument,
    addEventListener() {},
    removeEventListener() {},
  };
  const context = vm.createContext({
    window: hostWindow,
    document: hostDocument,
    Cu: { waiveXrays: value => value, cloneInto: value => value },
    IOUtils: { async read() { return new Uint8Array(); } },
  });
  vm.runInContext(source, context, { filename: "reader.js" });
  assert.throws(() => context.ReadingRoomPDF.mount({
    window: hostWindow,
    container: hostDocument.createElementNS("x", "div"),
    attachment: {
      key: "MISSING1",
      available: false,
      path: null,
    },
  }), /本地 PDF 文件不可用/);
});
