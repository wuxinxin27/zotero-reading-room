import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(
  new URL("../addon/content/sidebar.js", import.meta.url), "utf8",
);

class Element {
  constructor(doc, name) {
    this.ownerDocument = doc;
    this.localName = name;
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.innerText = "";
    this.textContent = "";
    this.style = {};
    this.listeners = new Map();
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === "src") this.src = String(value);
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(child) {
    const parent = this.parentNode;
    const index = parent?.children.indexOf(this);
    if (index >= 0) {
      parent.children[index] = child;
      child.parentNode = parent;
      this.parentNode = null;
    }
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  contains(node) {
    return node === this || this.children.some(child => child.contains?.(node));
  }
  querySelector() { return null; }
}

class Document {
  constructor() {
    this.documentElement = new Element(this, "html");
    this.defaultView = null;
  }
  createElementNS(_namespace, name) { return new Element(this, name); }
}

function frameWindow(context) {
  return {
    document: { readyState: "complete" },
    ReadingRoomNativeContext: context,
    ReadingRoomWindow: {
      started: false,
      selected: [],
      contexts: [],
      disposed: 0,
      start(options) { this.started = this._started = true; this.contexts.push(options.nativeContext); },
      updateContext(next) { this.contexts.push(next); },
      selectItem(item) { this.selected.push(item.id); },
      dispose() { this.disposed++; },
    },
    ReadingRoomUI: { startup() {} },
  };
}

function fixture() {
  const calls = {
    sections: [], destroyed: [], menus: [], columns: [],
    toolbars: [], opens: [], writes: [], attachmentRequests: [],
    enumerations: 0, columnDisposals: [], toolbarDisposals: [], menuDisposals: [],
  };
  const mainWindow = {
    document: new Document(),
    MozXULElement: { insertFTLIfNeeded() {} },
    ZoteroContextPane: null,
  };
  const item = { id: 42, libraryID: 1, key: "ITEM42", deleted: false };
  const attachment = {
    id: 84, key: "PDF84", libraryID: 1, parentItemID: 42,
    attachmentContentType: "application/pdf", deleted: false,
  };
  const otherItem = { ...item, id: 43, key: "ITEM43" };
  const otherAttachment = { ...attachment, id: 86, key: "PDF86", parentItemID: 43 };
  const siblingAttachment = { ...attachment, id: 85, key: "PDF85" };
  const items = new Map([item, attachment, otherItem, otherAttachment, siblingAttachment]
    .map(value => [value.id, value]));
  const readers = new Map([
    ["reader-alpha", { itemID: 84, tabID: "reader-alpha", _window: mainWindow }],
    ["reader-beta", { itemID: 86, tabID: "reader-beta", _window: mainWindow }],
    ["reader-sibling", { itemID: 85, tabID: "reader-sibling", _window: mainWindow }],
    ["reader-84", { itemID: 84, tabID: "reader-84", _window: mainWindow }],
  ]);
  const context = vm.createContext({
    console,
    setTimeout(callback) { return 1; },
    clearTimeout() {},
    Zotero: {
      getMainWindow() { return mainWindow; },
      getMainWindows() { return [mainWindow]; },
      debug() {},
      Items: {
        get(id) { return items.get(Number(id)) || null; },
        getAll() { calls.enumerations++; throw new Error("Library enumeration forbidden"); },
      },
      Reader: {
        registerEventListener(type, handler) {
          calls.toolbars.push({ type, handler });
        },
        unregisterEventListener(...args) { calls.toolbarDisposals.push(args); },
        getByTabID(tabID) { return readers.get(tabID) || null; },
        async open(itemID, location, options) {
          calls.opens.push({ itemID, location, options });
          const opened = {
            itemID,
            tabID: `reader-${itemID}`,
            _window: mainWindow,
            async navigate(navigation) {
              calls.writes.push(navigation);
            },
          };
          readers.set(opened.tabID, opened);
          return opened;
        },
      },
      MenuManager: {
        registerMenu(options) { calls.menus.push(options); },
        unregisterMenu(id) { calls.menuDisposals.push(id); },
      },
      ItemPaneManager: {
        registerSection(options) {
          calls.sections.push(options);
          return "reading-room-item-pane$actual";
        },
        unregisterSection(id) { calls.destroyed.push(id); },
      },
      ItemTreeManager: {
        registerColumn(options) {
          calls.columns.push(options);
          return "synthetic-column";
        },
        unregisterColumn(id) { calls.columnDisposals.push(id); },
      },
    },
  });
  vm.runInContext(source, context, { filename: "sidebar.js" });
  const service = {
    normalizeItem(value) { return value && (value.parentItemID ? items.get(value.parentItemID) : value); },
    getState() { throw new Error("Host must not read library status"); },
    async getReaderAttachment(parent, options) {
      calls.attachmentRequests.push({ itemID: parent.id, ...options });
      return options?.attachmentID ? items.get(options.attachmentID) : attachment;
    },
    listPapers() { calls.enumerations++; throw new Error("Library enumeration forbidden"); },
    listLibraries() { calls.enumerations++; throw new Error("Library enumeration forbidden"); },
  };
  const sidebar = new context.ReadingRoomNativeSidebar({
    service,
    rootURI: "file:///test/",
    cssURL: "file:///test/room.css",
    iconURL: "file:///test/icon.svg",
    version: "0.2.0",
  });
  return { context, sidebar, item, attachment, otherItem, siblingAttachment, items, readers, mainWindow, calls };
}

function sectionProps(doc, item, tabID, itemOverride) {
  const body = new Element(doc, "div");
  const details = new Element(doc, "item-details");
  details.tabID = tabID;
  details.dataset = { tabId: tabID };
  details.append(body);
  const enabled = [];
  return {
    paneID: "reading-room-item-pane$actual",
    doc,
    body,
    details,
    item: itemOverride === undefined ? item : itemOverride,
    tabType: "reader",
    editable: true,
    enabled,
    setEnabled(value) { enabled.push(value); },
  };
}

test("section registration records actual pane ID and creates one contextual iframe per details view", async () => {
  const { sidebar, item, mainWindow, calls } = fixture();
  await sidebar.startup();
  assert.equal(calls.sections.length, 1);
  assert.equal(sidebar.paneID, "reading-room-item-pane$actual");
  assert.equal(calls.columns.length, 0);
  assert.equal(calls.menus.length, 2);
  const doc = new Document();
  doc.defaultView = mainWindow;
  const props = sectionProps(doc, item, "reader-alpha");
  calls.sections[0].onInit(props);
  calls.sections[0].onRender(props);
  const frame = props.body.children[0];
  frame.contentWindow = frameWindow({
    embedded: true, itemID: item.id, tabID: "reader-alpha",
  });
  calls.sections[0].onRender(props);
  assert.equal(frame.localName, "iframe");
  assert.match(frame.getAttribute("src"), /room\.xhtml\?embedded=1/);
  assert.match(frame.getAttribute("src"), /tabID=reader-alpha/);
  assert.equal(frame.style.width, "100%");
  assert.equal(frame.style.height, "calc(100vh - 180px)");
  const nativeContext = frame.contentWindow.ReadingRoomNativeContext;
  assert.equal(nativeContext.itemID, 42);
  assert.equal(nativeContext.parentItemID, 42);
  assert.equal(nativeContext.attachmentID, 84);
  assert.equal(nativeContext.attachmentKey, "PDF84");
  assert.equal(nativeContext.tabID, "reader-alpha");
  assert.match(frame.getAttribute("src"), /attachmentID=84/);
  assert.equal(props.enabled.at(-1), true);
  calls.sections[0].onAsyncRender(props);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frame.contentWindow.ReadingRoomWindow.selected.at(-1), 42);
  assert.equal(calls.attachmentRequests.length, 0);
  assert.equal(calls.enumerations, 0);
  await sidebar.shutdown();
  assert.equal(calls.columnDisposals.length, 0);
});

