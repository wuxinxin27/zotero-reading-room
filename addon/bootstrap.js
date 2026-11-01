/* global ChromeUtils, IOUtils, PathUtils, Services, Zotero */
"use strict";

var ReadingRoomBootstrap = {
  data: null,
  service: null,
  sidebar: null,
  sharedScope: null,
  chromeHandle: null,
  stopped: false,

  log(message) {
    try {
      Zotero.debug("Reading Room: " + String(message));
    }
    catch (_) {}
  },

  safeError(error) {
    return {
      code: error && error.code ? String(error.code) : "STARTUP_FAILED",
      message: error && error.message ? String(error.message) : "插件初始化失败。",
    };
  },

  importGlobal(name, specifier) {
    try {
      if (this.sharedScope && this.sharedScope[name]) return this.sharedScope[name];
      const module = ChromeUtils.importESModule(specifier);
      return module && module[name] || null;
    }
    catch (_) {
      return null;
    }
  },

  prepareSharedScope(rootURI) {
    const scope = globalThis;
    scope.Cc = Components.classes;
    scope.Ci = Components.interfaces;
    scope.IOUtils = scope.IOUtils || this.importGlobal("IOUtils", "resource://gre/modules/IOUtils.sys.mjs");
    scope.PathUtils = scope.PathUtils || this.importGlobal("PathUtils", "resource://gre/modules/PathUtils.sys.mjs");

    const mainWindow = Zotero.getMainWindow && Zotero.getMainWindow();
    const Controller = scope.AbortController
      || (mainWindow && mainWindow.AbortController)
      || (Services.appShell && Services.appShell.hiddenDOMWindow
        && Services.appShell.hiddenDOMWindow.AbortController);
    if (Controller) scope.AbortController = Controller;
    if (!scope.setTimeout && mainWindow) scope.setTimeout = mainWindow.setTimeout.bind(mainWindow);
    if (!scope.clearTimeout && mainWindow) scope.clearTimeout = mainWindow.clearTimeout.bind(mainWindow);
    scope.ReadingRoomRootURI = rootURI;
    this.sharedScope = scope;
    return scope;
  },

  loadScript(scope, rootURI, name) {
    Services.scriptloader.loadSubScriptWithOptions(rootURI + "content/" + name, {
      target: scope,
      ignoreCache: true,
      allowUnsafeURL: true,
    });
  },

  async startup({ id, version, rootURI }) {
    if (this.service) return;
    this.stopped = false;
    this.data = { id, version, rootURI };

    try {
      await Zotero.initializationPromise;
      if (this.stopped) return;
      this.chromeHandle = Components.classes["@mozilla.org/addons/addon-manager-startup;1"]
        .getService(Components.interfaces.amIAddonManagerStartup)
        .registerChrome(Services.io.newURI(rootURI + "manifest.json"), [["content", "reading-room", "content/"]]);
      const scope = this.prepareSharedScope(rootURI);
      this.loadScript(scope, rootURI, "core.js");
      this.loadScript(scope, rootURI, "service.js");
      this.loadScript(scope, rootURI, "reader.js");
      this.loadScript(scope, rootURI, "room.js");
      this.loadScript(scope, rootURI, "sidebar.js");

      if (!scope.ReadingRoomCore || !scope.ReadingRoomService || !scope.ReadingRoomPDF
          || !scope.ReadingRoomUI || !scope.ReadingRoomNativeSidebar) {
        throw new Error("插件脚本未导出预期的共享接口。");
      }
      this.service = new scope.ReadingRoomService(Zotero, { rootURI });
      await this.service.init();
      if (this.stopped) {
        await this.shutdown();
        return;
      }

      const api = {
        service: this.service,
        show: options => this.sidebar
          ? this.sidebar.show(options || {}) : null,
        start: options => {
          return this.sidebar ? this.sidebar.show(options || {}) : null;
        },
        mountWindow: (win, itemID, context) => this.sidebar
          ? this.sidebar.mountWindow(win, itemID, context) : null,
        status: "ready",
        version,
        diagnostics: Object.freeze({
          itemPaneManager: !!Zotero.ItemPaneManager,
          itemTreeManager: !!Zotero.ItemTreeManager,
          menuManager: !!Zotero.MenuManager,
          readerToolbar: !!(Zotero.Reader && Zotero.Reader.registerEventListener),
          filePickerModule: true,
        }),
      };
      Zotero.ReadingRoom = api;
      scope.Zotero = Zotero;
      scope.ReadingRoomWindow = api;
      this.sidebar = new scope.ReadingRoomNativeSidebar({
        service: this.service,
        core: scope.ReadingRoomCore,
        pdf: scope.ReadingRoomPDF,
        dependencies: {
          ChromeUtils,
          IOUtils: scope.IOUtils,
          Services,
        },
        scriptLoader: (url, target) => this.loadScript(
          target, rootURI, "room.js"),
        rootURI,
        cssURL: rootURI + "content/room.css",
        iconURL: rootURI + "icon.svg",
        version,
      });
      scope.ReadingRoomNativeSidebarInstance = this.sidebar;
      await scope.ReadingRoomUI.startup({
        id,
        version,
        rootURI,
        service: this.service,
        cssURL: rootURI + "content/room.css",
        iconURL: rootURI + "icon.svg",
        ownsHost: false,
      });
      await this.sidebar.startup();
      this.log("startup complete; version " + version);
    }
    catch (error) {
      const safe = this.safeError(error);
      await this.shutdown();
      try {
        Zotero.ReadingRoom = {
          status: "error",
          error: safe,
          show: () => {
            throw new Error(safe.code + ": " + safe.message);
          },
        };
      }
      catch (_) {}
      this.log("startup failed [" + safe.code + "]: " + safe.message);
    }
  },

  onMainWindowLoad({ window }) {
    try {
      this.sharedScope && this.sharedScope.ReadingRoomUI
        && this.sharedScope.ReadingRoomUI.onMainWindowLoad({ window });
    }
    catch (error) {
      const safe = this.safeError(error);
      this.log("main window hook failed [" + safe.code + "]: " + safe.message);
    }
  },

  onMainWindowUnload({ window }) {
    try {
      this.sharedScope && this.sharedScope.ReadingRoomUI
        && this.sharedScope.ReadingRoomUI.onMainWindowUnload({ window });
    }
    catch (error) {
      const safe = this.safeError(error);
      this.log("main window unload hook failed [" + safe.code + "]: " + safe.message);
    }
  },

  async shutdown() {
    this.stopped = true;
    const scope = this.sharedScope;
    const mainWindows = Zotero.getMainWindows ? Zotero.getMainWindows()
      : [Zotero.getMainWindow && Zotero.getMainWindow()];
    for (const mainWindow of mainWindows) {
      if (!mainWindow || !mainWindow.document) continue;
      try {
        for (const link of mainWindow.document.querySelectorAll(
          'link[href*="locale/reading-room.ftl"]',
        )) link.remove();
      }
      catch (_) {}
    }
    try {
      if (this.sidebar) await this.sidebar.shutdown();
    }
    catch (error) {
      const safe = this.safeError(error);
      this.log("native sidebar shutdown failed [" + safe.code + "]: " + safe.message);
    }
    try {
      if (scope && scope.ReadingRoomUI) await scope.ReadingRoomUI.shutdown();
    }
    catch (error) {
      const safe = this.safeError(error);
      this.log("UI shutdown failed [" + safe.code + "]: " + safe.message);
    }
    try {
      if (this.service) await this.service.shutdown();
    }
    catch (error) {
      const safe = this.safeError(error);
      this.log("service shutdown failed [" + safe.code + "]: " + safe.message);
    }
    try {
      delete Zotero.ReadingRoom;
    }
    catch (_) {}
    if (scope) {
      try { delete scope.ReadingRoomCore; } catch (_) {}
      try { delete scope.ReadingRoomService; } catch (_) {}
      try { delete scope.ReadingRoomUI; } catch (_) {}
      try { delete scope.ReadingRoomPDF; } catch (_) {}
      try { delete scope.ReadingRoomWindow; } catch (_) {}
      try { delete scope.ReadingRoomNativeSidebar; } catch (_) {}
      try { delete scope.ReadingRoomNativeSidebarInstance; } catch (_) {}
      try { delete scope.ReadingRoomRootURI; } catch (_) {}
    }
    this.service = null;
    this.sidebar = null;
    if (this.chromeHandle) {
      try { this.chromeHandle.destruct(); }
      catch (error) {
        const safe = this.safeError(error);
        this.log("chrome cleanup failed [" + safe.code + "]: " + safe.message);
      }
      this.chromeHandle = null;
    }
    this.sharedScope = null;
    this.data = null;
    this.log("shutdown complete");
  },

  install() {},
  uninstall() {},
};

function startup(params, reason) {
  return ReadingRoomBootstrap.startup(params, reason);
}

function shutdown(params, reason) {
  return ReadingRoomBootstrap.shutdown(params, reason);
}

function install(params, reason) {
  return ReadingRoomBootstrap.install(params, reason);
}

function uninstall(params, reason) {
  return ReadingRoomBootstrap.uninstall(params, reason);
}

function onMainWindowLoad(params) {
  ReadingRoomBootstrap.onMainWindowLoad(params);
}

function onMainWindowUnload(params) {
  ReadingRoomBootstrap.onMainWindowUnload(params);
}
