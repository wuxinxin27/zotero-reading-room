/* global ChromeUtils, Services, Zotero */
(function (scope) {
  "use strict";

  const PLUGIN_ID = "zotero-reading-room@wuxinxin27.github.io";
  const PANE_ID = "reading-room-item-pane";
  const MENU_TOOLS = "reading-room-tools-open";
  const MENU_ITEM = "reading-room-item-open";
  const ROOM_URL = "chrome://reading-room/content/room.xhtml?embedded=1";

  function delay(window, milliseconds) {
    return new Promise(resolve => {
      const timer = window && typeof window.setTimeout === "function"
        ? window.setTimeout.bind(window) : setTimeout;
      timer(resolve, milliseconds);
    });
  }

  function closestDetails(node) {
    let current = node || null;
    while (current) {
      if (String(current.localName || "").toLowerCase() === "item-details") return current;
      current = current.parentNode || current.host || null;
    }
    return null;
  }

  function detailsTabID(details) {
    if (!details) return null;
    if (details.tabID) return String(details.tabID);
    if (details.dataset && details.dataset.tabId) return String(details.dataset.tabId);
    return details.getAttribute && details.getAttribute("tabid")
      || details.getAttribute && details.getAttribute("data-tab-id") || null;
  }

  function documentWindow(doc) {
    return doc && (doc.defaultView || doc.ownerDocument?.defaultView) || null;
  }

  function frameURL(context) {
    return ROOM_URL + ["tabID", "itemID", "parentItemID", "attachmentID", "attachmentKey"]
      .map(key => `&${key}=${encodeURIComponent(context[key])}`).join("");
  }

  class ReadingRoomNativeSidebar {
    constructor(options = {}) {
      this.service = options.service;
      this.core = options.core || null;
      this.pdf = options.pdf || null;
      this.dependencies = options.dependencies || {};
      this.scriptLoader = options.scriptLoader || null;
      this.rootURI = String(options.rootURI || "");
      this.iconURL = String(options.iconURL || "");
      this.version = String(options.version || "");
      this.cssURL = String(options.cssURL || "");
      this.started = false;
      this.paneID = null;
      this.views = new WeakMap();
      this.liveViews = new Set();
      this.frameOwners = new WeakMap();
      this.toolbarButtons = new Set();
    }

    async startup() {
      if (this.started) return this;
      this.started = true;
      this.registerMenus();
      this.registerSection();
      if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
        this.toolbarListener = event => this.renderToolbar(event);
        Zotero.Reader.registerEventListener("renderToolbar", this.toolbarListener, PLUGIN_ID);
      }
      // Hot reload keeps already-open reader DOM alive. Rebind our existing
      // buttons so their closures cannot keep a stopped sidebar controller.
      for (const reader of Array.from(Zotero.Reader?._readers || [])) {
        try {
          const doc = reader._iframeWindow?.document;
          for (const old of Array.from(doc?.getElementsByClassName("rr-reader-toolbar") || [])) {
            this.renderToolbar({ reader, doc, append: button => old.replaceWith(button) });
          }
        }
        catch (_) {}
      }
      for (const window of Zotero.getMainWindows ? Zotero.getMainWindows() : []) {
        this.onMainWindowLoad({ window });
      }
      return this;
    }

    registerMenus() {
      if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") return;
      Zotero.MenuManager.registerMenu({
        menuID: MENU_TOOLS,
        pluginID: PLUGIN_ID,
        target: "main/menubar/tools",
        menus: [{
          menuType: "menuitem",
          l10nID: "reading-room-menu-tools",
          icon: this.iconURL,
          onCommand: () => { void this.show({}); },
        }],
      });
      Zotero.MenuManager.registerMenu({
        menuID: MENU_ITEM,
        pluginID: PLUGIN_ID,
        target: "main/library/item",
        menus: [{
          menuType: "menuitem",
          l10nID: "reading-room-menu-item",
          icon: this.iconURL,
          onShowing(_event, context) {
            const item = context && Array.isArray(context.items) ? context.items.find(value => value && !value.deleted) : null;
            context.setEnabled?.(!!item);
          },
          onCommand: (_event, context) => {
            const item = context && Array.isArray(context.items) ? context.items.find(value => value && !value.deleted) : null;
            if (item) void this.show({ itemID: item.id });
          },
        }],
      });
    }

    registerSection() {
      if (!Zotero.ItemPaneManager || typeof Zotero.ItemPaneManager.registerSection !== "function") return;
      const registered = Zotero.ItemPaneManager.registerSection({
        paneID: PANE_ID,
        pluginID: PLUGIN_ID,
        header: { l10nID: "reading-room-pane", icon: this.iconURL },
        sidenav: { l10nID: "reading-room-pane-sidenav", icon: this.iconURL },
        onInit: props => this.ensureView(props),
        onRender: props => this.renderView(props),
        onAsyncRender: props => this.mountView(props),
        onItemChange: props => this.updateView(props),
        onDestroy: props => this.disposeView(props),
        onToggle: props => {
          const view = this.ensureView(props);
          if (!view) return;
          const section = props.body.closest?.("item-pane-custom-section");
          const open = props.event?.target?.open ?? section?.open;
          view.suspended = open === false;
          if (open !== false) void this.mountView(props);
          else if (view.frameWindow && view.frameWindow.ReadingRoomWindow
              && typeof view.frameWindow.ReadingRoomWindow.dispose === "function") {
            try { void view.frameWindow.ReadingRoomWindow.dispose(); } catch (_) {}
            view.started = null;
            // A disposed frame must reload before its fresh runtime is mounted.
            if (view.frame) view.frame.setAttribute("src", "about:blank");
          }
        },
      });
      if (registered) this.paneID = String(registered);
    }

    ensureView(props) {
      const body = props && props.body;
      if (!body) return null;
      let view = this.views.get(body);
      const context = this.viewContext(view || { body, doc: props.doc }, props);
      props.setEnabled?.(!!context);
      if (!context) {
        this.disposeView(props);
        return null;
      }
      if (view) return view;
      view = {
        body,
        frame: null,
        frameWindow: null,
        itemID: null,
        tabID: detailsTabID(closestDetails(body)),
        tabType: props.tabType || null,
        doc: props.doc,
        started: null,
        disposed: false,
      };
      this.views.set(body, view);
      this.liveViews.add(view);
      return view;
    }

    viewContext(view, props = {}) {
      if (!view || props.tabType !== "reader" || !props.item || props.item.deleted) return null;
      const details = closestDetails(props.body || view.body);
      const tabID = detailsTabID(details);
      if (!tabID) return null;
      let attachment;
      let parent;
      try {
        const reader = Zotero.Reader?.getByTabID(tabID);
        if (!reader || String(reader.tabID) !== tabID) return null;
        attachment = Zotero.Items.get(reader.itemID);
        if (!attachment || attachment.deleted || attachment.attachmentContentType !== "application/pdf"
            || attachment.id !== Number(reader.itemID) || !attachment.parentItemID
            || typeof attachment.key !== "string" || !attachment.key
            || (typeof attachment.isAttachment === "function" && !attachment.isAttachment())) return null;
        parent = Zotero.Items.get(attachment.parentItemID);
        if (!parent || parent.id !== Number(attachment.parentItemID) || parent.deleted || parent.parentItemID
            || (typeof parent.isRegularItem === "function" && !parent.isRegularItem())
            || parent.libraryID !== attachment.libraryID) return null;
        if (Number(props.item.id) !== Number(parent.id) && Number(props.item.id) !== Number(attachment.id)) return null;
      }
      catch (_) { return null; }
      const hostWindow = documentWindow(props.doc || view.doc) || Zotero.getMainWindow?.() || null;
      return {
        pluginID: PLUGIN_ID,
        itemID: parent.id,
        parentItemID: parent.id,
        attachmentID: attachment.id,
        attachmentKey: attachment.key,
        tabID,
        tabType: "reader",
        embedded: true,
        hostWindow,
        rootURI: this.rootURI,
        cssURL: this.cssURL,
        iconURL: this.iconURL,
        version: this.version,
      };
    }

    renderView(props) {
      const view = this.ensureView(props);
      if (!view || view.suspended || !props || !props.doc || !props.body) return;
      view.lastProps = props;
      const context = this.viewContext(view, props);
      if (!context) return;
      view.context = context;
      view.itemID = context.itemID;
      view.tabID = context.tabID;
      if (!view.frame) {
        const doc = props.doc;
        const frame = doc.createElementNS("http://www.w3.org/1999/xhtml", "iframe");
        frame.setAttribute("class", "rr-native-sidebar-frame");
        frame.setAttribute("title", "论文阅读室");
        frame.setAttribute("src", "about:blank");
        frame.style.width = "100%";
        frame.style.height = "calc(100vh - 180px)";
        frame.style.minHeight = "520px";
        frame.style.border = "0";
        frame.style.display = "block";
        frame.style.background = "transparent";
        props.body.replaceChildren(frame);
        frame.addEventListener("load", () => {
          if (view.disposed || view.suspended || !view.lastProps) return;
          if (view.mountedDocument !== frame.contentDocument) view.started = null;
          void this.mountView(view.lastProps);
        });
        view.frame = frame;
        view.frameWindow = frame.contentWindow || null;
        this.frameOwners.set(frame, view);
      }
      const nextURL = frameURL(context);
      if (view.frame.getAttribute("src") !== nextURL) {
        view.navigationGeneration = (view.navigationGeneration || 0) + 1;
        view.started = null;
        view.frame.setAttribute("src", nextURL);
      }
      const frameWindow = view.frame.contentWindow;
      if (!frameWindow) return;
      try {
        frameWindow.Zotero = Zotero;
        frameWindow.ReadingRoomNativeContext = Object.freeze({ ...context });
      }
      catch (_) {}
      view.frameWindow = frameWindow;
    }

    async mountView(props) {
      const view = this.ensureView(props);
      if (!view || view.suspended) return null;
      this.renderView(props);
      if (!view.frame) return null;
      if (view.started) return view.started;
      const generation = view.navigationGeneration;
      view.started = (async () => {
        const hostWindow = documentWindow(props.doc || view.doc) || Zotero.getMainWindow?.();
        for (let attempt = 0; attempt < 160 && !view.disposed && !view.suspended
            && view.navigationGeneration === generation; attempt++) {
          const frameWindow = view.frame && view.frame.contentWindow;
          if (frameWindow && frameWindow.document
              && frameWindow.location?.href !== "about:blank"
              && (!frameWindow.document.documentURI || frameWindow.document.documentURI === view.frame.getAttribute("src"))
              && ["interactive", "complete"].includes(frameWindow.document.readyState)) {
            try {
              const context = this.viewContext(view, props);
              if (!context) {
                this.disposeView(props);
                props.setEnabled?.(false);
                return null;
              }
              this.prepareFrameRuntime(view, frameWindow, props);
              if (frameWindow.ReadingRoomWindow
                  && typeof frameWindow.ReadingRoomWindow.start === "function") {
                frameWindow.ReadingRoomWindow.start({
                  window: frameWindow,
                  document: frameWindow.document,
                  itemID: context.itemID,
                  nativeContext: context,
                });
                view.mountedDocument = frameWindow.document;
                this.selectViewItem(view);
                return frameWindow;
              }
            }
            catch (error) {
              this.log(`frame runtime [${error && error.code || "ERROR"}]: ${error && error.message || error}`);
            }
          }
          await delay(hostWindow, 50);
        }
        return null;
      })();
      return view.started;
    }

    prepareFrameRuntime(view, frameWindow, props) {
      const context = this.viewContext(view, props);
      if (!context) throw new Error("当前 PDF 阅读上下文尚未就绪。");
      frameWindow.Zotero = frameWindow.Zotero || Zotero;
      frameWindow.ReadingRoomNativeContext = Object.freeze({ ...context });
      if (this.core) frameWindow.ReadingRoomCore = this.core;
      if (this.pdf) frameWindow.ReadingRoomPDF = this.pdf;
      for (const [name, value] of Object.entries(this.dependencies)) {
        if (value && !frameWindow[name]) {
          try { frameWindow[name] = value; } catch (_) {}
        }
      }
      if (!frameWindow.ReadingRoomUI || !frameWindow.ReadingRoomWindow) {
        if (!this.scriptLoader || !this.rootURI) {
          throw new Error("无法载入每标签页独立运行时。");
        }
        this.scriptLoader(
          `${this.rootURI}content/room.js`,
          frameWindow,
        );
      }
      if (!frameWindow.ReadingRoomUI || !frameWindow.ReadingRoomWindow) {
        throw new Error("运行时脚本未导出预期接口。");
      }
      frameWindow.ReadingRoomUI.startup({
        rootURI: this.rootURI,
        cssURL: this.cssURL,
        iconURL: this.iconURL,
        service: this.service,
        version: this.version,
        nativeContext: context,
        ownsHost: false,
      });
    }

    selectViewItem(view) {
      if (!view || view.disposed || !view.frame) return;
      const context = this.viewContext(view, view.lastProps);
      if (!context) return;
      const frameWindow = view.frame.contentWindow;
      const windowAPI = frameWindow && frameWindow.ReadingRoomWindow;
      if (windowAPI && typeof windowAPI.selectItem === "function") {
        try {
          const parent = Zotero.Items.get(context.parentItemID);
          if (parent) windowAPI.selectItem(parent);
        }
        catch (_) {}
      }
    }

    updateView(props) {
      const view = this.ensureView(props);
      if (!view) return;
      this.renderView(props);
      if (view.started) void view.started.then(() => this.selectViewItem(view));
      else void this.mountView(props);
    }

    disposeView(props) {
      const body = props && props.body;
      const view = body && this.views.get(body);
      if (!view || view.disposed) return;
      view.disposed = true;
      this.liveViews.delete(view);
      this.views.delete(body);
      const frameWindow = view.frame && view.frame.contentWindow;
      try {
        if (frameWindow && frameWindow.ReadingRoomWindow && typeof frameWindow.ReadingRoomWindow.dispose === "function") {
          frameWindow.ReadingRoomWindow.dispose();
        }
      }
      catch (_) {}
      try {
        if (view.frame && view.frame.parentNode) view.frame.parentNode.removeChild(view.frame);
      }
      catch (_) {}
      if (view.frame) this.frameOwners.delete(view.frame);
    }

    mountWindow(win, itemID, context) {
      if (!win) return null;
      let view = null;
      try {
        const doc = win.document;
        const frame = doc && doc.defaultView && doc.defaultView.frameElement;
        view = frame && this.frameOwners.get(frame);
      }
      catch (_) {}
      if (!view) view = [...this.liveViews].find(candidate => candidate.frame?.contentWindow === win);
      if (!view || view.disposed || view.suspended || view.frame?.contentWindow !== win) return false;
      const resolved = this.viewContext(view, view.lastProps);
      if (!resolved || (itemID != null && Number(itemID) !== resolved.itemID)) return false;
      for (const key of ["tabID", "itemID", "parentItemID", "attachmentID", "attachmentKey"]) {
        if (context?.[key] != null && String(context[key]) !== String(resolved[key])) return false;
      }
      const next = { ...(context || {}), ...resolved };
      view.context = next;
      view.itemID = next.itemID;
      view.tabID = next.tabID;
      win.ReadingRoomNativeContext = Object.freeze(next);
      const nextURL = frameURL(next);
      if (view.frame.getAttribute("src") !== nextURL) {
        view.navigationGeneration = (view.navigationGeneration || 0) + 1;
        view.frame.setAttribute("src", nextURL);
        view.started = null;
      }
      if (win.ReadingRoomUI && win.ReadingRoomWindow
          && typeof win.ReadingRoomWindow.start === "function" && !win.ReadingRoomWindow._started) {
        win.ReadingRoomWindow.start({
          window: win,
          document: win.document,
          itemID: next.itemID,
          nativeContext: next,
        });
      }
      return true;
    }

    async show(options = {}) {
      let reader = options.reader || null;
      if (!reader && !options.itemID) {
        const tabID = Zotero.getMainWindow()?.Zotero_Tabs?.selectedID;
        try { reader = tabID && Zotero.Reader?.getByTabID(tabID) || null; }
        catch (_) {}
      }
      let item = null;
      let selected = null;
      try {
        selected = reader
          ? Zotero.Items.get(reader.itemID)
          : Zotero.Items.get(Number(options.itemID));
        item = selected && this.service.normalizeItem(selected);
      }
      catch (_) {}
      if (!item && !options.itemID && !reader) {
        selected = this.selectedPaneItem(Zotero.getMainWindow());
        item = selected && this.service.normalizeItem(selected);
      }
      if (!item) return false;

      let hostWindow = reader && (reader._window || reader._iframeWindow?.top) || null;
      if (!reader) {
        try {
          const attachment = await this.service.getReaderAttachment(item,
            selected?.attachmentContentType === "application/pdf" ? { attachmentID: selected.id } : {});
          if (attachment && attachment.id) {
            reader = await Zotero.Reader.open(attachment.id, null, {
              openInWindow: false,
              allowDuplicate: false,
            });
          }
        }
        catch (error) {
          this.log(`open PDF [${error && error.code || "ERROR"}]: ${error && error.message || error}`);
        }
      }
      if (!reader || !reader.tabID) return false;
      hostWindow = reader && (reader._window || reader._iframeWindow?.top) || hostWindow || Zotero.getMainWindow();
      return this.focusSection(item, reader, hostWindow);
    }

    updateContext(reader) {
      if (!reader || !reader.tabID) return;
      const tabID = String(reader.tabID);
      for (const view of [...this.liveViews]) {
        if (String(view.tabID) !== tabID) continue;
        const context = this.viewContext(view, view.lastProps);
        if (!context) {
          view.lastProps?.setEnabled?.(false);
          this.disposeView({ body: view.body });
          continue;
        }
        view.context = context;
        if (view.frame && view.frame.contentWindow) {
          try {
            view.frame.contentWindow.ReadingRoomNativeContext = Object.freeze({ ...context });
            view.frame.contentWindow.ReadingRoomWindow?.updateContext?.(context);
          }
          catch (_) {}
        }
      }
    }

    selectedPaneItem(window) {
      try {
        const tabID = window && window.Zotero_Tabs && window.Zotero_Tabs.selectedID;
        const reader = tabID && Zotero.Reader && Zotero.Reader.getByTabID(tabID);
        const itemID = reader && reader.itemID;
        return itemID && Zotero.Items.get(itemID)
          || window && window.ZoteroPane && window.ZoteroPane.getSelectedItems?.()[0] || null;
      }
      catch (_) {
        return null;
      }
    }

    async focusSection(item, reader, hostWindow) {
      hostWindow = hostWindow || Zotero.getMainWindow();
      const targetTabID = reader && reader.tabID ? String(reader.tabID) : null;
      if (!targetTabID) return false;
      if (targetTabID && hostWindow && hostWindow.Zotero_Tabs && typeof hostWindow.Zotero_Tabs.select === "function") {
        try { hostWindow.Zotero_Tabs.select(targetTabID, true); }
        catch (_) {}
      }
      try {
        const cp = hostWindow && hostWindow.ZoteroContextPane;
        if (cp && cp.context) cp.context.mode = "item";
        if (cp) cp.collapsed = false;
      }
      catch (_) {}
      for (let attempt = 0; attempt < 160; attempt++) {
        const cp = hostWindow && hostWindow.ZoteroContextPane;
        const container = cp && cp.sidenav && cp.sidenav.container;
        if (cp && container) {
          try {
            cp.context.mode = "item";
            cp.collapsed = false;
          }
          catch (_) {}
          const details = detailsTabID(container) ? container
            : container.querySelector?.("item-details") || container;
          if (detailsTabID(details) === targetTabID) {
            try {
              const pane = details && typeof details.getEnabledPane === "function"
                ? details.getEnabledPane(this.paneID) : null;
              if (pane) pane.open = true;
              if (details && typeof details.scrollToPane === "function") {
                await details.scrollToPane(this.paneID, "instant");
              }
              return true;
            }
            catch (error) {
              this.log(`focus section: ${error && error.message || error}`);
            }
          }
        }
        await delay(hostWindow, 50);
      }
      return false;
    }

    renderToolbar(event) {
      const { reader, doc, append } = event || {};
      if (!reader || !doc || typeof append !== "function") return;
      const button = doc.createElementNS("http://www.w3.org/1999/xhtml", "button");
      button.setAttribute("type", "button");
      button.setAttribute("class", "toolbar-button rr-reader-toolbar");
      button.setAttribute("title", "打开论文阅读室侧栏");
      button.setAttribute("aria-label", "打开论文阅读室侧栏");
      // The PDF resource principal cannot load an extension's jar:file icon.
      button.textContent = "阅";
      button.addEventListener("click", () => {
        void (Zotero.ReadingRoom?.show ? Zotero.ReadingRoom.show({ reader }) : this.started && this.show({ reader }));
      });
      this.toolbarButtons.add(button);
      append(button);
    }

    onMainWindowLoad({ window }) {
      try {
        window.MozXULElement && window.MozXULElement.insertFTLIfNeeded
          && window.MozXULElement.insertFTLIfNeeded("reading-room.ftl");
      }
      catch (_) {}
    }

    async shutdown() {
      this.started = false;
      for (const view of [...this.liveViews]) {
        try { this.disposeView({ body: view.body }); }
        catch (_) {}
      }
      this.liveViews.clear();
      for (const button of this.toolbarButtons) {
        try { button.remove(); } catch (_) {}
      }
      this.toolbarButtons.clear();
      try {
        if (Zotero.Reader && typeof Zotero.Reader.unregisterEventListener === "function") {
          Zotero.Reader.unregisterEventListener("renderToolbar", this.toolbarListener, PLUGIN_ID);
        }
      }
      catch (_) {}
      try {
        if (this.paneID && Zotero.ItemPaneManager) Zotero.ItemPaneManager.unregisterSection(this.paneID);
      }
      catch (_) {}
      try {
        if (Zotero.MenuManager) {
          Zotero.MenuManager.unregisterMenu(MENU_TOOLS);
          Zotero.MenuManager.unregisterMenu(MENU_ITEM);
        }
      }
      catch (_) {}
      this.paneID = null;
      this.toolbarListener = null;
    }

    log(message) {
      try { Zotero.debug(`Reading Room native sidebar: ${String(message)}`); }
      catch (_) {}
    }
  }

  scope.ReadingRoomNativeSidebar = ReadingRoomNativeSidebar;
})(this);