test("two reader tabs keep distinct runtimes and disposing one leaves the other and service alive", async () => {
  const { sidebar, item, calls } = fixture();
  await sidebar.startup();
  const doc = new Document();
  const alpha = sectionProps(doc, item, "reader-alpha");
  const beta = sectionProps(doc, { ...item, id: 43, key: "ITEM43" }, "reader-beta");
  calls.sections[0].onInit(alpha);
  calls.sections[0].onRender(alpha);
  calls.sections[0].onInit(beta);
  calls.sections[0].onRender(beta);
  const alphaFrame = alpha.body.children[0];
  const betaFrame = beta.body.children[0];
  alphaFrame.contentWindow = frameWindow({
    embedded: true, itemID: 42, tabID: "reader-alpha",
  });
  betaFrame.contentWindow = frameWindow({
    embedded: true, itemID: 43, tabID: "reader-beta",
  });
  await calls.sections[0].onAsyncRender(alpha);
  await calls.sections[0].onAsyncRender(beta);
  assert.notEqual(alphaFrame.contentWindow, betaFrame.contentWindow);
  assert.equal(alphaFrame.contentWindow.ReadingRoomNativeContext.tabID, "reader-alpha");
  assert.equal(betaFrame.contentWindow.ReadingRoomNativeContext.tabID, "reader-beta");
  calls.sections[0].onDestroy(alpha);
  assert.equal(alphaFrame.contentWindow.ReadingRoomWindow.disposed, 1);
  assert.equal(betaFrame.contentWindow.ReadingRoomWindow.disposed, 0);
  assert.equal(alpha.body.children.length, 0);
  assert.equal(beta.body.children.length, 1);
  await sidebar.shutdown();
  assert.equal(betaFrame.contentWindow.ReadingRoomWindow.disposed, 1);
  assert.deepEqual(calls.destroyed, ["reading-room-item-pane$actual"]);
});

