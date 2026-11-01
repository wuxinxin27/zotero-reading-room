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
      disposed: 0,
      start() { this.started = true; },
      selectItem(item) { this.selected.push(item.id); },
      dispose() { this.disposed++; },
    },
    ReadingRoomUI: { startup() {} },
  };
}

function fixture() {
  const calls = {
    sections: [], destroyed: [], menus: [], columns: [],
    toolbars: [], opens: [], writes: [],
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
  const context = vm.createContext({
    console,
    setTimeout(callback) { return 1; },
    clearTimeout() {},
    Zotero: {
      getMainWindow() { return mainWindow; },
      getMainWindows() { return [mainWindow]; },
      debug() {},
      Items: {
        get(id) {
          if (Number(id) === 42) return item;
          if (Number(id) === 84) return attachment;
          return null;
        },
      },
      Reader: {
        registerEventListener(type, handler) {
          calls.toolbars.push({ type, handler });
        },
        unregisterEventListener() {},
        getByTabID() { return null; },
        async open(itemID, location, options) {
          calls.opens.push({ itemID, location, options });
          return {
            itemID,
            tabID: "reader-84",
            _window: mainWindow,
            async navigate(navigation) {
              calls.writes.push(navigation);
            },
          };
        },
      },
      MenuManager: {
        registerMenu(options) { calls.menus.push(options); },
        unregisterMenu() {},
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
        unregisterColumn() {},
      },
    },
  });
  vm.runInContext(source, context, { filename: "sidebar.js" });
  const service = {
    normalizeItem(value) { return value; },
    getState() { return { status: "reading" }; },
    async getReaderAttachment() { return attachment; },
  };
  const sidebar = new context.ReadingRoomNativeSidebar({
    service,
    rootURI: "file:///test/",
    cssURL: "file:///test/room.css",
    iconURL: "file:///test/icon.svg",
    version: "0.2.0",
  });
  return { context, sidebar, item, attachment, mainWindow, calls };
}

function sectionProps(doc, item, tabID, itemOverride) {
  const body = new Element(doc, "div");
  const details = new Element(doc, "item-details");
  details.tabID = tabID;
  details.dataset = { tabId: tabID };
  details.append(body);
  return {
    paneID: "reading-room-item-pane$actual",
    doc,
    body,
    details,
    item: itemOverride === undefined ? item : itemOverride,
    tabType: "reader",
    editable: true,
    setEnabled() {},
  };
}

test("section registration records actual pane ID and creates one contextual iframe per details view", async () => {
  const { sidebar, item, mainWindow, calls } = fixture();
  await sidebar.startup();
  assert.equal(calls.sections.length, 1);
  assert.equal(sidebar.paneID, "reading-room-item-pane$actual");
  assert.equal(calls.columns.length, 1);
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
  calls.sections[0].onAsyncRender(props);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frame.contentWindow.ReadingRoomWindow.selected.at(-1), 42);
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

test("missing reader context does not hide the pane permanently", async () => {
  const { sidebar, item, mainWindow } = fixture();
  await sidebar.startup();
  mainWindow.ZoteroContextPane = {
    collapsed: true,
    context: { mode: "library" },
    sidenav: { container: null },
  };
  const pending = sidebar.focusSection(item, null, mainWindow);
  assert.equal(mainWindow.ZoteroContextPane.collapsed, false);
  assert.equal(await Promise.race([
    pending,
    new Promise(resolve => setImmediate(() => resolve("still-waiting"))),
  ]), "still-waiting");
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
  frame.contentWindow = frameWindow({ embedded: true, itemID: 42, tabID: "reader-alpha" });
  section.onToggle({ ...props, event: { target: { open: true } } });
  await section.onAsyncRender(props);
  assert.equal(frame.contentWindow.ReadingRoomWindow.started, true);
  assert.notEqual(frame.getAttribute("src"), "about:blank");
});
