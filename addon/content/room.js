/* global Cc, Ci, ChromeUtils, IOUtils, PathUtils, Services, Zotero */
(function (scope) {
  "use strict";

  const PLUGIN_ID = "zotero-reading-room@wuxinxin27.github.io";
  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const PANE_ID = "reading-room-item-pane";
  const COLUMN_KEY = "reading-room-status";
  const WINDOW_TYPE = "zotero:reading-room";
  const MENU_TOOLS = "reading-room-tools-open";
  const MENU_ITEM = "reading-room-item-open";
  const STATUS_LABELS = Object.freeze({
    unread: "未读",
    to_read: "待读",
    reading: "在读",
    read: "已读",
    parked: "搁置",
  });
  const CHECKLIST = Object.freeze([
    ["problem", "确认研究问题与范围"],
    ["evidence", "核对关键证据与页码"],
    ["method", "理解方法与技术机制"],
    ["comparison", "比较基线、优势与边界"],
    ["notes", "整理可复用的阅读笔记"],
  ]);
  const DIMENSION_IDS = Object.freeze([
    "problem", "novelty", "contributions",
    "prior-work", "superiority", "technical-uniqueness",
  ]);
  const DEFAULT_PROVIDER = "openai";
  const OPENAI_LEGACY_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
  const MODEL_DISCOVERY_DELAY = 700;
  // Core.API_PROVIDERS is authoritative. This fallback keeps the UI usable while
  // an older service bundle is present; it contains provider metadata, never model IDs.
  const FALLBACK_API_PROVIDERS = Object.freeze([
    { id: "openai", label: "OpenAI 兼容 API", defaultEndpoint: OPENAI_LEGACY_ENDPOINT, endpointHint: "可填写 base URL，或旧的完整 chat completions 地址。" },
    { id: "anthropic", label: "Anthropic Messages API", defaultEndpoint: "https://api.anthropic.com/v1", endpointHint: "填写 Anthropic API base URL；密钥仅用于本次会话。" },
    { id: "gemini", label: "Google Gemini API", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", endpointHint: "填写 Gemini API base URL；密钥仅用于本次会话。" },
    { id: "ollama", label: "Ollama API", defaultEndpoint: "http://127.0.0.1:11434", endpointHint: "填写本机 Ollama API 地址。" },
  ]);

  let state = null;
  let activeJob = null;
  let noteTimer = null;
  let checklistTimer = null;
  let aiConfigSession = null;
  let dialogSequence = 0;
  let loadGeneration = 0;
  let itemPaneID = null;
  let columnKey = null;
  let started = false;
  const mainWindow = scope.window;
  const mainDocument = scope.document;

  function documentNode(doc, name) {
    return doc && typeof doc.getElementsByTagNameNS === "function"
      ? doc.getElementsByTagNameNS(XHTML_NS, name)[0] || null
      : null;
  }

  function documentBody(doc) {
    return documentNode(doc, "body");
  }

  function documentHead(doc) {
    return documentNode(doc, "head");
  }

  function setClass(element, className) {
    element.setAttribute("class", className || "");
  }

  function setHidden(element, hidden) {
    if (hidden) element.setAttribute("hidden", "hidden");
    else element.removeAttribute("hidden");
  }

  function setBooleanAttribute(element, name, value) {
    if (value) element.setAttribute(name, name);
    else element.removeAttribute(name);
    if (typeof element[name] === "boolean") element[name] = !!value;
  }

  function setValue(element, value) {
    const text = String(value == null ? "" : value);
    element.setAttribute("value", text);
    if (typeof element.value === "string") element.value = text;
  }

  function getValue(element) {
    return typeof element.value === "string"
      ? element.value
      : element.getAttribute("value") || "";
  }

  function setChecked(element, checked) {
    setBooleanAttribute(element, "checked", checked);
  }

  function getChecked(element) {
    return typeof element.checked === "boolean"
      ? element.checked
      : element.hasAttribute("checked");
  }

  function make(tag, className, text) {
    const element = (state && state.document || mainDocument).createElementNS(XHTML_NS, tag);
    if (className) setClass(element, className);
    if (text != null) element.textContent = String(text);
    return element;
  }

  function safeError(error) {
    return {
      code: error && error.code ? String(error.code) : "UI_ERROR",
      message: error && error.message ? String(error.message) : "操作未完成。",
    };
  }

  function logError(where, error) {
    const safe = safeError(error);
    try {
      Zotero.debug(`Reading Room: ${where} [${safe.code}]: ${safe.message}`);
    }
    catch (_) {}
  }

  function formatDate(value) {
    if (!value) return "尚未保存";
    try {
      return new Intl.DateTimeFormat("zh-CN", {
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit",
      }).format(new Date(value));
    }
    catch (_) {
      return String(value);
    }
  }

  function percent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number * 100))) : 0;
  }

  function checkedCount(checklist) {
    return CHECKLIST.reduce((total, [id]) => total + (checklist && checklist[id] ? 1 : 0), 0);
  }

  function setStatus(element, message, kind) {
    if (!element) return;
    element.textContent = message || "";
    setClass(element, "rr-message " + (kind || ""));
    element.setAttribute("role", kind === "error" ? "alert" : "status");
    element.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
    setHidden(element, !message);
  }

  function getProviderCatalog() {
    const Core = scope.ReadingRoomCore;
    const source = Core && Array.isArray(Core.API_PROVIDERS) && Core.API_PROVIDERS.length
      ? Core.API_PROVIDERS
      : FALLBACK_API_PROVIDERS;
    const providers = [];
    const seen = new Set();
    for (const provider of source) {
      const id = provider && String(provider.id || "").trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      providers.push({
        id,
        label: String(provider.label || id),
        defaultEndpoint: String(provider.defaultEndpoint || ""),
        endpointHint: String(provider.endpointHint || ""),
      });
    }
    return providers.length ? providers : FALLBACK_API_PROVIDERS.map(provider => ({ ...provider }));
  }

  function isLoopbackHost(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host === "localhost" || host === "[::1]" || host === "127.0.0.1";
  }

  function isGroupLibrary(item) {
    try {
      const library = item && Zotero.Libraries && Zotero.Libraries.get(item.libraryID);
      return !!library && library.libraryType !== "user";
    }
    catch (_) {
      return false;
    }
  }

  function endpointContext(input) {
    let endpoint;
    try {
      endpoint = new URL(String(input || "").trim());
    }
    catch (_) {
      return { ok: false, error: "端点不是有效的 HTTP(S) 地址。" };
    }
    if (!["http:", "https:"].includes(endpoint.protocol)
        || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      return { ok: false, error: "端点仅允许无内嵌凭据、查询参数和片段的 HTTP(S) 地址。" };
    }
    const local = isLoopbackHost(endpoint.hostname);
    if (!local && endpoint.protocol !== "https:") {
      return { ok: false, local, origin: endpoint.origin, error: "远程端点必须使用 HTTPS。" };
    }
    return { ok: true, local, origin: endpoint.origin, url: endpoint };
  }

  function modelDiscoveryFailure(error) {
    const code = String(error && error.code || "");
    const status = Number(error && (error.status || error.statusCode));
    if (code === "MODELS_UNSUPPORTED") {
      return "当前协议或端点未提供模型列表接口；请手工填写模型名称。";
    }
    if (code === "MODELS_TIMEOUT") {
      return "自动获取模型列表超时；请检查服务，或手工填写模型名称。";
    }
    if ([401, 403].includes(status)
        || /(?:AUTH|UNAUTHORIZED|FORBIDDEN|API_KEY)/i.test(code)
        || /\b(?:401|403)\b|鉴权|认证|密钥|unauthori[sz]ed|forbidden/i.test(String(error && error.message || ""))) {
      return "模型列表鉴权失败；请检查 API 密钥，或手工填写模型名称。";
    }
    const message = error && error.message ? String(error.message) : "未知错误";
    return `自动获取模型列表失败：${message}。可手工填写模型名称。`;
  }

  function newWindow() {
    const win = Services.ww.openWindow(
      null,
      "chrome://reading-room/content/room.xhtml",
      "zotero-reading-room-window",
      "chrome,centerscreen,resizable,dialog=no,width=1120,height=820",
      null,
    );
    if (!win) throw new Error("无法创建论文阅读室窗口。");
    return win;
  }

  function existingWindow() {
    return Services.wm.getMostRecentWindow(WINDOW_TYPE);
  }

  function show(options = {}) {
    const win = existingWindow();
    if (win) {
      try { win.focus(); } catch (_) {}
      if (options.itemID) {
        try { win.ReadingRoomWindow.selectItem(Zotero.Items.get(Number(options.itemID))); }
        catch (error) { logError("focus requested item", error); }
      }
      return win;
    }
    try {
      const created = newWindow();
      mountWindow(created, options.itemID);
      return created;
    }
    catch (error) {
      logError("open window", error);
      const mainWindow = Zotero.getMainWindow();
      if (mainWindow && Services.prompt) {
        Services.prompt.alert(mainWindow, "论文阅读室", safeError(error).message);
      }
      return null;
    }
  }

  function mountWindow(win, itemID) {
    if (win.ReadingRoomWindow && win.ReadingRoomWindow._started) {
      if (itemID) {
        try { win.ReadingRoomWindow.selectItem(Zotero.Items.get(Number(itemID))); }
        catch (error) { logError("select requested item", error); }
      }
      return;
    }
    let attempts = 0;
    const attach = () => {
      if (win.closed) return;
      const doc = win.document;
      if (!doc || !doc.documentElement || doc.documentURI === "about:blank"
          || !["interactive", "complete"].includes(doc.readyState)) {
        if (++attempts < 80) setTimeout(attach, 50);
        return;
      }
      if (win.ReadingRoomWindow && win.ReadingRoomWindow._started) {
        if (itemID) {
          try { win.ReadingRoomWindow.selectItem(Zotero.Items.get(Number(itemID))); }
          catch (error) { logError("select requested item", error); }
        }
        return;
      }
      start({ window: win, document: doc, itemID });
    };
    attach();
  }

  function selectedItemFromContext(context) {
    const items = context && Array.isArray(context.items) ? context.items : [];
    return items.find(item => item && !item.deleted) || null;
  }

  function selectedPaneItem(window) {
    try {
      const tabID = window.Zotero_Tabs && window.Zotero_Tabs.selectedID;
      const reader = tabID && Zotero.Reader && Zotero.Reader.getByTabID(tabID);
      if (reader && reader.itemID) return Zotero.Items.get(reader.itemID);
      return window.ZoteroPane && window.ZoteroPane.getSelectedItems()[0] || null;
    }
    catch (_) {
      return null;
    }
  }

  function registerMenus() {
    if (!Zotero.MenuManager || typeof Zotero.MenuManager.registerMenu !== "function") return;
    Zotero.MenuManager.registerMenu({
      menuID: MENU_TOOLS,
      pluginID: PLUGIN_ID,
      target: "main/menubar/tools",
      menus: [{
        menuType: "menuitem",
        l10nID: "reading-room-menu-tools",
        icon: state.iconURL,
        onCommand() {
          show({});
        },
      }],
    });
    Zotero.MenuManager.registerMenu({
      menuID: MENU_ITEM,
      pluginID: PLUGIN_ID,
      target: "main/library/item",
      menus: [{
        menuType: "menuitem",
        l10nID: "reading-room-menu-item",
        icon: state.iconURL,
        onShowing(_event, context) {
          context.setEnabled(!!selectedItemFromContext(context));
        },
        onCommand(_event, context) {
          const item = selectedItemFromContext(context);
          if (item) show({ itemID: item.id });
        },
      }],
    });
  }

  function summaryForItem(item) {
    try {
      const parent = state.service.normalizeItem(item);
      if (!parent) return "";
      return STATUS_LABELS[state.service.getState(parent).status] || "未读";
    }
    catch (_) {
      return "";
    }
  }

  function registerItemPane() {
    if (!Zotero.ItemPaneManager || typeof Zotero.ItemPaneManager.registerSection !== "function") return;
      itemPaneID = Zotero.ItemPaneManager.registerSection({
      paneID: PANE_ID,
      pluginID: PLUGIN_ID,
      header: {
        l10nID: "reading-room-pane",
        icon: state.iconURL,
      },
      sidenav: {
        l10nID: "reading-room-pane-sidenav",
        icon: state.iconURL,
      },
      onItemChange({ item, setEnabled }) {
        setEnabled(!!state.service.normalizeItem(item));
      },
      onRender({ doc, body, item }) {
        body.replaceChildren();
        const panel = doc.createElementNS(XHTML_NS, "div");
        setClass(panel, "rr-pane");
        if (!state.service.normalizeItem(item)) {
          panel.textContent = "请选择一篇文献或它的 PDF 附件。";
        }
        else {
          const parent = state.service.normalizeItem(item);
          const reading = state.service.getState(parent);
          const status = doc.createElementNS(XHTML_NS, "span");
          setClass(status, "rr-pane-status");
          status.textContent = STATUS_LABELS[reading.status] || "未读";
          const copy = doc.createElementNS(XHTML_NS, "div");
          setClass(copy, "rr-pane-copy");
          copy.textContent = `笔记 ${String(reading.notes || "").trim() ? "已记录" : "未填写"} · 清单 ${checkedCount(reading.checklist)}/${CHECKLIST.length}`;
          const open = doc.createElementNS(XHTML_NS, "button");
          open.setAttribute("type", "button");
          setClass(open, "rr-button rr-button-primary");
          open.textContent = "打开论文阅读室";
          open.addEventListener("click", () => show({ itemID: parent.id }));
          const row = doc.createElementNS(XHTML_NS, "div");
          setClass(row, "rr-pane-row");
          row.append(status, copy, open);
          panel.append(row);
        }
        body.append(panel);
      },
    });
  }

  function registerColumn() {
    if (!Zotero.ItemTreeManager || typeof Zotero.ItemTreeManager.registerColumn !== "function") return;
    columnKey = Zotero.ItemTreeManager.registerColumn({
      dataKey: COLUMN_KEY,
      label: "阅读状态",
      pluginID: PLUGIN_ID,
      enabledTreeIDs: ["main"],
      width: "86",
      minWidth: 68,
      showInColumnPicker: true,
      zoteroPersist: ["width", "hidden", "sortDirection"],
      dataProvider(item) {
        return summaryForItem(item);
      },
      renderCell(_index, data, column, _isFirstColumn, doc) {
        const cell = doc.createElementNS(XHTML_NS, "span");
        setClass(cell, `cell ${column.className} rr-status-cell rr-status-${data || "unread"}`);
        cell.textContent = data || "未读";
        return cell;
      },
    }) || null;
  }

  function readerToolbar(event) {
    const { reader, doc, append } = event || {};
    if (!reader || !doc || typeof append !== "function") return;
    const item = Zotero.Items.get(reader.itemID);
    if (!item) return;
    const open = doc.createElementNS(XHTML_NS, "button");
    open.setAttribute("type", "button");
    setClass(open, "toolbar-button rr-reader-toolbar");
    open.setAttribute("title", "打开论文阅读室");
    open.setAttribute("aria-label", "打开论文阅读室");
    const image = doc.createElementNS(XHTML_NS, "img");
    image.setAttribute("src", state.iconURL);
    image.setAttribute("alt", "");
    open.append(image);
    open.addEventListener("click", () => show({ itemID: item.id }));
    append(open);
  }

  function refreshLibraries() {
    try {
      Zotero.ItemTreeManager && Zotero.ItemTreeManager.refreshColumns
        && Zotero.ItemTreeManager.refreshColumns();
    }
    catch (error) {
      logError("refresh columns", error);
    }
  }

  function startup(options) {
    if (started) return;
    state = {
      rootURI: options.rootURI,
      cssURL: options.cssURL,
      iconURL: options.iconURL,
      service: options.service,
      version: options.version,
    };
    started = true;
    registerMenus();
    registerItemPane();
    registerColumn();
    if (Zotero.Reader && typeof Zotero.Reader.registerEventListener === "function") {
      Zotero.Reader.registerEventListener("renderToolbar", readerToolbar, PLUGIN_ID);
    }
    for (const win of Zotero.getMainWindows()) onMainWindowLoad({ window: win });
  }

  function onMainWindowLoad({ window }) {
    if (!window || !window.document) return;
    try {
      window.MozXULElement && window.MozXULElement.insertFTLIfNeeded
        && window.MozXULElement.insertFTLIfNeeded("reading-room.ftl");
    }
    catch (error) {
      logError("load localization in main window", error);
    }
  }

  function onMainWindowUnload(_params) {}

  async function shutdown() {
    started = false;
    if (noteTimer) clearTimeout(noteTimer);
    if (checklistTimer) clearTimeout(checklistTimer);
    noteTimer = checklistTimer = null;
    if (aiConfigSession) {
      const session = aiConfigSession;
      aiConfigSession.generation++;
      if (aiConfigSession.timer != null) clearTimeout(aiConfigSession.timer);
      if (aiConfigSession.controller) {
        try { aiConfigSession.controller.abort(); } catch (_) {}
      }
      aiConfigSession.finished = true;
      aiConfigSession = null;
      if (typeof session.close === "function") {
        try { session.close(); } catch (_) {}
      }
    }
    if (Zotero.Reader && typeof Zotero.Reader.unregisterEventListener === "function") {
      try { Zotero.Reader.unregisterEventListener("renderToolbar", readerToolbar); } catch (_) {}
    }
    try {
      if (itemPaneID && Zotero.ItemPaneManager) Zotero.ItemPaneManager.unregisterSection(itemPaneID);
    }
    catch (error) {
      logError("unregister item pane", error);
    }
    itemPaneID = null;
    try {
      if (columnKey && Zotero.ItemTreeManager) Zotero.ItemTreeManager.unregisterColumn(columnKey);
    }
    catch (error) {
      logError("unregister item column", error);
    }
    columnKey = null;
    try {
      if (Zotero.MenuManager) {
        Zotero.MenuManager.unregisterMenu(MENU_TOOLS);
        Zotero.MenuManager.unregisterMenu(MENU_ITEM);
      }
    }
    catch (error) {
      logError("unregister menus", error);
    }
    const win = existingWindow();
    if (win) {
      try { win.close(); } catch (_) {}
    }
    state = null;
  }

  function makeApiButton(label, className, action, title) {
    const element = (state && state.document || mainDocument).createElementNS(XHTML_NS, "button");
    element.setAttribute("type", "button");
    setClass(element, "rr-button " + (className || ""));
    element.textContent = label;
    if (title) element.setAttribute("title", title);
    element.addEventListener("click", action);
    return element;
  }

  function makeField(label, input) {
    const field = (state && state.document || mainDocument).createElementNS(XHTML_NS, "label");
    setClass(field, "rr-field");
    const caption = (state && state.document || mainDocument).createElementNS(XHTML_NS, "span");
    setClass(caption, "rr-field-label");
    caption.textContent = label;
    field.append(caption, input);
    return field;
  }

  function statusPill(status) {
    const element = (state && state.document || mainDocument).createElementNS(XHTML_NS, "span");
    setClass(element, "rr-pill rr-pill-" + status);
    element.textContent = STATUS_LABELS[status] || status;
    return element;
  }

  function metadataRows(description) {
    const grid = make("div", "rr-meta-grid");
    const rows = [
      ["类型", description.item.itemType || "未知"],
      ["年份", description.item.year || "未记录"],
      ["作者", (description.item.creators || []).join("；") || "未记录"],
      ["期刊 / 会议", description.item.venue || "未记录"],
      ["DOI", description.item.doi || "未记录"],
      ["Zotero 键", description.item.key],
    ];
    for (const [label, value] of rows) {
      const row = make("div", "rr-meta-row");
      row.append(make("span", "rr-meta-label", label), make("span", "rr-meta-value", value));
      grid.append(row);
    }
    return grid;
  }

  function renderStats(container, stats) {
    container.replaceChildren();
    const top = make("div", "rr-stat-grid");
    const cards = [
      ["文献总数", stats.total],
      ["搁置", stats.byStatus && stats.byStatus.parked || 0],
      ["在读", stats.byStatus && stats.byStatus.reading || 0],
      ["已读", stats.byStatus && stats.byStatus.read || 0],
    ];
    for (const [label, value] of cards) {
      const card = make("div", "rr-stat");
      card.append(make("strong", null, value), make("span", null, label));
      top.append(card);
    }
    container.append(top);
    const statusRow = make("div", "rr-distribution");
    for (const [id, label] of Object.entries(STATUS_LABELS)) {
      const count = stats.byStatus && stats.byStatus[id] || 0;
      const entry = make("span", "rr-distribution-entry");
      entry.append(statusPill(id), make("span", null, String(count)));
      statusRow.append(entry);
    }
    container.append(statusRow);
    const years = Object.entries(stats.byYear || {})
      .filter(([year]) => year !== "unknown")
      .sort((a, b) => Number(b[0]) - Number(a[0]))
      .slice(0, 6);
    if (years.length) {
      const yearRow = make("div", "rr-year-row");
      yearRow.append(make("span", "rr-meta-label", "年份分布"));
      for (const [year, count] of years) {
        yearRow.append(make("span", "rr-mini-stat", `${year} · ${count}`));
      }
      container.append(yearRow);
    }
  }

  function dimensionCard(dimension) {
    const card = make("section", "rr-dimension");
    const heading = make("div", "rr-dimension-head");
    heading.append(make("h3", null, dimension.label || dimension.id));
    heading.append(make("span", "rr-confidence", `置信度 ${dimension.confidence || "none"}`));
    card.append(heading);
    card.append(make("p", "rr-dimension-summary", dimension.summary || "信息不足"));
    const evidence = Array.isArray(dimension.evidence) ? dimension.evidence : [];
    if (evidence.length) {
      const list = make("div", "rr-evidence-list");
      for (const entry of evidence) list.append(evidenceBlock(entry));
      card.append(list);
    }
    if (Array.isArray(dimension.subtypes) && dimension.subtypes.length) {
      const subtypes = make("div", "rr-subtypes");
      for (const subtype of dimension.subtypes) {
        const detail = (state && state.document || mainDocument).createElementNS(XHTML_NS, "details");
        detail.append(make("summary", null, `${subtype.label} · ${subtype.confidence}`));
        detail.append(make("p", null, subtype.summary || "信息不足"));
        for (const entry of subtype.evidence || []) detail.append(evidenceBlock(entry));
        subtypes.append(detail);
      }
      card.append(subtypes);
    }
    return card;
  }

  function evidenceBlock(entry) {
    const block = make("div", "rr-evidence");
    block.append(make("blockquote", null, entry.quote || ""));
    const meta = make("div", "rr-evidence-meta");
    const page = entry.pageIndex == null
      ? "页码未确认，打开附件核查"
      : `PDF 第 ${entry.pageIndex + 1} 页`;
    meta.append(make("span", entry.verified ? "rr-verified" : "rr-unverified",
      entry.verified ? "原文逐字匹配" : "未验证引文"));
    meta.append(make("span", null, page));
    const open = makeApiButton("打开证据", "rr-link-button", () => {
      void openEvidence(entry);
    });
    setBooleanAttribute(open, "disabled", !entry.attachmentKey);
    meta.append(open);
    block.append(meta);
    if (entry.reason) block.append(make("p", "rr-small rr-muted", entry.reason));
    return block;
  }

  async function openEvidence(entry) {
    if (!state || !state.currentItem) return;
    try {
      await state.service.openEvidence(state.currentItem, {
        attachmentKey: entry.attachmentKey,
        pageIndex: entry.pageIndex == null ? undefined : entry.pageIndex,
      });
    }
    catch (error) {
      setStatus(state.analysisStatus, safeError(error).message, "error");
    }
  }

  function renderAnalysis(analysis) {
    const target = state.analysisResults;
    target.replaceChildren();
    if (!analysis) {
      const empty = make("div", "rr-empty");
      empty.append(make("strong", null, "尚未生成预读"));
      empty.append(make("p", null, "先运行“抽取式预读”，只读取当前本地 PDF 并展示可核对原文；不会调用模型或创建笔记。"));
      target.append(empty);
      return;
    }
    const header = make("div", "rr-analysis-header");
    const mode = analysis.mode === "model" ? "AI 分析 · 待核对" : "本地抽取式预读";
    header.append(make("h2", null, mode));
    header.append(make("span", "rr-mode-badge " + (analysis.mode === "model" ? "rr-model" : "rr-extractive"), mode));
    target.append(header);
    if (analysis.mode === "model") {
      target.append(make("p", "rr-callout",
        `模型：${analysis.model || "未记录"}。这是模型推断，只有逐字匹配原文的引文能证明文字存在；仍需人工判断论文结论。`));
    }
    else {
      target.append(make("p", "rr-callout",
        "以下是从原文按线索归类的候选摘录，不代表论文已经证明创新性、优越性或引用关系。"));
    }
    const dimensions = new Map((analysis.dimensions || []).map(d => [d.id, d]));
    const grid = make("div", "rr-dimension-grid");
    for (const id of DIMENSION_IDS) {
      const dimension = dimensions.get(id);
      if (dimension) grid.append(dimensionCard(dimension));
    }
    target.append(grid);
    const coverage = analysis.coverage || {};
    const coveragePanel = make("section", "rr-coverage");
    coveragePanel.append(make("h3", null, "覆盖范围"));
    const ratio = percent(coverage.ratio);
    const bar = make("div", "rr-progress");
    const fill = make("div", "rr-progress-fill");
    fill.setAttribute("style", `width: ${ratio}%;`);
    bar.append(fill);
    coveragePanel.append(bar);
    coveragePanel.append(make("p", null,
      `已分析 ${Number(coverage.analyzedCharacters || 0).toLocaleString()} / ${Number(coverage.extractedCharacters || 0).toLocaleString()} 字符（${ratio}%）。`));
    coveragePanel.append(make("p", null,
      coverage.pageAware
        ? `页码可用：${coverage.extractedPages || "未知"} 页。`
        : "页码边界未确认；证据不会标成第 1 页，请打开附件核对。"));
    target.append(coveragePanel);
    if ((analysis.limitations || []).length) {
      const limitations = make("section", "rr-limitations");
      limitations.append(make("h3", null, "限制与核查提示"));
      const list = (state && state.document || mainDocument).createElementNS(XHTML_NS, "ul");
      for (const limitation of analysis.limitations) list.append(make("li", null, limitation));
      limitations.append(list);
      target.append(limitations);
    }
    const extras = make("div", "rr-extra-grid");
    extras.append(renderReferenceList("章节线索", analysis.sectionCues || [], "text"));
    extras.append(renderReferenceList("图表引用候选", analysis.figureTableReferences || [], "reference"));
    extras.append(renderReferenceList("引用上下文候选", analysis.citationCandidates || [], "quote"));
    if ((analysis.terms || []).length) {
      const terms = make("section", "rr-reference-list");
      terms.append(make("h3", null, "高频术语"));
      const cloud = make("div", "rr-term-cloud");
      for (const entry of analysis.terms.slice(0, 18)) {
        cloud.append(make("span", "rr-term", `${entry.term} · ${entry.count}`));
      }
      terms.append(cloud);
      extras.append(terms);
    }
    target.append(extras);
  }

  function renderReferenceList(title, entries, field) {
    const section = make("section", "rr-reference-list");
    section.append(make("h3", null, title));
    if (!entries.length) {
      section.append(make("p", "rr-muted", "当前抽取结果没有可靠候选。"));
      return section;
    }
    for (const entry of entries.slice(0, 12)) {
      const row = make("div", "rr-reference-row");
      const label = entry[field] || entry.quote || entry.reference || entry.text || "未命名线索";
      row.append(make("p", null, label));
      const meta = make("div", "rr-evidence-meta");
      meta.append(make("span", entry.pageIndex == null ? "rr-muted" : null,
        entry.pageIndex == null ? "页码未确认" : `第 ${entry.pageIndex + 1} 页`));
      if (entry.attachmentKey) {
        meta.append(makeApiButton("打开附件", "rr-link-button", () => void openEvidence(entry)));
      }
      row.append(meta);
      section.append(row);
    }
    return section;
  }

  function updateStatusPills(container, current) {
    container.replaceChildren();
    for (const [id, label] of Object.entries(STATUS_LABELS)) {
      const element = makeApiButton(label, "rr-status-choice" + (id === current ? " active" : ""), () => {
        void changeStatus(id);
      });
      element.setAttribute("data-status", id);
      container.append(element);
    }
  }

  async function changeStatus(status) {
    if (!state || !state.currentItem || state.saving) return;
    state.saving = true;
    try {
      const reading = await state.service.setState(state.currentItem, { status });
      state.description.state = reading;
      updateStatusPills(state.statusChoices, reading.status);
      state.updated.textContent = `本地保存于 ${formatDate(reading.updatedAt)}`;
      setStatus(state.globalStatus, `阅读状态已保存为“${STATUS_LABELS[status]}”。`, "success");
      refreshLibraries();
      void loadStats();
    }
    catch (error) {
      setStatus(state.globalStatus, safeError(error).message, "error");
    }
    finally {
      state.saving = false;
    }
  }

  function scheduleNotesSave() {
    if (!state || !state.currentItem) return;
    setStatus(state.notesStatus, "正在等待自动保存…", "pending");
    if (noteTimer) clearTimeout(noteTimer);
    const item = state.currentItem;
    const text = getValue(state.notesInput);
    noteTimer = setTimeout(async () => {
      noteTimer = null;
      if (!state || state.currentItem !== item) return;
      try {
        const reading = await state.service.setState(item, { notes: text });
        if (state.currentItem !== item) return;
        state.description.state = reading;
        state.updated.textContent = `本地保存于 ${formatDate(reading.updatedAt)}`;
        setStatus(state.notesStatus, "笔记已保存到本地插件存储。", "success");
      }
      catch (error) {
        setStatus(state.notesStatus, safeError(error).message, "error");
      }
    }, 700);
  }

  function scheduleChecklistSave(checklist) {
    if (!state || !state.currentItem) return;
    setStatus(state.checklistStatus, "正在保存清单…", "pending");
    if (checklistTimer) clearTimeout(checklistTimer);
    const item = state.currentItem;
    checklistTimer = setTimeout(async () => {
      checklistTimer = null;
      if (!state || state.currentItem !== item) return;
      try {
        const reading = await state.service.setState(item, { checklist });
        if (state.currentItem !== item) return;
        state.description.state = reading;
        setStatus(state.checklistStatus, `清单已保存：${checkedCount(checklist)}/${CHECKLIST.length}`, "success");
      }
      catch (error) {
        setStatus(state.checklistStatus, safeError(error).message, "error");
      }
    }, 350);
  }

  function renderChecklist(checklist) {
    state.checklist.replaceChildren();
    for (const [id, label] of CHECKLIST) {
      const wrapper = make("label", "rr-check");
      const input = (state && state.document || mainDocument).createElementNS(XHTML_NS, "input");
      input.setAttribute("type", "checkbox");
      setChecked(input, !!(checklist && checklist[id]));
      input.addEventListener("change", () => {
        const next = Object.assign({}, state.description.state.checklist || {});
        next[id] = getChecked(input);
        state.description.state.checklist = next;
        scheduleChecklistSave(next);
      });
      wrapper.append(input, make("span", null, label));
      state.checklist.append(wrapper);
    }
  }

  function setBusy(busy) {
    if (!state) return;
    state.analyzing = busy;
    setBooleanAttribute(state.extractButton, "disabled", busy || !state.currentAttachmentID);
    setBooleanAttribute(state.aiButton, "disabled", busy || !state.currentAttachmentID);
    setHidden(state.cancelButton, !busy);
    setBooleanAttribute(state.noteButton, "disabled", !state.description || !state.description.state.analysis);
    setBooleanAttribute(state.syncButton, "disabled", busy || !state.description);
  }

  function showJob(job) {
    if (!state) return;
    const current = job || { status: "idle" };
    if (["extracting", "analyzing", "saving"].includes(current.status)) {
      setBusy(true);
      setStatus(state.analysisStatus, current.detail || "正在分析…", "pending");
    }
    else if (current.status === "error") {
      setBusy(false);
      setStatus(state.analysisStatus, current.detail || "分析失败。", "error");
    }
    else if (current.status === "cancelled") {
      setBusy(false);
      setStatus(state.analysisStatus, "分析已取消；此前保存的阅读状态与分析未改变。", "warning");
    }
    else if (current.status === "complete") {
      setBusy(false);
      setStatus(state.analysisStatus, current.detail || "分析已保存到本地插件存储。", "success");
    }
    else {
      setBusy(false);
      setStatus(state.analysisStatus, "", "");
    }
  }

  async function runAnalysis(mode) {
    if (!state || !state.currentItem || state.analyzing) return;
    const targetItem = state.currentItem;
    let config = null;
    if (mode === "model") {
      config = await openAIConfig(targetItem);
      if (!config || !state || state.currentItem !== targetItem) return;
    }
    activeJob = {
      status: "extracting",
      detail: mode === "model"
        ? `准备通过 ${config.providerLabel || config.provider} 分析…`
        : "准备本地抽取式预读…",
    };
    showJob(activeJob);
    try {
      const result = await state.service.analyze(targetItem, Object.assign({
        attachmentID: state.currentAttachmentID,
        mode,
        onProgress(job) {
          activeJob = job;
          if (state && state.currentItem === targetItem) showJob(job);
        },
      }, config || {}));
      if (!state || state.currentItem !== targetItem) return;
      state.description.state.analysis = result;
      renderAnalysis(result);
      setBooleanAttribute(state.noteButton, "disabled", false);
      showJob({ status: "complete", detail: "分析结果已保存到本地；未创建 Zotero 笔记，也未自动更改阅读状态。" });
    }
    catch (error) {
      const safe = safeError(error);
      showJob({ status: safe.code === "CANCELLED" ? "cancelled" : "error", detail: safe.message });
    }
    finally {
      activeJob = null;
    }
  }

  function cancelAnalysis() {
    if (!state || !state.currentItem) return;
    try {
      const cancelled = state.service.cancelAnalysis(state.currentItem);
      setStatus(state.analysisStatus, cancelled ? "正在取消…" : "当前没有可取消的分析任务。",
        cancelled ? "pending" : "warning");
    }
    catch (error) {
      setStatus(state.analysisStatus, safeError(error).message, "error");
    }
  }

  function dialogShell(title, onClose) {
    const doc = state && state.document || mainDocument;
    const body = documentBody(doc);
    if (!body) throw new Error("阅读室页面缺少 XHTML body 节点。");
    const dialogID = `rr-dialog-${++dialogSequence}`;
    const overlay = doc.createElementNS(XHTML_NS, "div");
    setClass(overlay, "rr-modal-overlay");
    const modal = doc.createElementNS(XHTML_NS, "section");
    setClass(modal, "rr-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-labelledby", `${dialogID}-title`);
    modal.setAttribute("tabindex", "-1");
    const heading = make("div", "rr-modal-head");
    const headingText = make("h2", null, title);
    headingText.setAttribute("id", `${dialogID}-title`);
    heading.append(headingText);
    let closed = false;
    const close = makeApiButton("关闭", "rr-icon-button", () => closeDialog(), "关闭对话框");
    close.setAttribute("aria-label", "关闭 AI 分析设置");
    heading.append(close);
    modal.append(heading);
    overlay.append(modal);
    const onKeyDown = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDialog();
      }
    };
    const closeDialog = () => {
      if (closed) return;
      closed = true;
      overlay.removeEventListener("click", onOverlayClick);
      overlay.removeEventListener("keydown", onKeyDown);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof onClose === "function") onClose();
    };
    const onOverlayClick = event => {
      if (event.target === overlay) closeDialog();
    };
    overlay.addEventListener("click", onOverlayClick);
    overlay.addEventListener("keydown", onKeyDown);
    body.append(overlay);
    return { overlay, modal, close: closeDialog };
  }

  function openAIConfig(item = state && state.currentItem) {
    return new Promise(resolve => {
      const doc = state && state.document || mainDocument;
      const providers = getProviderCatalog();
      const defaultProvider = providers.find(provider => provider.id === DEFAULT_PROVIDER) || providers[0];
      const groupRemoteForbidden = isGroupLibrary(item);
      const session = {
        generation: 0,
        timer: null,
        controller: null,
        finished: false,
        discoveryAllowedOrigin: null,
        analysisAllowedOrigin: null,
        lastEndpoint: defaultProvider.defaultEndpoint,
        lastProvider: defaultProvider.id,
      };
      let closeShell = () => {};
      let settling = false;
      let sessionMounted = false;
      const cleanup = () => {
        if (session.finished) return;
        session.finished = true;
        session.generation++;
        if (session.timer != null) clearTimeout(session.timer);
        session.timer = null;
        if (session.controller) {
          try { session.controller.abort(); } catch (_) {}
        }
        session.controller = null;
        if (aiConfigSession === session) aiConfigSession = null;
        if (!sessionMounted) {
          try { closeShell(); } catch (_) {}
          resolve(null);
        }
      };
      const finish = value => {
        if (session.finished) return;
        settling = true;
        cleanup();
        if (sessionMounted) {
          closeShell();
          resolve(value);
        }
      };
      const shell = dialogShell("AI 分析设置", () => {
        cleanup();
        if (!settling) resolve(null);
      });
      closeShell = shell.close;
      session.close = shell.close;
      const { modal } = shell;
      sessionMounted = true;
      aiConfigSession = session;

      const provider = doc.createElementNS(XHTML_NS, "select");
      provider.setAttribute("aria-label", "AI 协议");
      for (const entry of providers) {
        const option = doc.createElementNS(XHTML_NS, "option");
        option.value = entry.id;
        option.setAttribute("value", entry.id);
        option.textContent = entry.label;
        provider.append(option);
      }
      provider.value = defaultProvider.id;
      provider.setAttribute("value", defaultProvider.id);
      const providerHint = make("p", "rr-field-help");
      const endpoint = doc.createElementNS(XHTML_NS, "input");
      endpoint.setAttribute("type", "url");
      setValue(endpoint, defaultProvider.defaultEndpoint);
      endpoint.setAttribute("autocomplete", "off");
      endpoint.setAttribute("spellcheck", "false");
      endpoint.setAttribute("placeholder", "例如 http://127.0.0.1:11434/v1");

      const model = doc.createElementNS(XHTML_NS, "input");
      model.setAttribute("type", "text");
      model.setAttribute("placeholder", "搜索自动获取的模型，或手工填写模型 ID");
      model.setAttribute("autocomplete", "off");
      model.setAttribute("role", "combobox");
      model.setAttribute("aria-autocomplete", "list");
      model.setAttribute("aria-expanded", "false");
      model.setAttribute("aria-controls", "rr-model-options");

      const modelOptions = doc.createElementNS(XHTML_NS, "div");
      modelOptions.setAttribute("id", "rr-model-options");
      modelOptions.setAttribute("role", "listbox");
      setClass(modelOptions, "rr-model-options");
      setHidden(modelOptions, true);

      const discoveryStatus = make("div", "rr-message");
      discoveryStatus.setAttribute("role", "status");
      discoveryStatus.setAttribute("aria-live", "polite");
      setHidden(discoveryStatus, true);

      const discoveryActions = make("div", "rr-inline-actions");
      const refresh = makeApiButton("获取模型列表", "rr-secondary", () => {
        scheduleDiscovery(0, true);
      });
      discoveryActions.append(refresh);

      const apiKey = doc.createElementNS(XHTML_NS, "input");
      apiKey.setAttribute("type", "password");
      apiKey.setAttribute("autocomplete", "off");
      apiKey.setAttribute("placeholder", "可选；仅保存在本次窗口内存");

      const discoveryRemote = doc.createElementNS(XHTML_NS, "input");
      discoveryRemote.setAttribute("type", "checkbox");
      discoveryRemote.setAttribute("aria-label", "允许连接该远程 API 获取模型列表");
      const discoveryRemoteRow = make("label", "rr-check rr-warning-check");
      discoveryRemoteRow.append(discoveryRemote, make("span", null,
        "允许连接该远程 API 获取模型列表（只发送协议、端点和密钥；不发送论文或 PDF）。"));
      discoveryRemote.setAttribute("aria-describedby", "rr-discovery-permission-help");
      discoveryRemoteRow.setAttribute("id", "rr-discovery-permission-help");

      const analysisRemote = doc.createElementNS(XHTML_NS, "input");
      analysisRemote.setAttribute("type", "checkbox");
      analysisRemote.setAttribute("aria-label", "允许向该远程 API 发送有界论文正文");
      const analysisRemoteRow = make("label", "rr-check rr-warning-check");
      analysisRemoteRow.append(analysisRemote, make("span", null,
        "我明确同意本次把所选 PDF 的有界原文片段发送到上面的非本机 HTTPS 服务，并自行确认服务商与数据用途。"));
      analysisRemote.setAttribute("aria-describedby", "rr-analysis-permission-help");
      analysisRemoteRow.setAttribute("id", "rr-analysis-permission-help");

      const warning = make("div", "rr-callout rr-warning");
      warning.textContent = "模型发现与正文分析是两次独立许可。本机端点可自动发现；远程端点必须使用 HTTPS 并分别授权。密钥不会写入偏好、项目、阅读状态或日志，关闭设置后即从本对话框清除。";

      const actions = make("div", "rr-modal-actions");
      const cancel = makeApiButton("取消", "rr-secondary", () => finish(null));
      const run = makeApiButton("开始 AI 分析", "rr-button-primary", () => {
        const selectedProvider = providers.find(entry => entry.id === getValue(provider)) || defaultProvider;
        const context = endpointContext(getValue(endpoint));
        const modelID = getValue(model).trim();
        if (!context.ok) {
          setStatus(modalStatus, context.error, "error");
          endpoint.focus();
          return;
        }
        if (!modelID) {
          setStatus(modalStatus, "请从模型列表中选择，或手工填写模型 ID。", "error");
          model.focus();
          return;
        }
        const allowRemote = getChecked(analysisRemote)
          && session.analysisAllowedOrigin === context.origin;
        if (!context.local && groupRemoteForbidden) {
          setStatus(modalStatus, "群组文库禁止远程正文分析；请改用本机端点。", "error");
          return;
        }
        if (!context.local && !allowRemote) {
          setStatus(modalStatus, "远程正文分析必须勾选上方独立同意；更换端点 origin 后需要重新勾选。", "error");
          analysisRemote.focus();
          return;
        }
        finish({
          provider: selectedProvider.id,
          providerLabel: selectedProvider.label,
          endpoint: getValue(endpoint).trim(),
          model: modelID,
          apiKey: getValue(apiKey) || undefined,
          allowRemote,
        });
      });

      const modalStatus = make("div", "rr-message");
      setHidden(modalStatus, true);
      actions.append(cancel, run);

      const modelField = makeField("模型（可搜索或手工输入）", model);
      modelField.append(modelOptions, discoveryStatus, discoveryActions);
      modelField.setAttribute("role", "group");
      modelField.setAttribute("aria-labelledby", "rr-model-field-label");
      const modelFieldLabel = modelField.children[0];
      if (modelFieldLabel) modelFieldLabel.setAttribute("id", "rr-model-field-label");
      const providerField = makeField("AI 协议", provider);
      providerField.append(providerHint);
      modal.append(
        providerField,
        makeField("API 端点", endpoint),
        makeField("API 密钥（仅本次内存）", apiKey),
        discoveryRemoteRow,
        modelField,
        analysisRemoteRow,
        warning,
        modalStatus,
        actions,
      );

      const clearModels = () => {
        modelOptions.replaceChildren();
        setHidden(modelOptions, true);
        model.setAttribute("aria-expanded", "false");
        refreshModels();
      };
      const updateProviderHint = () => {
        const selected = providers.find(entry => entry.id === getValue(provider)) || defaultProvider;
        providerHint.textContent = selected.endpointHint
          || "端点可填写服务商 base URL；后端会统一规范化列表与请求地址。";
      };
      const resetRemoteConsent = () => {
        setChecked(discoveryRemote, false);
        setChecked(analysisRemote, false);
        session.discoveryAllowedOrigin = null;
        session.analysisAllowedOrigin = null;
      };
      const resetStaleState = (clearKey) => {
        session.generation++;
        session.models = [];
        session.discoveryPending = false;
        if (session.timer != null) clearTimeout(session.timer);
        session.timer = null;
        if (session.controller) {
          try { session.controller.abort(); } catch (_) {}
        }
        session.controller = null;
        clearModels();
        setStatus(discoveryStatus, "", "");
        setStatus(modalStatus, "", "");
        if (clearKey) setValue(apiKey, "");
      };
      const setDiscoveryPermissionForEndpoint = context => {
        if (!context.ok) {
          setHidden(discoveryRemoteRow, false);
          return;
        }
        setHidden(discoveryRemoteRow, context.local);
        if (context.local) setChecked(discoveryRemote, false);
        if (session.discoveryAllowedOrigin && session.discoveryAllowedOrigin !== context.origin) {
          session.discoveryAllowedOrigin = null;
          setChecked(discoveryRemote, false);
        }
      };
      const setAnalysisPermissionForEndpoint = context => {
        if (!context.ok) {
          setHidden(analysisRemoteRow, false);
          return;
        }
        setHidden(analysisRemoteRow, context.local);
        if (context.local || groupRemoteForbidden) setChecked(analysisRemote, false);
        setBooleanAttribute(analysisRemote, "disabled", groupRemoteForbidden && !context.local);
        const description = analysisRemoteRow.lastElementChild;
        if (description) {
          description.textContent = groupRemoteForbidden && !context.local
            ? "群组文库禁止远程正文分析；该端点只能用于获取模型列表。请改用本机端点分析。"
            : "我明确同意本次把所选 PDF 的有界原文片段发送到上面的非本机 HTTPS 服务，并自行确认服务商与数据用途。";
        }
        if (session.analysisAllowedOrigin && session.analysisAllowedOrigin !== context.origin) {
          session.analysisAllowedOrigin = null;
          setChecked(analysisRemote, false);
        }
      };
      const addModelOptions = (models, query) => {
        const needle = query.toLowerCase();
        const visible = models.filter(entry => !needle
          || String(entry.id).toLowerCase().includes(needle)
          || String(entry.name).toLowerCase().includes(needle)).slice(0, 80);
        modelOptions.replaceChildren();
        for (const entry of visible) {
          const option = make("button", "rr-model-option", entry.name || entry.id);
          option.setAttribute("type", "button");
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", String(entry.id === getValue(model).trim()));
          if (entry.name && entry.name !== entry.id) option.append(make("span", "rr-model-id", entry.id));
          option.addEventListener("click", () => {
            if (session.finished) return;
            setValue(model, entry.id);
            modelOptions.replaceChildren();
            setHidden(modelOptions, true);
            model.setAttribute("aria-expanded", "false");
            model.focus();
          });
          modelOptions.append(option);
        }
        setHidden(modelOptions, visible.length === 0);
        model.setAttribute("aria-expanded", String(visible.length > 0));
      };
      const refreshModels = () => {
        const models = Array.isArray(session.models) ? session.models : [];
        if (!models.length && session.discoveryPending) {
          setBooleanAttribute(refresh, "disabled", true);
          return;
        }
        if (!models.length) {
          setBooleanAttribute(refresh, "disabled", !session.lastEndpoint);
          return;
        }
        addModelOptions(models, getValue(model));
        setBooleanAttribute(refresh, "disabled", false);
      };

      const discover = async (generation) => {
        if (session.finished || generation !== session.generation) return;
        const selectedProvider = providers.find(entry => entry.id === getValue(provider)) || defaultProvider;
        const context = endpointContext(getValue(endpoint));
        if (!context.ok) {
          setStatus(discoveryStatus, context.error + " 仍可手工填写模型 ID。", "warning");
          setBooleanAttribute(refresh, "disabled", true);
          return;
        }
        const allowRemote = !context.local
          && getChecked(discoveryRemote)
          && session.discoveryAllowedOrigin === context.origin;
        if (!context.local && !allowRemote) {
          setStatus(discoveryStatus,
            "该远程端点尚未授权获取模型列表；勾选上方许可，或手工填写模型 ID。",
            "warning");
          setBooleanAttribute(refresh, "disabled", !getChecked(discoveryRemote));
          return;
        }
        if (!state || !state.service || typeof state.service.listModels !== "function") {
          setStatus(discoveryStatus,
            "当前后端未提供模型列表接口；请手工填写模型 ID。", "warning");
          setBooleanAttribute(refresh, "disabled", true);
          return;
        }
        const controller = new (state.window.AbortController || AbortController)();
        session.controller = controller;
        session.discoveryPending = true;
        setBooleanAttribute(refresh, "disabled", true);
        setStatus(discoveryStatus, `正在从 ${selectedProvider.label} 获取模型列表…`, "pending");
        try {
          const result = await state.service.listModels({
            provider: selectedProvider.id,
            endpoint: getValue(endpoint).trim(),
            apiKey: getValue(apiKey) || undefined,
            allowRemote,
            signal: controller.signal,
            item,
          });
          if (session.finished || generation !== session.generation) return;
          const models = Array.isArray(result && result.models) ? result.models
            .filter(entry => entry && String(entry.id || "").trim())
            .map(entry => ({
              id: String(entry.id).trim(),
              name: String(entry.name || entry.id).trim() || String(entry.id).trim(),
            })) : [];
          session.models = models;
          if (result && result.endpoint && String(result.endpoint).trim()) {
            session.lastEndpoint = String(result.endpoint).trim();
          }
          if (!models.length) {
            session.discoveryPending = false;
            setStatus(discoveryStatus,
              "服务返回了空模型列表；请确认账号权限，或手工填写模型 ID。", "warning");
            refresh.textContent = "刷新模型列表";
          }
          else {
            session.discoveryPending = false;
            setStatus(discoveryStatus,
              `已获取 ${models.length} 个模型；可在模型框中搜索，也可继续手工输入。`, "success");
            refresh.textContent = "刷新模型列表";
          }
          refreshModels();
        }
        catch (error) {
          if (session.finished || generation !== session.generation) return;
          session.discoveryPending = false;
          const cancelled = controller.signal && controller.signal.aborted
            || String(error && error.code || "") === "CANCELLED";
          if (!cancelled) {
            setStatus(discoveryStatus, modelDiscoveryFailure(error), "error");
            refresh.textContent = "重试获取模型列表";
          }
        }
        finally {
          session.discoveryPending = false;
          if (!session.finished && generation === session.generation) {
            if (session.controller === controller) session.controller = null;
            setBooleanAttribute(refresh, "disabled", false);
          }
        }
      };

      function scheduleDiscovery(delay = MODEL_DISCOVERY_DELAY, force = false) {
        if (session.finished) return;
        session.generation++;
        const generation = session.generation;
        if (session.timer != null) clearTimeout(session.timer);
        session.timer = null;
        if (session.controller) {
          try { session.controller.abort(); } catch (_) {}
        }
        session.controller = null;
        session.discoveryPending = false;
        if (!force) {
          session.models = [];
          modelOptions.replaceChildren();
          setHidden(modelOptions, true);
          model.setAttribute("aria-expanded", "false");
        }
        setStatus(discoveryStatus, delay ? "正在等待地址、协议或密钥变化结束…" : "", delay ? "pending" : "");
        session.timer = setTimeout(() => {
          if (session.finished || generation !== session.generation) return;
          session.timer = null;
          void discover(generation);
        }, delay);
      }

      const providerChanged = () => {
        const selected = providers.find(entry => entry.id === getValue(provider)) || defaultProvider;
        resetStaleState(true);
        resetRemoteConsent();
        setValue(endpoint, selected.defaultEndpoint);
        setValue(model, "");
        session.lastProvider = selected.id;
        session.lastEndpoint = selected.defaultEndpoint;
        updateProviderHint();
        setDiscoveryPermissionForEndpoint(endpointContext(selected.defaultEndpoint));
        setAnalysisPermissionForEndpoint(endpointContext(selected.defaultEndpoint));
        scheduleDiscovery();
      };
      const endpointChanged = () => {
        const context = endpointContext(getValue(endpoint));
        const originChanged = session.lastEndpoint !== getValue(endpoint).trim()
          && (!context.ok || context.origin !== endpointContext(session.lastEndpoint).origin);
        resetStaleState(originChanged);
        session.lastEndpoint = getValue(endpoint).trim();
        setDiscoveryPermissionForEndpoint(context);
        setAnalysisPermissionForEndpoint(context);
        scheduleDiscovery();
      };
      const credentialChanged = () => {
        resetStaleState(false);
        refresh.textContent = "获取模型列表";
        scheduleDiscovery();
      };
      const remotePermissionChanged = () => {
        const context = endpointContext(getValue(endpoint));
        session.discoveryAllowedOrigin = !context.ok || context.local
          || !getChecked(discoveryRemote) ? null : context.origin;
        resetStaleState(false);
        scheduleDiscovery(0, true);
      };
      const analysisPermissionChanged = () => {
        const context = endpointContext(getValue(endpoint));
        session.analysisAllowedOrigin = groupRemoteForbidden || !context.ok || context.local
          || !getChecked(analysisRemote) ? null : context.origin;
        if (session.analysisAllowedOrigin) {
          setStatus(modalStatus,
            "已授权向该远程端点发送有界正文；群组文库仍禁止远程正文分析。", "warning");
        }
      };

      provider.addEventListener("change", providerChanged);
      endpoint.addEventListener("input", endpointChanged);
      endpoint.addEventListener("change", endpointChanged);
      apiKey.addEventListener("input", credentialChanged);
      discoveryRemote.addEventListener("change", remotePermissionChanged);
      analysisRemote.addEventListener("change", analysisPermissionChanged);
      model.addEventListener("input", refreshModels);
      model.addEventListener("focus", refreshModels);
      model.addEventListener("keydown", event => {
        if (event.key === "Escape" && !modelOptions.hasAttribute("hidden")) {
          event.stopPropagation();
          setHidden(modelOptions, true);
          model.setAttribute("aria-expanded", "false");
        }
      });
      updateProviderHint();
      setDiscoveryPermissionForEndpoint(endpointContext(defaultProvider.defaultEndpoint));
      setAnalysisPermissionForEndpoint(endpointContext(defaultProvider.defaultEndpoint));
      scheduleDiscovery();
      modal.focus();
    });
  }

  async function saveAnalysisNote() {
    if (!state || !state.currentItem || !state.description.state.analysis) return;
    setBooleanAttribute(state.noteButton, "disabled", true);
    setStatus(state.noteStatus, "正在创建插件分析笔记…", "pending");
    try {
      const result = await state.service.saveAnalysisNote(state.currentItem);
      setStatus(state.noteStatus,
        result.created ? "已显式创建新的 Zotero 分析笔记。" : "同一分析已有插件笔记，未重复创建。",
        "success");
    }
    catch (error) {
      setStatus(state.noteStatus, safeError(error).message, "error");
    }
    finally {
      if (state) setBooleanAttribute(state.noteButton, "disabled", false);
    }
  }

  async function syncStateNote() {
    if (!state || !state.currentItem) return;
    setBooleanAttribute(state.syncButton, "disabled", true);
    setStatus(state.noteStatus, "正在同步阅读记录到个人库笔记…", "pending");
    try {
      const result = await state.service.syncStateNote(state.currentItem);
      const text = result.changed
        ? (result.created ? "已显式创建阅读记录笔记。" : "已更新本插件创建的阅读记录笔记。")
        : "阅读记录笔记已是最新，没有重复写入。";
      setStatus(state.noteStatus, text, "success");
    }
    catch (error) {
      setStatus(state.noteStatus, safeError(error).message, "error");
    }
    finally {
      if (state) setBooleanAttribute(state.syncButton, "disabled", false);
    }
  }

  function markdownFor(description) {
    const metadata = description.item;
    const reading = description.state;
    const analysis = reading.analysis;
    const lines = [
      `# ${metadata.title || "未命名文献"}`,
      "",
      `- 阅读状态：${STATUS_LABELS[reading.status] || reading.status}`,
      `- 作者：${(metadata.creators || []).join("；") || "未记录"}`,
      `- 年份：${metadata.year || "未记录"}`,
      `- 期刊 / 会议：${metadata.venue || "未记录"}`,
      `- DOI：${metadata.doi || "未记录"}`,
      `- Zotero：${metadata.libraryID}/${metadata.key}`,
      "",
      "## 阅读笔记",
      "",
      reading.notes || "尚未填写。",
      "",
      "## 核对清单",
      "",
    ];
    for (const [id, label] of CHECKLIST) {
      lines.push(`- [${reading.checklist && reading.checklist[id] ? "x" : " "}] ${label}`);
    }
    if (analysis) {
      lines.push("", `## ${analysis.mode === "model" ? "AI 分析（待核对）" : "抽取式预读"}`, "");
      for (const dimension of analysis.dimensions || []) {
        lines.push(`### ${dimension.label}`, "", dimension.summary || "信息不足", "");
        for (const entry of dimension.evidence || []) {
          const location = entry.pageIndex == null ? "页码未确认，打开附件核查" : `PDF 第 ${entry.pageIndex + 1} 页`;
          lines.push(`> ${entry.quote || ""}`, "", `— ${location}；${entry.verified ? "原文逐字匹配" : "未验证"}`, "");
        }
      }
      const coverage = analysis.coverage || {};
      lines.push("## 覆盖范围与限制", "",
        `- 分析字符：${coverage.analyzedCharacters || 0} / ${coverage.extractedCharacters || 0}`,
        `- 页码边界：${coverage.pageAware ? "可用" : "未确认"}`);
      for (const limitation of analysis.limitations || []) lines.push(`- ${limitation}`);
    }
    lines.push("", "> 本文件由 Zotero 插件在本地显式导出；不包含自动云端上传。", "");
    return lines.join("\n");
  }

  async function chooseExport(type) {
    if (!state || !state.description) return;
    try {
      const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
      );
      const picker = new FilePicker();
      picker.init(state.window, type === "json" ? "导出阅读室 JSON" : "导出阅读室 Markdown", picker.modeSave);
      const safeTitle = String(state.description.item.title || "reading-room")
        .replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
      picker.defaultString = `${safeTitle}.${type}`;
      picker.defaultExtension = type;
      picker.appendFilter(type === "json" ? "JSON" : "Markdown", `*.${type}`);
      const result = await picker.show();
      if (![picker.returnOK, picker.returnReplace].includes(result)) return;
      const content = type === "json"
        ? JSON.stringify(state.description, null, 2)
        : markdownFor(state.description);
      await IOUtils.writeUTF8(picker.file, content, { flush: true });
      setStatus(state.exportStatus, `已导出到 ${picker.file}`, "success");
    }
    catch (error) {
      setStatus(state.exportStatus, `导出失败：${safeError(error).message}`, "error");
    }
  }

  async function selectItem(item) {
    if (!state || !item) return;
    const generation = ++loadGeneration;
    state.currentItem = null;
    state.currentAttachmentID = null;
    state.description = null;
    setStatus(state.globalStatus, "正在读取文献…", "pending");
    state.title.textContent = "正在加载…";
    state.subtitle.textContent = "";
    state.analysisResults.replaceChildren(make("div", "rr-empty", "正在读取当前文献…"));
    try {
      const parent = state.service.normalizeItem(item);
      if (!parent) throw new Error("请选择一篇文献或它的 PDF 附件。");
      const description = await state.service.describe(parent);
      if (generation !== loadGeneration || !state) return;
      state.currentItem = parent;
      state.description = description;
      const pdfs = description.attachments.filter(attachment => attachment.contentType === "application/pdf");
      const available = pdfs.find(attachment => attachment.available);
      state.currentAttachmentID = available ? available.id : pdfs[0] ? pdfs[0].id : null;
      state.title.textContent = description.item.title || "未命名文献";
      state.subtitle.textContent = [
        description.item.year,
        description.item.venue,
        (description.item.creators || []).join("；"),
      ].filter(Boolean).join(" · ") || "元数据尚未完整";
      state.metadata.replaceChildren(metadataRows(description));
      state.attachmentSelect.replaceChildren();
      state.attachmentSelect.value = "";
      state.attachmentSelect.removeAttribute("value");
      if (!pdfs.length) {
        const option = (state && state.document || mainDocument).createElementNS(XHTML_NS, "option");
        setValue(option, "");
        option.textContent = "未找到 PDF 附件";
        state.attachmentSelect.append(option);
      }
      else {
        for (const attachment of pdfs) {
          const option = (state && state.document || mainDocument).createElementNS(XHTML_NS, "option");
          setValue(option, String(attachment.id));
          option.textContent = `${attachment.title || "PDF"}${attachment.available ? "" : "（本地不可用）"}`;
          setBooleanAttribute(option, "disabled", !attachment.available);
          setBooleanAttribute(option, "selected", attachment.id === state.currentAttachmentID);
          state.attachmentSelect.append(option);
        }
        state.attachmentSelect.value = String(state.currentAttachmentID);
        state.attachmentSelect.setAttribute("value", String(state.currentAttachmentID));
      }
      setBooleanAttribute(state.attachmentSelect, "disabled", !pdfs.some(attachment => attachment.available));
      updateStatusPills(state.statusChoices, description.state.status);
      setValue(state.notesInput, description.state.notes || "");
      renderChecklist(description.state.checklist || {});
      state.updated.textContent = `本地保存于 ${formatDate(description.state.updatedAt)}`;
      state.counts.textContent = `Zotero 笔记 ${description.counts.notes} · 注释 ${description.counts.annotations}`;
      renderAnalysis(description.state.analysis);
      const job = description.state.analysisJob || { status: "idle" };
      showJob(job);
      setBooleanAttribute(state.noteButton, "disabled", !description.state.analysis);
      setBooleanAttribute(state.syncButton, "disabled", false);
      setStatus(state.globalStatus,
        pdfs.some(attachment => attachment.available)
          ? "已读取当前文献；所有阅读数据默认保存在本地插件侧文件。"
          : "未找到可用的本地 PDF；仍可编辑阅读状态和笔记。",
        pdfs.some(attachment => attachment.available) ? "success" : "warning");
      void loadStats();
    }
    catch (error) {
      if (generation !== loadGeneration || !state) return;
      state.title.textContent = "无法打开当前文献";
      state.subtitle.textContent = safeError(error).message;
      state.analysisResults.replaceChildren(make("div", "rr-empty", safeError(error).message));
      setStatus(state.globalStatus, safeError(error).message, "error");
    }
  }

  async function loadStats() {
    if (!state) return;
    try {
      const stats = await state.service.getLibraryStats(Zotero.Libraries.userLibraryID);
      if (state) renderStats(state.stats, stats);
    }
    catch (error) {
      if (state) {
        state.stats.replaceChildren(make("p", "rr-muted", `统计读取失败：${safeError(error).message}`));
      }
    }
  }

  function buildWindow(targetWindow, targetDocument) {
    state.document = targetDocument;
    state.window = targetWindow;
    targetDocument.title = "Reading Room · 论文阅读室";
    targetDocument.documentElement.setAttribute("windowtype", WINDOW_TYPE);
    const head = documentHead(targetDocument);
    const body = documentBody(targetDocument);
    if (!head || !body) throw new Error("阅读室页面缺少 XHTML head/body 节点。");
    const css = (state && state.document || mainDocument).createElementNS(XHTML_NS, "link");
    css.setAttribute("rel", "stylesheet");
    css.setAttribute("href", state.cssURL);
    head.append(css);

    const app = make("main", "rr-app");
    const header = make("header", "rr-topbar");
    const identity = make("div", "rr-identity");
    const icon = (state && state.document || mainDocument).createElementNS(XHTML_NS, "img");
    icon.setAttribute("src", state.iconURL);
    icon.setAttribute("alt", "");
    identity.append(icon, make("div", "rr-brand-copy"));
    identity.lastElementChild.append(
      make("strong", null, "Reading Room"),
      make("span", null, "论文阅读室 · 本地优先"),
    );
    const headerActions = make("div", "rr-header-actions");
    headerActions.append(
      makeApiButton("导出 JSON", "rr-secondary", () => void chooseExport("json")),
      makeApiButton("导出 Markdown", "rr-secondary", () => void chooseExport("md")),
    );
    header.append(identity, headerActions);
    app.append(header);

    const globalStatus = make("div", "rr-message");
    setHidden(globalStatus, true);
    app.append(globalStatus);

    const main = make("div", "rr-layout");
    const sidebar = make("aside", "rr-sidebar");
    const dashboard = make("section", "rr-dashboard");
    dashboard.append(make("h2", null, "文库概览"));
    const stats = make("div", "rr-stats");
    dashboard.append(stats);
    const privacy = make("section", "rr-privacy");
    privacy.append(
      make("h3", null, "数据边界"),
      make("p", null, "默认只读取本机 PDF，阅读状态和笔记保存在本地插件存储。"),
      make("p", null, "“抽取式预读”不联网；模型列表只在主动打开 AI 设置后获取，正文发送需单独明确同意。"),
      make("p", null, "分析结果与阅读记录只有点击对应保存按钮时才写入 Zotero 笔记。"),
    );
    sidebar.append(dashboard, privacy);

    const content = make("section", "rr-content");
    const hero = make("header", "rr-hero");
    const titleBlock = make("div", "rr-title-block");
    const title = make("h1", null, "选择一篇文献");
    const subtitle = make("p", null, "从 Zotero 条目列表、右键菜单或右侧面板打开。");
    titleBlock.append(title, subtitle);
    const counts = make("span", "rr-count-badge", "");
    hero.append(titleBlock, counts);
    content.append(hero);

    const metadata = make("section", "rr-card rr-metadata");
    metadata.append(make("h2", null, "文献信息"));
    content.append(metadata);

    const reading = make("section", "rr-card rr-reading-card");
    const readingHead = make("div", "rr-section-head");
    readingHead.append(make("h2", null, "阅读记录"));
    const updated = make("span", "rr-muted", "尚未保存");
    readingHead.append(updated);
    const statusChoices = make("div", "rr-status-choices");
    const attachmentField = make("label", "rr-field rr-attachment-field");
    attachmentField.append(make("span", "rr-field-label", "用于分析的本地 PDF"));
    const attachmentSelect = (state && state.document || mainDocument).createElementNS(XHTML_NS, "select");
      attachmentSelect.value = "";
    attachmentField.append(attachmentSelect);
    const notesLabel = make("label", "rr-field rr-notes-field");
    notesLabel.append(make("span", "rr-field-label", "阅读笔记 · 自动保存到本地插件存储"));
    const notesInput = (state && state.document || mainDocument).createElementNS(XHTML_NS, "textarea");
    notesInput.setAttribute("rows", "9");
    notesInput.setAttribute("placeholder", "记录问题、方法、证据、可复用观点和待核查项…");
    notesInput.setAttribute("spellcheck", "true");
    notesLabel.append(notesInput);
    const notesStatus = make("div", "rr-message");
    setHidden(notesStatus, true);
    const checklist = make("div", "rr-checklist");
    const checklistStatus = make("div", "rr-message");
    setHidden(checklistStatus, true);
    reading.append(readingHead, statusChoices, attachmentField, notesLabel, notesStatus, checklist, checklistStatus);
    content.append(reading);

    const analysis = make("section", "rr-card rr-analysis-card");
    const analysisHead = make("div", "rr-section-head");
    const analysisHeading = make("div", "rr-analysis-heading");
    analysisHeading.append(
      make("h2", null, "六维证据预读"),
      make("p", "rr-muted", "抽取式候选与 AI 推断分开显示；页码无法确认时不会猜测。"),
    );
    const analysisActions = make("div", "rr-analysis-actions");
    const extractButton = makeApiButton("抽取式预读", "rr-button-primary", () => void runAnalysis("extractive"),
      "离线读取本地 PDF，不调用模型");
    const aiButton = makeApiButton("AI 分析…", "rr-secondary", () => void runAnalysis("model"),
      "显式配置后调用模型");
    const cancelButton = makeApiButton("取消", "rr-danger", cancelAnalysis);
    setHidden(cancelButton, true);
    analysisActions.append(extractButton, aiButton, cancelButton);
    analysisHead.append(analysisHeading, analysisActions);
    const analysisStatus = make("div", "rr-message");
    setHidden(analysisStatus, true);
    const analysisResults = make("div", "rr-analysis-results");
    const noteActions = make("div", "rr-note-actions");
    const noteButton = makeApiButton("保存为新的 Zotero 分析笔记", "rr-secondary", () => void saveAnalysisNote(),
      "仅在点击时创建插件专用分析笔记");
    const syncButton = makeApiButton("同步阅读记录到个人库笔记", "rr-secondary", () => void syncStateNote(),
      "仅在点击时创建或更新插件专用阅读状态快照");
    noteActions.append(noteButton, syncButton);
    const noteStatus = make("div", "rr-message");
    setHidden(noteStatus, true);
    analysis.append(analysisHead, analysisStatus, analysisResults, noteActions, noteStatus);
    content.append(analysis);
    const exportStatus = make("div", "rr-message");
    setHidden(exportStatus, true);
    content.append(exportStatus);
    main.append(sidebar, content);
    app.append(main);
    body.replaceChildren(app);

    state = Object.assign(state, {
      title, subtitle, counts, metadata, statusChoices, attachmentSelect,
      notesInput, notesStatus, checklist, checklistStatus, updated,
      stats, globalStatus, extractButton, aiButton, cancelButton,
      analysisStatus, analysisResults, noteButton, syncButton, noteStatus,
      exportStatus, currentItem: null, description: null, currentAttachmentID: null,
      analyzing: false, saving: false,
      window: targetWindow, document: targetDocument,
    });

    notesInput.addEventListener("input", scheduleNotesSave);
    attachmentSelect.addEventListener("change", () => {
      const id = Number(getValue(attachmentSelect));
      state.currentAttachmentID = Number.isInteger(id) && id > 0 ? id : null;
      setBusy(false);
      setStatus(state.analysisStatus,
        state.currentAttachmentID ? "已切换分析附件；已有分析不会被删除。" : "没有可用的本地 PDF。",
        state.currentAttachmentID ? "" : "warning");
    });
    setBusy(false);
  }

  function start(options = {}) {
    const targetWindow = options.window || existingWindow();
    const targetDocument = options.document || (targetWindow && targetWindow.document);
    if (!targetWindow || !targetDocument) return;
    if (targetWindow.ReadingRoomWindow && targetWindow.ReadingRoomWindow._started) {
      if (options.itemID) targetWindow.ReadingRoomWindow.selectItem(Zotero.Items.get(Number(options.itemID)));
      return;
    }
    buildWindow(targetWindow, targetDocument);
    targetWindow.ReadingRoomWindow = {
      _started: true,
      selectItem,
      show,
    };
    try {
      const mainWindow = Zotero.getMainWindow();
      const selected = options.itemID
        ? Zotero.Items.get(Number(options.itemID))
        : selectedPaneItem(mainWindow);
      if (selected) void selectItem(selected);
      else {
        state.analysisResults.replaceChildren(make("div", "rr-empty",
          "从 Zotero 主窗口选择文献后重新打开，或使用条目右键菜单“论文阅读室”。"));
        void loadStats();
      }
    }
    catch (error) {
      logError("initial selection", error);
      void loadStats();
    }
    targetWindow.addEventListener("unload", () => {
      if (noteTimer) clearTimeout(noteTimer);
      if (checklistTimer) clearTimeout(checklistTimer);
      if (aiConfigSession) {
        const session = aiConfigSession;
        aiConfigSession.generation++;
        if (aiConfigSession.timer != null) clearTimeout(aiConfigSession.timer);
        if (aiConfigSession.controller) {
          try { aiConfigSession.controller.abort(); } catch (_) {}
        }
        aiConfigSession.finished = true;
        aiConfigSession = null;
        if (typeof session.close === "function") {
          try { session.close(); } catch (_) {}
        }
      }
      if (activeJob && state && state.currentItem && state.service) {
        try { state.service.cancelAnalysis(state.currentItem); } catch (_) {}
      }
    }, { once: true });
  }

  scope.ReadingRoomUI = Object.freeze({
    startup,
    shutdown,
    show,
    mountWindow,
    window: existingWindow,
    onMainWindowLoad,
    onMainWindowUnload,
  });
  scope.ReadingRoomWindow = Object.freeze({
    start,
    selectItem,
  });
})(this);
