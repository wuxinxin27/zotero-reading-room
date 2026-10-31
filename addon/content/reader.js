/* global ChromeUtils, Cu, IOUtils */
(function (scope) {
  "use strict";

  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const VIEWER_URL = "resource://zotero/reader/pdf/web/viewer.html?file=";
  const LOAD_TIMEOUT = 30000;
  const PAGE_RENDER_CACHE_LIMIT = 8;
  const VIEWER_CSS = `
    #toolbarContainer, #secondaryToolbar, #findbar, #sidebarContainer,
    #outerContainer > .doorHanger, #loadingBar, #printServiceOverlay {
      display: none !important;
    }
    #mainContainer, #viewerContainer {
      inset: 0 !important;
      width: 100% !important;
      height: 100% !important;
      top: 0 !important;
    }
    #viewerContainer {
      overflow: auto !important;
      background: #e9eeec !important;
    }
    .pdfViewer .page {
      border: 0 !important;
      box-shadow: 0 4px 18px rgba(20, 40, 35, .16) !important;
      margin-bottom: 14px !important;
    }
    .textLayer ::selection {
      background: rgba(15, 118, 110, .28) !important;
    }
  `;

  function cancelledError() {
    const error = new Error("PDF 阅读已取消。");
    error.code = "CANCELLED";
    return error;
  }

  function unavailableError(message) {
    const error = new Error(message);
    error.code = "PDF_EMBED_UNAVAILABLE";
    return error;
  }

  function resolveComponentsUtils(hostWindow) {
    if (scope.Cu) return scope.Cu;
    const Components = scope.Components || hostWindow && hostWindow.Components;
    return Components && Components.utils || null;
  }

  function resolveIOUtils(hostWindow) {
    if (scope.IOUtils) return scope.IOUtils;
    if (hostWindow && hostWindow.IOUtils) return hostWindow.IOUtils;
    try {
      const chrome = scope.ChromeUtils || hostWindow && hostWindow.ChromeUtils;
      return chrome && chrome.importESModule("resource://gre/modules/IOUtils.sys.mjs").IOUtils || null;
    }
    catch (_) {
      return null;
    }
  }

  function cloneInto(Cu, value, target) {
    if (!Cu || typeof Cu.cloneInto !== "function" || !target) return value;
    return Cu.cloneInto(value, target);
  }

  function waive(Cu, value) {
    if (!Cu || typeof Cu.waiveXrays !== "function") return value;
    try { return Cu.waiveXrays(value); }
    catch (_) { return value; }
  }

  function bounded(promise, hostWindow, timeout, failureMessage) {
    const setTimer = hostWindow && hostWindow.setTimeout
      ? hostWindow.setTimeout.bind(hostWindow)
      : scope.setTimeout;
    const clearTimer = hostWindow && hostWindow.clearTimeout
      ? hostWindow.clearTimeout.bind(hostWindow)
      : scope.clearTimeout;
    let timer = null;
    const interruption = new Promise((_, reject) => {
      if (!setTimer) return;
      timer = setTimer(() => reject(unavailableError(failureMessage)), timeout);
    });
    return Promise.race([Promise.resolve(promise), interruption])
      .finally(() => {
        if (timer != null && clearTimer) clearTimer(timer);
      });
  }

  function injectViewerStyle(viewerWindow) {
    const doc = viewerWindow && viewerWindow.document;
    if (!doc || !doc.documentElement) return;
    const old = doc.getElementById && doc.getElementById("reading-room-native-viewer-style");
    if (old) old.remove();
    const style = doc.createElementNS(XHTML_NS, "style");
    style.setAttribute("id", "reading-room-native-viewer-style");
    style.textContent = VIEWER_CSS;
    (doc.head || doc.documentElement).append(style);
  }

  function mount(options = {}) {
    const hostWindow = options.window || scope.window;
    const container = options.container;
    const attachment = options.attachment;
    if (!hostWindow || !container || !attachment) {
      throw unavailableError("PDF 阅读器缺少宿主窗口、容器或附件。");
    }
    if (!attachment.available || !attachment.path) {
      throw unavailableError("本地 PDF 文件不可用。");
    }
    const doc = container.ownerDocument || hostWindow.document;
    if (!doc || typeof doc.createElementNS !== "function") {
      throw unavailableError("宿主页面无法创建 PDF 阅读器。");
    }
    const Cu = resolveComponentsUtils(hostWindow);
    const io = resolveIOUtils(hostWindow);
    if (!Cu || !io || typeof io.read !== "function") {
      throw unavailableError("Zotero PDF.js 或本机文件接口不可用。");
    }

    const frame = doc.createElementNS(XHTML_NS, "iframe");
    frame.setAttribute("src", VIEWER_URL);
    frame.setAttribute("title", attachment.title || "论文原文");
    frame.setAttribute("class", "rr-native-pdf-frame");
    // No sandbox: Zotero's privileged PDF.js viewer needs its resource:// worker
    // and local PDF bytes. The iframe never receives a localhost URL or remote PDF.

    let destroyed = false;
    let generation = 0;
    let loaded = false;
    let viewerWindow = null;
    let app = null;
    let pageListener = null;
    let timer = null;
    let currentRenderTask = null;
    let renderQueue = Promise.resolve();
    const previewCache = new Map();
    let resolveReady;
    let rejectReady;
    let rejectWebViewerLoaded;
    let removeWebViewerLoadedListener = () => {};
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const webViewerLoaded = new Promise((resolve, reject) => {
      rejectWebViewerLoaded = reject;
      const listener = event => {
        if (destroyed) return;
        const detail = waive(Cu, event && event.detail);
        const sourceWindow = waive(Cu, frame.contentWindow);
        if (!detail || !sourceWindow || detail.source !== sourceWindow) return;
        const sourceApp = waive(Cu, sourceWindow.PDFViewerApplication);
        const optionsAPI = waive(Cu, sourceWindow.PDFViewerApplicationOptions);
        if (!sourceApp || !optionsAPI || typeof optionsAPI.setAll !== "function") return;
        try {
          optionsAPI.setAll(cloneInto(Cu, {
            defaultUrl: "",
            disablePreferences: true,
            disableHistory: true,
            historyUpdateUrl: false,
            textLayerMode: 1,
            annotationMode: 1,
            annotationEditorMode: -1,
            enableScripting: false,
            isEvalSupported: false,
            enableXfa: false,
            ignoreDestinationZoom: true,
            disableAutoFetch: true,
          }, sourceWindow));
        }
        catch (error) {
          reject(unavailableError("无法配置 Zotero PDF.js："
            + String(error && error.message || error)));
          return;
        }
        resolve({ sourceWindow, sourceApp });
      };
      // PDF.js dispatches a content-created CustomEvent into this chrome window.
      // Gecko chrome listeners must explicitly accept untrusted DOM events.
      hostWindow.addEventListener("webviewerloaded", listener, false, true);
      removeWebViewerLoadedListener = () => {
        hostWindow.removeEventListener("webviewerloaded", listener);
      };
    });

    const onPageChanged = event => {
      if (destroyed || typeof options.onNavigate !== "function") return;
      const eventValue = waive(Cu, event);
      const pageNumber = Number(eventValue && eventValue.pageNumber)
        || Number(app && app.pdfViewer && app.pdfViewer.currentPageNumber);
      if (Number.isInteger(pageNumber) && pageNumber > 0) {
        try { options.onNavigate({ pageIndex: pageNumber - 1, source: "viewer" }); }
        catch (_) {}
      }
    };

    async function initialize() {
      try {
        const timeout = new Promise((_, reject) => {
          const setTimer = hostWindow.setTimeout && hostWindow.setTimeout.bind(hostWindow);
          if (!setTimer) return;
          timer = setTimer(() => reject(unavailableError("Zotero PDF.js 加载超时。")), LOAD_TIMEOUT);
        });
        const loadedViewer = await Promise.race([webViewerLoaded, timeout]);
        removeWebViewerLoadedListener();
        if (timer != null) hostWindow.clearTimeout(timer);
        timer = null;
        if (destroyed) throw cancelledError();
        viewerWindow = loadedViewer.sourceWindow;
        app = loadedViewer.sourceApp;
        await bounded(app.initializedPromise, hostWindow, LOAD_TIMEOUT,
          "Zotero PDF.js 初始化超时。");
        if (destroyed) throw cancelledError();
        injectViewerStyle(viewerWindow);
        const root = viewerWindow.document && viewerWindow.document.documentElement;
        if (root) root.setAttribute("data-native-text-selection", "");
        const bytes = await io.read(attachment.path);
        if (destroyed) throw cancelledError();
        const payload = cloneInto(Cu, { data: bytes }, viewerWindow);
        await bounded(app.open(payload), hostWindow, LOAD_TIMEOUT,
          "PDF 文件打开超时。");
        if (destroyed) throw cancelledError();
        await bounded(app.pdfViewer.firstPagePromise, hostWindow, LOAD_TIMEOUT,
          "PDF 首页面加载超时。");
        if (destroyed) throw cancelledError();
        app.pdfViewer.currentScaleValue = "page-width";
        if (app.eventBus && typeof app.eventBus.on === "function") {
          pageListener = onPageChanged;
          app.eventBus.on("pagechanging", pageListener);
        }
        loaded = true;
        resolveReady(controller);
        return controller;
      }
      catch (error) {
        removeWebViewerLoadedListener();
        if (timer != null && hostWindow.clearTimeout) hostWindow.clearTimeout(timer);
        timer = null;
        rejectReady(error);
        throw error;
      }
    }

    const controller = {
      ready,
      attachment,
      frame,
      async navigate({ pageIndex, quote } = {}) {
        await ready;
        if (destroyed || !app) throw cancelledError();
        if (pageIndex != null) {
          if (!Number.isInteger(pageIndex) || pageIndex < 0) {
            throw unavailableError("PDF 页码无效。");
          }
          if (Number(app.pagesCount) > 0 && pageIndex >= Number(app.pagesCount)) {
            throw unavailableError("PDF 页码超出文档范围。");
          }
          if (app.pdfLinkService && typeof app.pdfLinkService.goToPage === "function") {
            app.pdfLinkService.goToPage(pageIndex + 1);
          }
        }
        const query = typeof quote === "string" ? quote.trim().slice(0, 4000) : "";
        if (query && app.eventBus && typeof app.eventBus.dispatch === "function") {
          app.eventBus.dispatch("find", cloneInto(Cu, {
            type: "",
            query,
            caseSensitive: false,
            entireWord: false,
            highlightAll: true,
            findPrevious: false,
            matchDiacritics: false,
          }, viewerWindow));
        }
        if (typeof options.onNavigate === "function") {
          try { options.onNavigate({ pageIndex: pageIndex == null ? null : pageIndex, source: "room" }); }
          catch (_) {}
        }
        return true;
      },
      async setZoom(value) {
        await ready;
        if (destroyed || !app || !app.pdfViewer) throw cancelledError();
        app.pdfViewer.currentScaleValue = String(value || "page-width");
      },
      previewPage({ pageIndex, width = 420 } = {}) {
        if (!Number.isInteger(pageIndex) || pageIndex < 0) {
          return Promise.reject(unavailableError("图表所在页无效。"));
        }
        const cacheKey = pageIndex + ":" + Math.round(Number(width) || 420);
        const job = renderQueue.then(async () => {
          await ready;
          if (destroyed || !app || !app.pdfDocument) throw cancelledError();
          if (previewCache.has(cacheKey)) {
            const cached = previewCache.get(cacheKey);
            previewCache.delete(cacheKey);
            previewCache.set(cacheKey, cached);
            return cached;
          }
          // Awaiting a content Promise restores Xray wrappers on its result.
          const page = waive(Cu, await app.pdfDocument.getPage(pageIndex + 1));
          if (destroyed) throw cancelledError();
          const p = new viewerWindow.Object();
          p.scale = 1;
          const base = page.getViewport(p);
          const targetWidth = Math.max(160, Math.min(520, Number(width) || 420));
          p.scale = Math.min(
            targetWidth / base.width,
            Math.sqrt(1000000 / (base.width * base.height)),
          );
          const viewport = page.getViewport(p);
          const canvas = viewerWindow.document.createElementNS(XHTML_NS, "canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const renderParameters = new viewerWindow.Object();
          renderParameters.canvas = canvas;
          renderParameters.canvasContext = canvas.getContext("2d", { alpha: false });
          renderParameters.viewport = viewport;
          currentRenderTask = page.render(renderParameters);
          try {
            await currentRenderTask.promise;
          }
          finally {
            currentRenderTask = null;
          }
          if (destroyed) throw cancelledError();
          const dataURL = canvas.toDataURL("image/png");
          canvas.width = 0;
          canvas.height = 0;
          previewCache.set(cacheKey, dataURL);
          while (previewCache.size > PAGE_RENDER_CACHE_LIMIT) {
            previewCache.delete(previewCache.keys().next().value);
          }
          return dataURL;
        });
        renderQueue = job.catch(() => {});
        return job;
      },
      async destroy() {
        if (destroyed) return;
        destroyed = true;
        generation++;
        removeWebViewerLoadedListener();
        if (timer != null && hostWindow.clearTimeout) hostWindow.clearTimeout(timer);
        timer = null;
        rejectWebViewerLoaded(cancelledError());
        rejectReady(cancelledError());
        if (currentRenderTask && typeof currentRenderTask.cancel === "function") {
          try { currentRenderTask.cancel(); } catch (_) {}
        }
        currentRenderTask = null;
        try { await renderQueue; } catch (_) {}
        if (app && app.eventBus && pageListener) {
          try { app.eventBus.off("pagechanging", pageListener); } catch (_) {}
        }
        pageListener = null;
        if (app && typeof app.close === "function") {
          try { await app.close(); } catch (_) {}
        }
        previewCache.clear();
        if (frame.parentNode) {
          if (typeof frame.parentNode.removeChild === "function") {
            frame.parentNode.removeChild(frame);
          }
          else if (typeof frame.remove === "function") {
            frame.remove();
          }
        }
        viewerWindow = null;
        app = null;
        loaded = false;
      },
      get pageCount() {
        return Number(app && app.pagesCount) || null;
      },
      get currentPageIndex() {
        const page = Number(app && app.pdfViewer && app.pdfViewer.currentPageNumber);
        return Number.isInteger(page) && page > 0 ? page - 1 : null;
      },
      get loaded() {
        return loaded && !destroyed;
      },
    };

    container.replaceChildren(frame);
    const initialized = initialize();
    ready.catch(() => {});
    controller.initialized = initialized;
    return controller;
  }

  scope.ReadingRoomPDF = Object.freeze({
    mount,
    VIEWER_URL,
    PAGE_RENDER_CACHE_LIMIT,
  });
})(this);