test("two PDFs under one parent bind by exact reader tab without choosing the first attachment", async () => {
  const { sidebar, item, calls } = fixture();
  await sidebar.startup();
  const section = calls.sections[0];
  const alpha = sectionProps(new Document(), item, "reader-alpha");
  const sibling = sectionProps(new Document(), item, "reader-sibling");
  section.onRender(alpha);
  section.onRender(sibling);
  for (const props of [alpha, sibling]) {
    const frame = props.body.children[0];
    frame.contentWindow = frameWindow();
    await section.onAsyncRender(props);
  }
  const alphaContext = alpha.body.children[0].contentWindow.ReadingRoomNativeContext;
  const siblingContext = sibling.body.children[0].contentWindow.ReadingRoomNativeContext;
  assert.equal(alphaContext.itemID, siblingContext.itemID);
  assert.equal(alphaContext.attachmentID, 84);
  assert.equal(siblingContext.attachmentID, 85);
  assert.equal(siblingContext.attachmentKey, "PDF85");
  assert.equal(calls.attachmentRequests.length, 0);
  assert.equal(calls.enumerations, 0);
});

test("library selection never mounts the reader section or reads the catalog", async () => {
  const { sidebar, item, calls } = fixture();
  await sidebar.startup();
  const props = { ...sectionProps(new Document(), item, "library"), tabType: "library" };
  const section = calls.sections[0];
  section.onInit(props);
  section.onItemChange(props);
  section.onRender(props);
  assert.equal(await section.onAsyncRender(props), null);
  assert.equal(props.enabled.at(-1), false);
  assert.equal(props.body.children.length, 0);
  assert.equal(sidebar.liveViews.size, 0);
  assert.equal(calls.columns.length, 0);
  assert.equal(calls.enumerations, 0);
  assert.equal(calls.attachmentRequests.length, 0);
});

