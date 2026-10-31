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

  let state = null;
  let activeJob = null;
  let noteTimer = null;
  let checklistTimer = null;
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
    return doc && doc.body || documentNode(doc, "body");
  }

  function documentHead(doc) {
    return doc && doc.head || documentNode(doc, "head");
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
    setHidden(element, !message);
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
    let config = null;
    if (mode === "model") {
      config = await openAIConfig();
      if (!config) return;
    }
    activeJob = { status: "extracting", detail: mode === "model" ? "准备本机模型分析…" : "准备本地抽取式预读…" };
    showJob(activeJob);
    try {
      const result = await state.service.analyze(state.currentItem, Object.assign({
        attachmentID: state.currentAttachmentID,
        mode,
        onProgress(job) {
          activeJob = job;
          showJob(job);
        },
      }, config || {}));
      if (!state) return;
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

  function dialogShell(title) {
    const doc = state && state.document || mainDocument;
    const overlay = doc.createElementNS(XHTML_NS, "div");
    setClass(overlay, "rr-modal-overlay");
    const modal = doc.createElementNS(XHTML_NS, "section");
    setClass(modal, "rr-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", title);
    const heading = make("div", "rr-modal-head");
    heading.append(make("h2", null, title));
    const close = makeApiButton("关闭", "rr-icon-button", () => overlay.remove(), "关闭对话框");
    heading.append(close);
    modal.append(heading);
    overlay.append(modal);
    overlay.addEventListener("click", event => {
      if (event.target === overlay) overlay.remove();
    });
    documentBody(doc).append(overlay);
    return { overlay, modal };
  }

  function openAIConfig() {
    return new Promise(resolve => {
      const { overlay, modal } = dialogShell("AI 分析设置");
      const finish = value => {
        overlay.remove();
        resolve(value);
      };
      const endpoint = (state && state.document || mainDocument).createElementNS(XHTML_NS, "input");
      endpoint.setAttribute("type", "url");
      setValue(endpoint, "http://127.0.0.1:11434/v1/chat/completions");
      endpoint.setAttribute("autocomplete", "off");
      const model = (state && state.document || mainDocument).createElementNS(XHTML_NS, "input");
      model.setAttribute("type", "text");
      model.setAttribute("placeholder", "必须填写已安装或可用的模型");
      model.setAttribute("autocomplete", "off");
      const modelList = (state && state.document || mainDocument).createElementNS(XHTML_NS, "datalist");
      modelList.setAttribute("id", "rr-model-suggestions");
      for (const value of ["llama3.3", "qwen3", "mistral-small"]) {
        const option = (state && state.document || mainDocument).createElementNS(XHTML_NS, "option");
        setValue(option, value);
        modelList.append(option);
      }
      model.setAttribute("list", modelList.getAttribute("id"));
      const apiKey = (state && state.document || mainDocument).createElementNS(XHTML_NS, "input");
      apiKey.setAttribute("type", "password");
      apiKey.setAttribute("autocomplete", "off");
      apiKey.setAttribute("placeholder", "可选；仅保存在本次窗口内存");
      const remote = (state && state.document || mainDocument).createElementNS(XHTML_NS, "input");
      remote.setAttribute("type", "checkbox");
      const remoteRow = make("label", "rr-check rr-warning-check");
      remoteRow.append(remote, make("span", null,
        "我明确同意本次把所选 PDF 的有界原文片段发送到上面的非本机 HTTPS 服务，并自行确认服务商与数据用途。"));
      const warning = make("div", "rr-callout rr-warning");
      warning.textContent = "默认只访问本机端点。密钥不会写入偏好、项目、阅读状态或日志；关闭窗口后即清除。远程端点必须为 HTTPS，并勾选上方确认。";
      const actions = make("div", "rr-modal-actions");
      const cancel = makeApiButton("取消", "", () => finish(null));
      const run = makeApiButton("开始 AI 分析", "rr-button-primary", () => {
        if (!getValue(model).trim()) {
          setStatus(modalStatus, "请填写模型名称。", "error");
          model.focus();
          return;
        }
        let parsed;
        try { parsed = new URL(getValue(endpoint)); }
        catch (_) {
          setStatus(modalStatus, "端点不是有效的 HTTP(S) 地址。", "error");
          return;
        }
        const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase());
        if (!local && (!getChecked(remote) || parsed.protocol !== "https:")) {
          setStatus(modalStatus, "远程端点必须使用 HTTPS，并勾选明确同意。", "error");
          return;
        }
        finish({
          endpoint: getValue(endpoint).trim(),
          model: getValue(model).trim(),
          apiKey: getValue(apiKey) || undefined,
          allowRemote: getChecked(remote) && !local,
        });
      });
      const modalStatus = make("div", "rr-message");
      setHidden(modalStatus, true);
      actions.append(cancel, run);
      modal.append(
        makeField("模型端点", endpoint),
        makeField("模型名称", model),
        modelList,
        makeField("API 密钥（仅本次内存）", apiKey),
        remoteRow,
        warning,
        modalStatus,
        actions,
      );
      endpoint.addEventListener("input", () => {
        try {
          const parsed = new URL(getValue(endpoint));
          setHidden(remoteRow, ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase()));
        }
        catch (_) {
          setHidden(remoteRow, false);
        }
      });
      endpoint.dispatchEvent(new (state.window.Event || Event)("input"));
      model.focus();
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
      make("p", null, "“抽取式预读”不联网；AI 分析只有在设置对话框明确提交后才会调用所选端点。"),
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