test("invalid contexts fail closed and the later render retries a reader that was not ready", async () => {
  const { sidebar, item, calls, readers, items } = fixture();
  await sidebar.startup();
  const section = calls.sections[0];
  const missing = sectionProps(new Document(), item, "reader-late");
  section.onItemChange(missing);
  section.onRender(missing);
  assert.equal(missing.body.children.length, 0);
  assert.equal(missing.enabled.at(-1), false);
  readers.set("reader-late", { itemID: 85, tabID: "reader-late" });
  section.onRender(missing);
  assert.equal(missing.body.children.length, 1);
  assert.equal(missing.enabled.at(-1), true);
  const noTab = sectionProps(new Document(), item, null);
  const mismatch = sectionProps(new Document(), { ...item, id: 43 }, "reader-alpha");
  const wrongAttachment = sectionProps(new Document(), items.get(85), "reader-alpha");
  const wrongReader = sectionProps(new Document(), item, "reader-wrong");
  readers.set("reader-wrong", { itemID: 84, tabID: "reader-alpha" });
  const nonPDF = sectionProps(new Document(), item, "reader-epub");
  items.set(87, { ...items.get(84), id: 87, attachmentContentType: "application/epub+zip" });
  readers.set("reader-epub", { itemID: 87, tabID: "reader-epub" });
  const orphan = sectionProps(new Document(), item, "reader-orphan");
  items.set(88, { ...items.get(84), id: 88, parentItemID: 999 });
  readers.set("reader-orphan", { itemID: 88, tabID: "reader-orphan" });
  const crossLibrary = sectionProps(new Document(), item, "reader-cross");
  items.set(89, { ...items.get(84), id: 89, libraryID: 2 });
  readers.set("reader-cross", { itemID: 89, tabID: "reader-cross" });
  const absentItem = sectionProps(new Document(), item, "reader-alpha", null);
  for (const props of [noTab, mismatch, wrongAttachment, wrongReader, nonPDF, orphan, crossLibrary, absentItem]) {
    section.onInit(props);
    section.onRender(props);
    assert.equal(await section.onAsyncRender(props), null);
    assert.equal(props.enabled.at(-1), false);
    assert.equal(props.body.children.length, 0);
  }
  assert.equal(calls.attachmentRequests.length, 0);
  assert.equal(calls.enumerations, 0);
});

test("changing a mounted section to a library or mismatched item disposes it and a valid callback recovers", async () => {
  const { sidebar, item, calls } = fixture();
  await sidebar.startup();
  const section = calls.sections[0];
  const props = sectionProps(new Document(), item, "reader-alpha");
  section.onRender(props);
  const frame = props.body.children[0];
  frame.contentWindow = frameWindow();
  await section.onAsyncRender(props);
  section.onItemChange({ ...props, tabType: "library" });
  assert.equal(frame.contentWindow.ReadingRoomWindow.disposed, 1);
  assert.equal(props.body.children.length, 0);
  section.onRender(props);
  assert.equal(props.enabled.at(-1), true);
  assert.equal(props.body.children.length, 1);
  section.onItemChange({ ...props, item: { ...item, id: 43 } });
  assert.equal(props.body.children.length, 0);
});

test("mountWindow and updateContext preserve all current-PDF identity fields and reject stale overrides", async () => {
  const { sidebar, item, calls, readers } = fixture();
  await sidebar.startup();
  const section = calls.sections[0];
  const props = sectionProps(new Document(), item, "reader-sibling");
  section.onRender(props);
  const frame = props.body.children[0];
  const win = frame.contentWindow = frameWindow();
  assert.equal(sidebar.mountWindow(win, 42, { tabID: "reader-sibling" }), true);
  assert.equal(sidebar.mountWindow(win, 42, { attachmentID: 84 }), false);
  assert.equal(sidebar.mountWindow(win, 43, {}), false);
  assert.equal(sidebar.mountWindow(frameWindow(), 42, { tabID: "reader-sibling" }), false);
  sidebar.updateContext({ itemID: 84, tabID: "reader-sibling" });
  for (const context of [win.ReadingRoomNativeContext, ...win.ReadingRoomWindow.contexts]) {
    assert.equal(context.tabID, "reader-sibling");
    assert.equal(context.itemID, 42);
    assert.equal(context.parentItemID, 42);
    assert.equal(context.attachmentID, 85);
    assert.equal(context.attachmentKey, "PDF85");
  }
  readers.delete("reader-sibling");
  sidebar.updateContext({ itemID: 85, tabID: "reader-sibling" });
  assert.equal(props.body.children.length, 0);
  assert.equal(win.ReadingRoomWindow.disposed, 1);
});

test("toolbar and menu reveal native reader sidebar using the exact reader tab and section", async () => {
  const { sidebar, item, mainWindow, calls } = fixture();
  const pane = { open: false };
  const details = {
    tabID: "reader-84",
    dataset: { tabId: "reader-84" },
    getEnabledPane(id) {
      assert.equal(id, "reading-room-item-pane$actual");
      return pane;
    },
    async scrollToPane(id, behavior) {
      calls.writes.push({ scroll: id, behavior });
    },
  };
  mainWindow.ZoteroContextPane = {
    collapsed: true,
    context: { mode: "library" },
    sidenav: { container: details },
  };
  mainWindow.Zotero_Tabs = {
    selectedID: "reader-84",
    select(id) { calls.writes.push({ selected: id }); },
  };
  await sidebar.startup();
  const reader = {
    itemID: 84,
    tabID: "reader-84",
    _window: mainWindow,
  };
  assert.equal(await sidebar.show({ reader }), true);
  assert.equal(mainWindow.ZoteroContextPane.collapsed, false);
  assert.equal(mainWindow.ZoteroContextPane.context.mode, "item");
  assert.equal(pane.open, true);
  assert.deepEqual(calls.writes, [
    { selected: "reader-84" },
    { scroll: "reading-room-item-pane$actual", behavior: "instant" },
  ]);
  assert.equal(calls.opens.length, 0);

  await sidebar.show({ itemID: item.id });
  assert.equal(calls.opens.length, 1);
  assert.equal(calls.opens[0].itemID, 84);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.opens[0].options)), {
    openInWindow: false,
    allowDuplicate: false,
  });
});

test("Tools preserves the current reader PDF and the item menu can open exactly one selected PDF", async () => {
  const { sidebar, mainWindow, calls } = fixture();
  mainWindow.Zotero_Tabs = { selectedID: "reader-sibling" };
  await sidebar.startup();
  const focused = [];
  sidebar.focusSection = async (item, reader) => { focused.push({ itemID: item.id, reader }); return true; };
  calls.menus[0].menus[0].onCommand();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(focused.at(-1).reader.itemID, 85);
  assert.equal(calls.opens.length, 0);
  const menu = calls.menus[1].menus[0];
  menu.onCommand(null, { items: [{ id: 85 }, { id: 86 }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.opens.length, 1);
  assert.equal(calls.opens[0].itemID, 85);
  assert.deepEqual(calls.attachmentRequests, [{ itemID: 42, attachmentID: 85 }]);
  assert.equal(calls.enumerations, 0);
});

test("missing PDF never falls back to revealing a library pane", async () => {
  const { sidebar, item, mainWindow, calls } = fixture();
  await sidebar.startup();
  mainWindow.ZoteroContextPane = {
    collapsed: true,
    context: { mode: "library" },
    sidenav: { container: null },
  };
  sidebar.service.getReaderAttachment = async () => null;
  assert.equal(await sidebar.show({ itemID: item.id }), false);
  assert.equal(await sidebar.focusSection(item, null, mainWindow), false);
  assert.equal(mainWindow.ZoteroContextPane.collapsed, true);
  assert.equal(calls.opens.length, 0);
});

test("toolbar buttons resolve the live API and shutdown removes their injected DOM", async () => {
  const { sidebar, context } = fixture();
  await sidebar.startup();
  const doc = new Document();
  const toolbar = new Element(doc, "div");
  const reader = { itemID: 84, tabID: "reader-84" };
  const selected = [];
  context.Zotero.ReadingRoom = { show(options) { selected.push(options.reader); } };
  sidebar.renderToolbar({ reader, doc, append: button => toolbar.append(button) });
  toolbar.children[0].listeners.get("click")();
  assert.equal(selected[0], reader);
  await sidebar.shutdown();
  assert.equal(toolbar.children.length, 0);
});

test("hot reload rebinds existing reader buttons and shutdown unregisters only its own hooks", async () => {
  const { sidebar, context, calls, readers } = fixture();
  const doc = new Document();
  const toolbar = new Element(doc, "div");
  const stale = new Element(doc, "button");
  stale.setAttribute("class", "rr-reader-toolbar");
  toolbar.append(stale);
  doc.getElementsByClassName = name => name === "rr-reader-toolbar" ? toolbar.children : [];
  const reader = readers.get("reader-alpha");
  reader._iframeWindow = { document: doc };
  context.Zotero.Reader._readers = [reader];
  const shown = [];
  context.Zotero.ReadingRoom = { show(options) { shown.push(options.reader); } };
  await sidebar.startup();
  assert.equal(toolbar.children.length, 1);
  assert.notEqual(toolbar.children[0], stale);
  toolbar.children[0].listeners.get("click")();
  assert.equal(shown[0], reader);
  await sidebar.shutdown();
  assert.equal(toolbar.children.length, 0);
  assert.equal(calls.toolbarDisposals.length, 1);
  assert.equal(calls.toolbarDisposals[0][0], "renderToolbar");
  assert.deepEqual(calls.menuDisposals, ["reading-room-tools-open", "reading-room-item-open"]);
  assert.equal(calls.columnDisposals.length, 0);
});

test("an iframe navigation remounts its new document instead of retaining an old resolved mount", async () => {
  const { sidebar, item, calls } = fixture();
  await sidebar.startup();
  const props = sectionProps(new Document(), item, "reader-alpha");
  const section = calls.sections[0];
  section.onRender(props);
  const frame = props.body.children[0];
  frame.contentWindow = frameWindow({ embedded: true, itemID: 42, tabID: "reader-alpha" });
  await section.onAsyncRender(props);
  frame.contentWindow = frameWindow({ embedded: true, itemID: 42, tabID: "reader-alpha" });
  frame.contentDocument = frame.contentWindow.document;
  frame.listeners.get("load")();
  await section.onAsyncRender(props);
  assert.equal(frame.contentWindow.ReadingRoomWindow.started, true);
});

test("section Fluent messages localize attributes without replacing the live section body", async () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const ftl = await fs.readFile(new URL(
      `../addon/locale/${locale}/reading-room.ftl`, import.meta.url), "utf8");
    assert.match(ftl, /reading-room-pane =\r?\n\s+\.label = [^\r\n]+/);
    assert.match(ftl, /reading-room-pane-sidenav =\r?\n\s+\.tooltiptext = [^\r\n]+/);
    assert.doesNotMatch(ftl, /reading-room-pane(?:-sidenav)? = [^\r\n]+/);
  }
});

test("native toggle event closes its own runtime and permits a fresh mount", async () => {
  const { sidebar, item, calls } = fixture();
  await sidebar.startup();
  const props = sectionProps(new Document(), item, "reader-alpha");
  const section = calls.sections[0];
  section.onRender(props);
  const frame = props.body.children[0];
  frame.contentWindow = frameWindow({ embedded: true, itemID: 42, tabID: "reader-alpha" });
  await section.onAsyncRender(props);
  const prior = frame.contentWindow;
  section.onToggle({ ...props, event: { target: { open: false } } });
  assert.equal(prior.ReadingRoomWindow.disposed, 1);
  assert.equal(frame.getAttribute("src"), "about:blank");
  section.onRender(props);
  assert.equal(await section.onAsyncRender(props), null);
  assert.equal(frame.getAttribute("src"), "about:blank");
  frame.contentWindow = frameWindow({ embedded: true, itemID: 42, tabID: "reader-alpha" });
  section.onToggle({ ...props, event: { target: { open: true } } });
  await section.onAsyncRender(props);
  assert.equal(frame.contentWindow.ReadingRoomWindow.started, true);
  assert.notEqual(frame.getAttribute("src"), "about:blank");
});
