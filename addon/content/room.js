/* global ChromeUtils, IOUtils, Services, Zotero */
(function (scope) {
  "use strict";

  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const PAGE_SIZE = 80;
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
  const PROMPT_SYSTEM_LIMIT = 40000;
  const PROMPT_SYNTHESIS_LIMIT = 4000;
  const MAX_BATCH_TARGETS = 1000;
  const BATCH_STATUS_LABELS = Object.freeze({
    queued: "等待",
    running: "分析中",
    reused: "复用缓存",
    succeeded: "已完成",
    failed: "失败",
    cancelled: "已取消",
  });
  const FALLBACK_API_PROVIDERS = Object.freeze([
    { id: "openai", label: "OpenAI 兼容 API", defaultEndpoint: OPENAI_LEGACY_ENDPOINT, endpointHint: "可填写 base URL，或旧的完整 chat completions 地址。" },
    { id: "anthropic", label: "Anthropic Messages API", defaultEndpoint: "https://api.anthropic.com/v1", endpointHint: "填写 Anthropic API base URL。" },
    { id: "gemini", label: "Google Gemini API", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", endpointHint: "填写 Gemini API base URL。" },
    { id: "ollama", label: "Ollama API", defaultEndpoint: "http://127.0.0.1:11434", endpointHint: "填写本机 Ollama API 地址。" },
  ]);

  let state = null;
  let activeJob = null;
  let activeBatch = null;
  let noteTimer = null;
  let checklistTimer = null;
  let notesDirty = false;
  let checklistDirty = false;
  let searchTimer = null;
  let aiConfigSession = null;
  let dialogSequence = 0;
  let loadGeneration = 0;
  let catalogGeneration = 0;
  let collectionsGeneration = 0;
  let selectionGeneration = 0;
  let started = false;
  let choiceSequence = 0;
  let pdfResizeTimer = null;
  let chatController = null;
  let chatGeneration = 0;
  let ownsShutdown = false;
  const choiceBindings = new WeakMap();
  const choiceInstances = new Set();
  const mainWindow = scope.window;
  const mainDocument = scope.document;

  function documentNode(doc, name) {
    return doc && typeof doc.getElementsByTagNameNS === "function"
      ? doc.getElementsByTagNameNS(XHTML_NS, name)[0] || null : null;
  }
  function documentBody(doc) { return documentNode(doc, "body"); }
  function documentHead(doc) { return documentNode(doc, "head"); }
  function currentDocument() { return state && state.document || mainDocument; }
  function isEmbedded() {
    return !!(state && state.nativeContext && state.nativeContext.embedded === true);
  }
  function setClass(element, className) { element.setAttribute("class", className || ""); }
  function setHidden(element, hidden) {
    if (!element) return;
    if (hidden) element.setAttribute("hidden", "hidden");
    else element.removeAttribute("hidden");
  }
  function setBooleanAttribute(element, name, value) {
    if (value) element.setAttribute(name, name);
    else element.removeAttribute(name);
    if (typeof element[name] === "boolean") element[name] = !!value;
    if (name === "disabled") {
      const binding = choiceBindings.get(element);
      if (binding) binding.syncDisabled(!!value);
    }
  }
  function setValue(element, value) {
    const text = String(value == null ? "" : value);
    element.setAttribute("value", text);
    if (typeof element.value === "string") element.value = text;
    const binding = choiceBindings.get(element);
    if (binding) binding.syncSelection(text);
  }
  function getValue(element) {
    return typeof element.value === "string"
      ? element.value : element.getAttribute("value") || "";
  }
  function setChecked(element, checked) {
    setBooleanAttribute(element, "checked", checked);
  }
  function getChecked(element) {
    return typeof element.checked === "boolean"
      ? element.checked : element.hasAttribute("checked");
  }
  function optionEntries(element) {
    return Array.from(element.children || []).filter(
      child => child && child.localName === "option",
    );
  }
  function dispatchChange(element) {
    const EventClass = element.ownerDocument?.defaultView?.Event
      || state?.window?.Event;
    if (typeof EventClass === "function") {
      element.dispatchEvent(new EventClass("change", { bubbles: true }));
      return;
    }
    const event = {
      type: "change",
      target: element,
      currentTarget: element,
      preventDefault() {},
      stopPropagation() {},
    };
    if (typeof element.dispatchEvent === "function") {
      element.dispatchEvent(event);
    }
    else if (typeof element.onchange === "function") {
      element.onchange(event);
    }
  }
  function syncChoiceOptions(binding) {
    const { select, trigger, label, menu } = binding;
    const entries = optionEntries(select);
    if (!entries.some(entry => getValue(entry) === getValue(select))
        && entries.length) {
      const firstEnabled = entries.find(entry =>
        !entry.hasAttribute("disabled"));
      if (firstEnabled) setValue(select, getValue(firstEnabled));
    }
    let selectedLabel = "";
    menu.replaceChildren();
   binding.items = [];
    for (const option of entries) {
      const value = getValue(option);
      const disabled = option.hasAttribute("disabled");
      const item = make("button", "rr-choice-option", option.textContent);
      item.setAttribute("type", "button");
      item.setAttribute("role", "option");
      item.setAttribute("tabindex", "-1");
      item.setAttribute("aria-selected", String(value === getValue(select)));
      setBooleanAttribute(item, "disabled", disabled);
      if (value === getValue(select)) selectedLabel = option.textContent;
      item.addEventListener("click", () => {
        if (disabled || binding.closed) return;
        selectChoice(binding, value, true);
      });
      menu.append(item);
     binding.items.push({ item, value, disabled });
    }
    label.textContent = selectedLabel || "请选择";
    binding.open = false;
    setClass(binding.root, binding.baseClass);
    trigger.setAttribute("aria-expanded", "false");
    setHidden(menu, true);
    binding.activeIndex = Math.max(
      0, binding.items.findIndex(entry =>
        !entry.disabled && entry.value === getValue(select)),
    );
  }
  function openChoice(binding) {
    if (binding.disabled || binding.open) return;
    binding.open = true;
    setClass(binding.root, binding.baseClass + " open");
    binding.trigger.setAttribute("aria-expanded", "true");
    setHidden(binding.menu, false);
    binding.activeIndex = Math.max(
      0, binding.items.findIndex(entry =>
        !entry.disabled && entry.value === getValue(binding.select)),
    );
    setActiveChoice(binding, binding.activeIndex);
   binding.items[binding.activeIndex]?.item.focus();
  }
  function closeChoice(binding, restoreFocus = false) {
    if (!binding.open) return;
    binding.open = false;
    setClass(binding.root, binding.baseClass);
    binding.trigger.setAttribute("aria-expanded", "false");
    setHidden(binding.menu, true);
   binding.items.forEach(entry =>
     entry.item.setAttribute("aria-selected",
       String(entry.value === getValue(binding.select))));
   if (restoreFocus) binding.trigger.focus();
 }
  function setActiveChoice(binding, index) {
    if (!binding.items.length) return;
    let next = Math.max(0, Math.min(binding.items.length - 1, index));
    const direction = next >= binding.activeIndex ? 1 : -1;
    for (let attempts = 0;
      attempts < binding.items.length
      && binding.items[next].disabled;
      attempts++) {
      next += direction;
      if (next < 0) next = binding.items.length - 1;
      if (next >= binding.items.length) next = 0;
    }
    binding.activeIndex = next;
    binding.items.forEach((entry, itemIndex) => {
      entry.item.setAttribute("tabindex", itemIndex === next ? "0" : "-1");
    });
    binding.items[next].item.focus?.();
  }
  function selectChoice(binding, value, announce = false) {
    const option = binding.items.find(entry =>
      !entry.disabled && entry.value === String(value));
    if (!option) return;
    setValue(binding.select, option.value);
    closeChoice(binding, true);
    if (announce) dispatchChange(binding.select);
  }
  function makeChoice(select, { label = "选择", className = "" } = {}) {
    const id = `rr-choice-${++choiceSequence}`;
    const root = make("div", "rr-choice " + className);
    const trigger = make("button", "rr-choice-trigger");
    trigger.setAttribute("type", "button");
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    trigger.setAttribute("aria-controls", `${id}-menu`);
    trigger.setAttribute("aria-label", label);
    const selectedLabel = make("span", "rr-choice-label");
    trigger.append(selectedLabel, make("span", "rr-choice-caret", "⌄"));
    const menu = make("div", "rr-choice-menu");
    menu.setAttribute("id", `${id}-menu`);
    menu.setAttribute("role", "listbox");
    setHidden(menu, true);
    root.append(trigger, menu);
    select.setAttribute("hidden", "hidden");
    setClass(select, "rr-choice-native");
    root.append(select);
    const binding = {
      baseClass: "rr-choice " + className,
      id, root, trigger, menu, select, label: selectedLabel,
      items: [], open: false, disabled: false, activeIndex: 0,
      syncSelection(value) {
        const entries = optionEntries(select);
        let matched = entries.find(entry => getValue(entry) === String(value));
        if (!matched && entries.length) {
          matched = entries.find(entry => !entry.hasAttribute("disabled"));
          if (matched) {
            select.setAttribute("value", getValue(matched));
            if (typeof select.value === "string") {
              select.value = getValue(matched);
            }
          }
        }
        selectedLabel.textContent = matched ? matched.textContent : "请选择";
        for (const entry of binding.items) {
          entry.item.setAttribute("aria-selected",
            String(entry.value === getValue(select)));
        }
      },
      syncDisabled(value) {
        binding.disabled = value;
        trigger.disabled = value;
        if (value) closeChoice(binding);
      },
      syncOptions() { syncChoiceOptions(binding); },
      close(restoreFocus = false) { closeChoice(binding, restoreFocus); },
      contains(node) { return root.contains?.(node) || false; },
    };
    choiceBindings.set(select, binding);
    choiceInstances.add(binding);
    trigger.addEventListener("click", () => {
      closeOpenChoices(binding);
      if (binding.open) closeChoice(binding, true);
      else openChoice(binding);
    });
    trigger.addEventListener("keydown", event => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        openChoice(binding);
      }
    });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeChoice(binding, true);
      }
      else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActiveChoice(
          binding,
          binding.activeIndex + (event.key === "ArrowDown" ? 1 : -1),
        );
      }
      else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        setActiveChoice(
          binding, event.key === "Home" ? 0 : binding.items.length - 1,
        );
      }
      else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        const entry = binding.items[binding.activeIndex];
        if (entry && !entry.disabled) selectChoice(binding, entry.value, true);
      }
      else if (event.key === "Tab") closeChoice(binding);
    });
    select.addEventListener("change", () => {
      binding.syncSelection(getValue(select));
    });
    binding.syncSelection(getValue(select));
    binding.syncOptions();
    binding.syncSelection(getValue(select));
    binding.syncDisabled(select.hasAttribute("disabled"));
    return { root, trigger, menu, select, binding };
  }
   function closeOpenChoices(except = null) {
    for (const binding of choiceInstances) {
      if (binding !== except && binding.open) binding.close(false);
    }
  }
  function disposeChoices(container) {
    for (const binding of [...choiceInstances]) {
      if (container && !container.contains?.(binding.root)) continue;
      binding.close(false);
      binding.closed = true;
      choiceInstances.delete(binding);
      choiceBindings.delete(binding.select);
    }
  }
  function bindChoiceOutsideDismiss() {
    const doc = currentDocument();
    if (!doc || typeof doc.addEventListener !== "function"
        || doc.__readingRoomChoiceOutsideBound) return;
    doc.__readingRoomChoiceOutsideBound = true;
    doc.addEventListener("click", event => {
      const target = event && event.target;
      for (const binding of choiceInstances) {
        if (!binding.open) continue;
        const inside = target === binding.root
          || (target && typeof binding.root.contains === "function"
            && binding.root.contains(target));
        if (!inside) binding.close(false);
      }
    });
  }
  function make(tag, className, text) {
    const element = currentDocument().createElementNS(XHTML_NS, tag);
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
    return Number.isFinite(number)
      ? Math.max(0, Math.min(100, Math.round(number * 100))) : 0;
  }
  function batchIsRunning() {
    return !!activeBatch
      || !!(state && state.batchState
        && state.batchState.status === "running");
  }
  function paperSelectionKey(paper) {
    if (!paper) return "";
    const libraryID = Number(paper.libraryID);
    const key = String(paper.key || "");
    if (Number.isSafeInteger(libraryID) && libraryID > 0 && key) {
      return `${libraryID}:${key}`;
    }
    const id = Number(paper.id);
    return Number.isSafeInteger(id) && id > 0 ? `id:${id}` : "";
  }
  function selectedPapers() {
    return state && state.selectedPapers
      ? [...state.selectedPapers.values()] : [];
  }
  function selectedPaper(paper) {
    return state && state.selectedPapers
      ? state.selectedPapers.get(paperSelectionKey(paper)) || null : null;
  }
  function rememberSelectedPaper(paper) {
    if (!state || !state.selectedPapers || !paper) return false;
    const key = paperSelectionKey(paper);
    const itemID = Number(paper.id);
    if (!key || !Number.isSafeInteger(itemID) || itemID < 1) return false;
    if (state.selectedPapers.has(key)) return false;
    if (state.selectedPapers.size >= MAX_BATCH_TARGETS) return false;
    state.selectedPapers.set(key, {
      id: itemID,
      itemID,
      libraryID: Number(paper.libraryID),
      key: String(paper.key || ""),
      title: String(paper.title || "未命名文献"),
    });
    return true;
  }
  function forgetSelectedPaper(paper) {
    if (!state || !state.selectedPapers) return false;
    return state.selectedPapers.delete(paperSelectionKey(paper));
  }
  function updateSelectionControls() {
    if (!state || !state.selectionCount) return;
    const count = state.selectedPapers.size;
    state.selectionCount.textContent = `已选 ${count} 篇`;
    setBooleanAttribute(state.batchButton, "disabled",
      count < 1 || batchIsRunning());
    setBooleanAttribute(state.selectPageButton, "disabled",
      batchIsRunning() || state.catalogLoading
      || !state.catalog.items.length);
    setBooleanAttribute(state.clearSelectionButton, "disabled",
      batchIsRunning() || count < 1);
    setBooleanAttribute(state.addFilteredButton, "disabled",
      batchIsRunning() || state.catalogLoading || state.selectionLoading);
    state.addFilteredButton.textContent = state.selectionLoading
      ? "正在收集…" : "加入当前筛选全部";
  }
  function selectionStatus(message, kind) {
    if (state) setStatus(state.selectionStatus, message, kind);
  }
  function syncActionLocks() {
    if (!state) return;
    const locked = !!state.analyzing || batchIsRunning();
    setBooleanAttribute(state.aiButton, "disabled",
      locked || !state.currentItem);
    setBooleanAttribute(state.reanalyzeButton, "disabled",
      locked || !state.currentItem);
    setBooleanAttribute(state.modelButton, "disabled", locked);
    setBooleanAttribute(state.promptButton, "disabled", locked);
    setBooleanAttribute(state.chatSendButton, "disabled",
      locked || !!state.chatLoading || !state.currentItem);
    setBooleanAttribute(state.chatCancelButton, "disabled",
      !state.chatLoading);
    setBooleanAttribute(state.chatInput, "disabled",
      locked || !!state.chatLoading);
    updateSelectionControls();
  }
  function batchCountsText(batch) {
    const counts = batch && batch.counts || {};
    return [
      `共 ${Number(counts.total) || 0}`,
      `等待 ${Number(counts.queued) || 0}`,
      `运行 ${Number(counts.running) || 0}`,
      `复用 ${Number(counts.reused) || 0}`,
      `完成 ${Number(counts.succeeded) || 0}`,
      `失败 ${Number(counts.failed) || 0}`,
      `取消 ${Number(counts.cancelled) || 0}`,
    ].join(" · ");
  }
  function batchEntryIdentity(entry) {
    if (!entry) return "";
    return `${Number(entry.libraryID) || 0}:${String(entry.key || entry.itemID || "")}`;
  }
  function refreshCatalogAnalysis(itemID) {
    if (!state) return;
    const id = Number(itemID);
    for (const paper of state.catalog.items) {
      if (Number(paper.id) === id) paper.hasAnalysis = true;
    }
    renderCatalog();
  }
  function refreshCurrentAnalysis(itemID) {
    if (!state || !state.currentItem
        || Number(state.currentItem.id) !== Number(itemID)) return;
    try {
      const reading = state.service.getState(state.currentItem);
      if (state.description) state.description.state = reading;
      renderAnalysis(reading.analysis);
      setBooleanAttribute(state.noteButton, "disabled",
        !reading.analysis || reading.analysis.mode !== "model");
    }
    catch (error) {
      logError("refresh batch analysis for current paper", error);
    }
  }
  function applyBatchState(next) {
    if (!state || !next || typeof next !== "object") return;
    const previous = state.batchState || { entries: [] };
    const previousEntries = new Map(
      (previous.entries || []).map(entry => [batchEntryIdentity(entry), entry]),
    );
    const sameRun = previous.id && previous.id === next.id;
    state.batchState = next;
    for (const entry of next.entries || []) {
      if (!["reused", "succeeded"].includes(entry.status)) continue;
      const prior = previousEntries.get(batchEntryIdentity(entry));
      if (sameRun && prior
          && ["reused", "succeeded"].includes(prior.status)) continue;
      refreshCatalogAnalysis(entry.itemID);
      refreshCurrentAnalysis(entry.itemID);
    }
    renderBatchMonitor();
    syncActionLocks();
    if (state.batchDialog && typeof state.batchDialog.render === "function") {
      state.batchDialog.render();
    }
  }
  function handleBatchProgress(next) {
    applyBatchState(next);
    if (!state) return;
    if (state.batchState.status === "completed") {
      setStatus(state.globalStatus,
        "批量分析已完成；每篇成功结果均已自动保存。", "success");
    }
    else if (state.batchState.status === "cancelled") {
      setStatus(state.globalStatus,
        "批量分析已取消；已完成的结果已保留。", "warning");
    }
  }
  function renderBatchMonitor() {
    if (!state || !state.batchMonitor) return;
    const monitor = state.batchMonitor;
    monitor.replaceChildren();
    const batch = state.batchState;
    if (!batch || !Array.isArray(batch.entries) || !batch.entries.length
        || batch.status === "idle") {
      setHidden(monitor, true);
      return;
    }
    setHidden(monitor, false);
    const copy = make("div", "rr-batch-monitor-copy");
    copy.append(
      make("strong", null,
        batch.status === "running" ? "批量分析进行中"
          : batch.status === "cancelled" ? "批量分析已取消" : "批量分析已完成"),
      make("span", null, batchCountsText(batch)),
    );
    const actions = make("div", "rr-batch-monitor-actions");
    if (batch.status === "running") {
      actions.append(makeApiButton("取消批次", "rr-danger", () => {
        try {
          const cancelled = state.service.cancelBatch();
          setStatus(state.globalStatus,
            cancelled ? "正在取消当前批次…" : "当前没有可取消的批次。",
            cancelled ? "pending" : "warning");
        }
        catch (error) {
          setStatus(state.globalStatus, safeError(error).message, "error");
        }
      }));
    }
    const failed = (batch.entries || []).filter(entry =>
      entry.status === "failed");
    if (failed.length && !batchIsRunning()) {
      actions.append(makeApiButton(`重试 ${failed.length} 篇失败项`,
        "rr-secondary", () => void openBatchReview({
          targets: failed.map(entry => ({
            id: entry.itemID,
            itemID: entry.itemID,
            libraryID: entry.libraryID,
            key: entry.key,
            title: entry.title,
          })),
          title: "重试失败论文",
        })));
    }
    actions.append(makeApiButton("查看队列", "rr-link-button",
      () => void openBatchReview({ targets: [], title: "批量分析状态" })));
    monitor.append(copy, actions);
  }
  function checkedCount(checklist) {
    return CHECKLIST.reduce(
      (total, [id]) => total + (checklist && checklist[id] ? 1 : 0), 0,
    );
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
      ? Core.API_PROVIDERS : FALLBACK_API_PROVIDERS;
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
    return providers.length
      ? providers : FALLBACK_API_PROVIDERS.map(provider => ({ ...provider }));
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
        || endpoint.username || endpoint.password
        || endpoint.search || endpoint.hash) {
      return {
        ok: false,
        error: "端点仅允许无内嵌凭据、查询参数和片段的 HTTP(S) 地址。",
      };
    }
    const local = isLoopbackHost(endpoint.hostname);
    if (!local && endpoint.protocol !== "https:") {
      return {
        ok: false, local, origin: endpoint.origin,
        error: "远程端点必须使用 HTTPS。",
      };
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
    return `自动获取模型列表失败：${String(error && error.message || "未知错误")}。可手工填写模型名称。`;
  }

  function show(options = {}) {
    return scope.ReadingRoomNativeSidebarInstance
      ? scope.ReadingRoomNativeSidebarInstance.show(options || {}) : null;
  }
  function mountWindow(win, itemID, context) {
    if (win.ReadingRoomWindow && win.ReadingRoomWindow._started) {
      if (context && win.ReadingRoomWindow.updateContext) {
        win.ReadingRoomWindow.updateContext(context);
      }
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
      start({ window: win, document: doc, itemID, nativeContext: context });
    };
    attach();
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
      nativeContext: options.nativeContext || null,
    };
    started = true;
    ownsShutdown = options.ownsHost !== false;
    for (const win of Zotero.getMainWindows()) {
      onMainWindowLoad({ window: win });
    }
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
    if (!ownsShutdown) {
      if (state && state.window) {
        const view = state;
        try { await flushPendingEdits(); }
        catch (_) {}
        await view.dispose?.();
      }
      return;
    }
    await disposeRuntime();
  }
  function makeApiButton(label, className, action, title) {
    const element = currentDocument().createElementNS(XHTML_NS, "button");
    element.setAttribute("type", "button");
    setClass(element, "rr-button " + (className || ""));
    element.textContent = label;
    if (title) element.setAttribute("title", title);
    element.addEventListener("click", action);
    return element;
  }
  function makeField(label, input) {
    const field = currentDocument().createElementNS(XHTML_NS, "label");
    setClass(field, "rr-field");
    const caption = currentDocument().createElementNS(XHTML_NS, "span");
    setClass(caption, "rr-field-label");
    caption.textContent = label;
    field.append(caption, input);
    return field;
  }
  function statusPill(status) {
    const element = currentDocument().createElementNS(XHTML_NS, "span");
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
      row.append(
        make("span", "rr-meta-label", label),
        make("span", "rr-meta-value", value),
      );
      grid.append(row);
    }
    return grid;
  }
  function renderCatalog() {
    if (!state) return;
    const list = state.paperList;
    list.replaceChildren();
    renderCatalogScope();
    if (state.catalogLoading) {
      list.append(make("div", "rr-catalog-empty", "正在读取当前范围…"));
      return;
    }
    if (!state.catalog.items.length) {
      list.append(make("div", "rr-catalog-empty",
        state.catalog.query ? "没有匹配的论文。" : "当前范围没有论文。"));
      return;
    }
    for (const paper of state.catalog.items) {
      const row = make("article",
        "rr-paper-row" + (paper.focused ? " focused" : "")
          + (selectedPaper(paper) ? " selected" : ""));
      const select = currentDocument().createElementNS(
        XHTML_NS, "input",
      );
      select.setAttribute("type", "checkbox");
      select.setAttribute("class", "rr-paper-select");
      select.setAttribute("aria-label", `选择 ${paper.title || "未命名文献"} 批量分析`);
      setBooleanAttribute(select, "disabled", batchIsRunning());
      setChecked(select, !!selectedPaper(paper));
      select.addEventListener("change", () => {
        if (getChecked(select)) {
          if (!rememberSelectedPaper(paper)) {
            setChecked(select, false);
            selectionStatus(state.selectedPapers.size >= MAX_BATCH_TARGETS
              ? `批量选择最多 ${MAX_BATCH_TARGETS} 篇。`
              : "无法记录此论文的稳定标识。", "error");
          }
        }
        else forgetSelectedPaper(paper);
        setClass(row, "rr-paper-row"
          + (paper.focused ? " focused" : "")
          + (selectedPaper(paper) ? " selected" : ""));
        updateSelectionControls();
      });
      const open = make("button", "rr-paper-open");
      open.setAttribute("type", "button");
      open.append(
        make("strong", null, paper.title || "未命名文献"),
        make("span", "rr-paper-meta",
          [paper.year, (paper.creators || []).slice(0, 2).join("、"),
            paper.venue].filter(Boolean).join(" · ") || "元数据尚未完整"),
      );
      const badges = make("span", "rr-paper-badges");
      badges.append(statusPill(paper.status));
      if (paper.hasAnalysis) {
        badges.append(make("span", "rr-cache-badge", "AI 已存"));
      }
      const batchEntry = state.batchState
        && Array.isArray(state.batchState.entries)
        ? state.batchState.entries.find(entry =>
          Number(entry.itemID) === Number(paper.id)) : null;
      if (batchEntry && BATCH_STATUS_LABELS[batchEntry.status]) {
        badges.append(make("span",
          "rr-batch-badge rr-batch-" + batchEntry.status,
          BATCH_STATUS_LABELS[batchEntry.status]));
      }
      open.append(badges);
      open.addEventListener("click", () => void selectPaper(paper));
      const focus = makeApiButton(paper.focused ? "★" : "☆",
        "rr-focus-button" + (paper.focused ? " active" : ""),
        () => void toggleFocused(paper),
        paper.focused ? "取消关注" : "关注此论文");
      focus.setAttribute("aria-pressed", String(paper.focused));
      focus.setAttribute("aria-label",
        paper.focused ? "取消关注" : "关注此论文");
      row.append(select, open, focus);
      list.append(row);
    }
    updateSelectionControls();
  }
  function renderFocusedChips() {
    if (!state) return;
    const container = state.focusedChips;
    container.replaceChildren();
    if (!state.focusedPapers.length) {
      container.append(make("span", "rr-chip-empty",
        "关注论文后会显示在这里，便于切换对比。"));
      return;
    }
    for (const paper of state.focusedPapers) {
      const chip = make("button",
        "rr-focus-chip" + (state.currentPaper
          && state.currentPaper.id === paper.id
          && state.currentPaper.libraryID === paper.libraryID
          ? " active" : ""),
        paper.title || "未命名文献");
      chip.setAttribute("type", "button");
      chip.addEventListener("click", () => void selectPaper(paper));
      container.append(chip);
    }
  }
  function catalogScope() {
    const libraryValue = getValue(state.librarySelect);
    const collectionValue = getValue(state.collectionSelect);
    return {
      libraryID: libraryValue ? Number(libraryValue) : null,
      collectionID: collectionValue ? Number(collectionValue) : null,
    };
  }
  function renderCatalogScope() {
    if (!state) return;
    const libraryID = getValue(state.librarySelect)
      ? Number(getValue(state.librarySelect)) : null;
    const collectionID = getValue(state.collectionSelect)
      ? Number(getValue(state.collectionSelect)) : null;
    const library = state.libraries.find(entry => entry.id === libraryID);
    const collection = state.collections.find(entry =>
      entry.id === collectionID && entry.libraryID === libraryID);
    let path = "全部可访问文库";
    if (collection) {
      const names = [];
      const seen = new Set();
      let current = collection;
      while (current && !seen.has(current.id)) {
        seen.add(current.id);
        names.unshift(current.name || "未命名收藏夹");
        current = state.collections.find(entry =>
          entry.id === current.parentID
          && entry.libraryID === current.libraryID);
      }
      path = `${library ? library.name : "文库"} / ${names.join(" / ")}`;
    }
    else if (library) {
      path = `${library.name} / 全部论文`;
    }
    state.catalogScope.textContent = path;
    state.catalogScope.setAttribute("title", path);
  }
  function compareCollectionNames(left, right) {
    return String(left.name || "").localeCompare(
      String(right.name || ""), undefined,
      { numeric: true, sensitivity: "base" },
    ) || Number(left.id) - Number(right.id);
  }
  function renderCollectionTree() {
    if (!state) return;
    const tree = state.collectionTree;
    tree.replaceChildren();
    const byParent = new Map();
    const collectionIDs = new Set(state.collections.map(entry => entry.id));
    for (const collection of state.collections) {
      const parent = collection.parentID != null
        && collectionIDs.has(collection.parentID)
        && collection.parentID !== collection.id
        ? collection.parentID : null;
      const rows = byParent.get(parent) || [];
      rows.push(collection);
      byParent.set(parent, rows);
    }
    for (const rows of byParent.values()) rows.sort(compareCollectionNames);
    const selectedID = getValue(state.collectionSelect)
      ? Number(getValue(state.collectionSelect)) : null;
    const selectedLibraryID = getValue(state.librarySelect)
      ? Number(getValue(state.librarySelect)) : null;
    let selectedButton = null;
    const visibleLibraries = state.libraries;
    if (!visibleLibraries.length && !state.collectionsLoading) {
      tree.append(make("p", "rr-tree-empty", "没有可访问的文库。"));
    }
    const addCollectionRows = (library, parentID, container, ancestors) => {
      const children = (byParent.get(parentID) || []).filter(
        collection => collection.libraryID === library.id);
      for (const collection of children) {
        if (ancestors.has(collection.id)) continue;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(collection.id);
        const childrenOfCollection = byParent.get(collection.id) || [];
        const row = make("div", "rr-tree-row");
        const expanded = state.expandedCollections.has(collection.id);
        const toggle = make("button", "rr-tree-toggle",
          childrenOfCollection.length ? (expanded ? "▾" : "▸") : "·");
        toggle.setAttribute("type", "button");
        toggle.setAttribute("aria-label",
          `${expanded ? "收起" : "展开"} ${collection.name || "未命名收藏夹"}`);
        toggle.setAttribute("aria-expanded",
          String(childrenOfCollection.length ? expanded : false));
        setBooleanAttribute(toggle, "disabled", !childrenOfCollection.length);
        if (childrenOfCollection.length) {
          toggle.addEventListener("click", () => {
            if (state.expandedCollections.has(collection.id)) {
              state.expandedCollections.delete(collection.id);
            }
            else state.expandedCollections.add(collection.id);
            renderCollectionTree();
          });
        }
        const button = make("button",
          "rr-tree-item" + (selectedID === collection.id ? " active" : ""),
          collection.name || "未命名收藏夹");
        button.setAttribute("type", "button");
        button.setAttribute("aria-current",
          selectedID === collection.id ? "true" : "false");
        if (selectedID === collection.id) selectedButton = button;
        button.addEventListener("click", () => {
          void selectCollection(collection);
        });
        row.append(toggle, button);
        container.append(row);
        if (childrenOfCollection.length && expanded) {
          const nested = make("div", "rr-tree-children");
          nested.setAttribute("role", "group");
          addCollectionRows(library, collection.id, nested, nextAncestors);
          container.append(nested);
        }
      }
    };
    for (const library of visibleLibraries) {
      const libraryCollections = state.collections.filter(
        entry => entry.libraryID === library.id,
      );
      const root = make("div", "rr-tree-library");
      const rootButton = make("button",
        "rr-tree-root" + (!selectedID
          && selectedLibraryID === library.id
          ? " active" : ""),
        library.name || "未命名文库");
      rootButton.setAttribute("type", "button");
      rootButton.setAttribute("aria-current",
        !selectedID && selectedLibraryID === library.id
          ? "true" : "false");
      if (!selectedID && selectedLibraryID === library.id) selectedButton = rootButton;
      rootButton.addEventListener("click", () => void selectLibrary(library));
      root.append(rootButton);
      if (libraryCollections.length) {
        const nested = make("div", "rr-tree-children");
        nested.setAttribute("role", "group");
        addCollectionRows(library, null, nested, new Set());
        root.append(nested);
      }
      else if (!state.collectionsLoading) {
        root.append(make("span", "rr-tree-empty", "无收藏夹"));
      }
      tree.append(root);
    }
    const selectionKey = `${selectedLibraryID || "all"}:${selectedID || "root"}`;
    if (state.treeSelectionKey !== selectionKey && selectedButton?.scrollIntoView) {
      state.treeSelectionKey = selectionKey;
      selectedButton.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    if (state.collectionsLoading) {
      tree.append(make("p", "rr-tree-empty", "正在读取收藏夹…"));
    }
    else if (state.collectionsError) {
      tree.append(make("p", "rr-tree-empty",
        `收藏夹读取失败：${state.collectionsError}`));
    }
  }
  async function loadCatalog({ preserveFocus = true } = {}) {
    if (!state) return;
    const generation = ++catalogGeneration;
    state.catalogLoading = true;
    renderCatalog();
    try {
      const { libraryID, collectionID } = catalogScope();
      const result = await state.service.listPapers({
        libraryID,
        collectionID,
        query: getValue(state.searchInput).trim(),
        focusOnly: state.catalog.focusOnly,
        offset: state.catalog.offset,
        limit: PAGE_SIZE,
      });
      if (!state || generation !== catalogGeneration) return;
      state.catalog = {
        items: Array.isArray(result.items) ? result.items : [],
        total: Number(result.total) || 0,
        offset: Number(result.offset) || 0,
        limit: Number(result.limit) || PAGE_SIZE,
        query: getValue(state.searchInput).trim(),
        focusOnly: state.catalog.focusOnly,
      };
      if (!preserveFocus) state.focusedPapers = [];
      renderCatalog();
      const total = state.catalog.total;
      state.catalogCount.textContent = total
        ? `${state.catalog.offset + 1}–${Math.min(state.catalog.offset + state.catalog.items.length, total)} / ${total}`
        : "0 篇";
      setBooleanAttribute(state.prevButton, "disabled",
        state.catalog.offset <= 0);
      setBooleanAttribute(state.nextButton, "disabled",
        state.catalog.offset + state.catalog.limit >= total);
      await loadFocusedPapers(generation);
    }
    catch (error) {
      if (state && generation === catalogGeneration) {
        state.catalog.items = [];
        state.catalog.total = 0;
        renderCatalog();
        setStatus(state.globalStatus,
          `论文目录读取失败：${safeError(error).message}`, "error");
      }
    }
    finally {
      if (state && generation === catalogGeneration) {
        state.catalogLoading = false;
        renderCatalog();
      }
    }
  }
  async function loadFocusedPapers(generation = catalogGeneration) {
    if (!state) return;
    try {
      const result = await state.service.listPapers({
        libraryID: null,
        collectionID: null,
        query: "", focusOnly: true, offset: 0, limit: 80,
      });
      if (!state || generation !== catalogGeneration) return;
      state.focusedPapers = Array.isArray(result.items) ? result.items : [];
      renderFocusedChips();
    }
    catch (error) {
      logError("load focused papers", error);
    }
  }
  async function toggleFocused(paper) {
    if (!state) return;
    try {
      const item = Zotero.Items.get(Number(paper.id));
      if (!item) throw new Error("无法读取该论文条目。");
      await state.service.setFocused(item, !paper.focused);
      paper.focused = !paper.focused;
      if (state.catalog.focusOnly && !paper.focused) {
        state.catalog.items = state.catalog.items.filter(
          entry => entry !== paper,
        );
        state.catalog.total = Math.max(0, state.catalog.total - 1);
      }
      renderCatalog();
      await loadFocusedPapers();
      setStatus(state.globalStatus,
        paper.focused ? "已关注此论文。" : "已取消关注。", "success");
    }
    catch (error) {
      setStatus(state.globalStatus, safeError(error).message, "error");
    }
  }
  function dimensionCard(dimension) {
    const card = make("section", "rr-dimension");
    const heading = make("div", "rr-dimension-head");
    heading.append(make("h3", null, dimension.label || dimension.id));
    heading.append(make("span", "rr-confidence",
      `置信度 ${dimension.confidence || "none"}`));
    card.append(heading);
    card.append(make("p", "rr-dimension-summary",
      dimension.summary || "信息不足"));
    const evidence = Array.isArray(dimension.evidence)
      ? dimension.evidence : [];
    if (evidence.length) {
      const list = make("div", "rr-evidence-list");
      for (const entry of evidence) list.append(evidenceBlock(entry));
      card.append(list);
    }
    if (Array.isArray(dimension.subtypes) && dimension.subtypes.length) {
      const subtypes = make("div", "rr-subtypes");
      for (const subtype of dimension.subtypes) {
        const detail = currentDocument().createElementNS(
          XHTML_NS, "details",
        );
        detail.append(make("summary", null,
          `${subtype.label} · ${subtype.confidence}`));
        detail.append(make("p", null, subtype.summary || "信息不足"));
        for (const entry of subtype.evidence || []) {
          detail.append(evidenceBlock(entry));
        }
        subtypes.append(detail);
      }
      card.append(subtypes);
    }
    return card;
  }
  function evidenceBlock(entry) {
    const block = make("div", "rr-evidence");
    const label = entry.quote
      ? `“${String(entry.quote).slice(0, 180)}${String(entry.quote).length > 180 ? "…" : ""}”`
      : "查看原文位置";
    const quote = makeApiButton(
      label,
      "rr-evidence-quote",
      () => void openEvidence(entry),
      "跳到原文对应页并尝试高亮引文",
    );
    quote.disabled = entry.pageIndex == null && !entry.quote;
    block.append(quote);
    const meta = make("div", "rr-evidence-meta");
    const page = entry.pageIndex == null
      ? "页码未确认" : `原文第 ${entry.pageIndex + 1} 页`;
    meta.append(make("span",
      entry.verified ? "rr-verified" : "rr-unverified",
      entry.verified ? "原文逐字匹配" : "未验证引文"));
    meta.append(make("span", null, page));
    if (entry.pageIndex != null) {
      meta.append(makeApiButton("原页预览", "rr-link-button",
        () => void openPagePreview(entry)));
    }
    block.append(meta);
    return block;
  }
  function chatEvidence(entry) {
    const block = make("div", "rr-chat-evidence");
    const label = String(entry.quote || "").trim();
    const button = makeApiButton(
      label
        ? `“${label.slice(0, 180)}${label.length > 180 ? "…" : ""}”`
        : "查看原文位置",
      "rr-evidence-quote",
      () => void openEvidence(entry),
      entry.verified
        ? "跳到当前原生 PDF 的对应页"
        : "此引文未通过逐字核验；仅提供页码导航",
    );
    button.disabled = entry.pageIndex == null;
    block.append(button);
    const meta = make("div", "rr-evidence-meta");
    meta.append(
      make("span",
        entry.verified ? "rr-verified" : "rr-unverified",
        entry.verified ? "本次原文逐字匹配" : "未核验"),
      make("span", null, entry.pageIndex == null
        ? "页码未确认" : `原文第 ${entry.pageIndex + 1} 页`),
    );
    block.append(meta);
    return block;
  }
  function renderChat(conversation) {
    if (!state) return;
    state.chatMessages.replaceChildren();
    const messages = Array.isArray(conversation && conversation.messages)
      ? conversation.messages : [];
    if (!messages.length) {
      const empty = make("div", "rr-chat-empty");
      empty.append(
        make("strong", null, "基于当前 PDF 提问"),
        make("p", null,
          "打开或切换论文不会调用模型。点击“发送”后，仅把问题与有界原文片段交给已配置模型；回答中的来源可跳转到当前原生 PDF。"),
      );
      state.chatMessages.append(empty);
      return;
    }
    for (const message of messages) {
      if (!message || !["user", "assistant"].includes(message.role)) continue;
      const article = make("article",
        `rr-chat-message ${message.role}`);
      const meta = make("div", "rr-chat-message-meta");
      meta.append(
        make("strong", null, message.role === "user" ? "你" : "阅读助手"),
        make("span", null, formatDate(message.createdAt)),
      );
      article.append(meta);
      article.append(make("div", "rr-chat-answer",
        String(message.content || "")));
      if (message.role === "assistant") {
        const notice = make("p",
          "rr-chat-verification "
            + (message.grounded ? "verified" : "unverified"),
          message.verificationNotice
            || (message.grounded
              ? "引文已与本次提交片段逐字匹配；仍需人工判断是否支持结论。"
              : "信息不足／未核验：没有与本次提交原文匹配的来源。"));
        article.append(notice);
        if (Array.isArray(message.evidence) && message.evidence.length) {
          const sources = make("div", "rr-chat-sources");
          sources.append(make("h3", null, "来源"));
          for (const evidence of message.evidence) {
            if (evidence) sources.append(chatEvidence(evidence));
          }
          article.append(sources);
        }
      }
      state.chatMessages.append(article);
    }
  }
  async function loadConversation(generation = loadGeneration) {
    if (!state || !state.currentItem) {
      renderChat(null);
      return;
    }
    const item = state.currentItem;
    const attachmentID = state.currentAttachmentID;
    try {
      const conversation = typeof state.service.getConversation === "function"
        ? await state.service.getConversation(item, { attachmentID })
        : null;
      if (!state || generation !== loadGeneration || state.currentItem !== item
          || state.currentAttachmentID !== attachmentID) return;
      renderChat(conversation);
    }
    catch (error) {
      if (!state || generation !== loadGeneration || state.currentItem !== item) return;
      renderChat(null);
      setStatus(state.chatStatus,
        `对话记录读取失败：${safeError(error).message}`, "error");
    }
  }
  function cancelOwnedChat() {
    if (!state || !state.currentItem || !state.chatLoading) return false;
    const item = state.currentItem;
    try {
      const cancelled = typeof state.service.cancelChat === "function"
        ? state.service.cancelChat(item) : false;
      try { chatController?.abort(); } catch (_) {}
      setStatus(state.chatStatus,
        cancelled ? "正在取消此篇论文的对话…" : "当前没有正在运行的对话。",
        cancelled ? "pending" : "warning");
      return cancelled;
    }
    catch (error) {
      setStatus(state.chatStatus, safeError(error).message, "error");
      return false;
    }
  }
  async function sendChat() {
    if (!state || !state.currentItem || state.chatLoading || !isEmbedded()) return;
    const question = getValue(state.chatInput).trim();
    if (!question) {
      setStatus(state.chatStatus, "请输入问题。", "error");
      state.chatInput.focus?.();
      return;
    }
    if (question.length > 6000) {
      setStatus(state.chatStatus,
        "问题不得超过 6000 字符。", "error");
      return;
    }
    if (typeof state.service.askPaper !== "function") {
      setStatus(state.chatStatus,
        "当前服务版本不提供论文对话。", "error");
      return;
    }
    const item = state.currentItem;
    const attachmentID = state.currentAttachmentID;
    const generation = ++chatGeneration;
    const Controller = state.window.AbortController || scope.AbortController;
    chatController = Controller ? new Controller() : null;
    state.chatLoading = true;
    setValue(state.chatInput, "");
    syncActionLocks();
    setStatus(state.chatStatus, "正在提取原文并生成回答…", "pending");
    try {
      const result = await state.service.askPaper(item, question, {
        attachmentID,
        signal: chatController && chatController.signal,
        onProgress(progress) {
          if (!state || generation !== chatGeneration || state.currentItem !== item) return;
          setStatus(state.chatStatus,
            String(progress && progress.detail || "正在生成回答…"),
            "pending");
        },
      });
      if (!state || generation !== chatGeneration || state.currentItem !== item) return;
      renderChat(result);
      setStatus(state.chatStatus,
        result && result.reply && result.reply.grounded
          ? "回答已保存；来源已与本次提交原文逐字匹配。"
          : "回答已保存；未找到可核验来源，请谨慎判断。",
        result && result.reply && result.reply.grounded ? "success" : "warning");
    }
    catch (error) {
      if (!state || generation !== chatGeneration || state.currentItem !== item) return;
      const safe = safeError(error);
      setStatus(state.chatStatus,
        safe.code === "CANCELLED"
          ? "对话已取消；此前保存的问答仍保留。"
          : safe.message,
        safe.code === "CANCELLED" ? "warning" : "error");
      await loadConversation(generation === chatGeneration ? loadGeneration : -1);
    }
    finally {
      if (generation === chatGeneration) {
        chatController = null;
        if (state && state.currentItem === item) {
          state.chatLoading = false;
          syncActionLocks();
        }
      }
    }
  }
  async function openEvidence(entry) {
    if (!state || !state.currentItem) return;
    if (entry.pageIndex == null && !entry.quote) {
      setStatus(state.aiStatus,
        "此引文没有可验证的页码；请从文献附件入口核对。", "warning");
      return;
    }
    try {
      const adapter = state.nativePDFAdapter;
      if (!adapter) throw new Error("当前原生 PDF 阅读标签页尚未就绪。");
      await adapter.navigate(entry.pageIndex);
      setStatus(state.aiStatus,
        entry.pageIndex == null
          ? "页码未确认；未执行跳转。"
          : `已跳到 Zotero 原生 PDF 第 ${entry.pageIndex + 1} 页。`,
        "success");
    }
    catch (error) {
      setStatus(state.aiStatus, safeError(error).message, "error");
    }
  }
  async function openPagePreview(entry) {
    if (!state || !state.nativePDFAdapter || entry.pageIndex == null) return;
    const adapter = state.nativePDFAdapter;
    const generation = loadGeneration;
    try {
      const dataURL = await adapter.previewPage(entry.pageIndex, 420);
      if (!state || generation !== loadGeneration
          || state.nativePDFAdapter !== adapter) return;
      openImageZoom(dataURL, entry);
    }
    catch (error) {
      if (!state || generation !== loadGeneration
          || state.nativePDFAdapter !== adapter) return;
      setStatus(state.aiStatus, safeError(error).message, "error");
    }
  }
  function narrativeSection(title, text, evidence) {
    const section = make("section", "rr-narrative");
    section.append(make("h3", null, title));
    const paragraphs = String(text || "")
      .split(/\n{2,}/).map(value => value.trim()).filter(Boolean);
    if (!paragraphs.length) {
      paragraphs.push("本次分析没有生成可靠的摘要。");
    }
    for (const paragraph of paragraphs) {
      section.append(make("p", null, paragraph));
    }
    if (Array.isArray(evidence) && evidence.length) {
      const evidenceRow = make("div", "rr-evidence-list compact");
      for (const entry of evidence.slice(0, 8)) {
        evidenceRow.append(evidenceBlock(entry));
      }
      section.append(evidenceRow);
    }
    return section;
  }
  function renderFigureCards(references) {
    const section = make("section", "rr-figure-section");
    section.append(
      make("h3", null, "论文图表"),
      make("p", "rr-muted",
        "从原文文字引用定位到页面；预览仅显示“图表所在原文页”，不冒充裁图或视觉识别。"),
    );
    if (!Array.isArray(references) || !references.length) {
      section.append(make("p", "rr-muted",
        "本次分析未发现可验证的图表文字引用。"));
      return section;
    }
    const grid = make("div", "rr-figure-grid");
    for (const reference of references.slice(0, 12)) {
      const card = make("article", "rr-figure-card");
      card.append(make("strong", null,
        reference.reference || (reference.kind === "table" ? "表格" : "图")));
      card.append(make("p", null,
        reference.explanation || "原文提到了此图表。"));
      const meta = make("div", "rr-evidence-meta");
      meta.append(make("span", null, reference.pageIndex == null
        ? "页码未确认" : `图表所在原文页 ${reference.pageIndex + 1}`));
      meta.append(make("span", "rr-unverified", "需人工核对"));
      card.append(meta);
      const preview = make("div", "rr-figure-preview");
      preview.append(make("span", "rr-muted",
        "预览将在需要时从本机 PDF 渲染。"));
      card.append(preview);
      const actions = make("div", "rr-figure-actions");
      const load = makeApiButton("加载原页", "rr-secondary",
        () => void renderFigurePreview(reference, preview));
      load.setAttribute("data-page-index",
        String(reference.pageIndex == null ? "" : reference.pageIndex));
      setBooleanAttribute(load, "disabled", reference.pageIndex == null);
      actions.append(load);
      if (reference.pageIndex != null) {
        actions.append(makeApiButton("跳回原文", "rr-link-button",
          () => void openEvidence(reference)));
      }
      card.append(actions);
      grid.append(card);
    }
    section.append(grid);
    return section;
  }
  async function renderFigurePreview(reference, container) {
    if (!state || !state.nativePDFAdapter
        || !Number.isInteger(reference.pageIndex)) return;
    const adapter = state.nativePDFAdapter;
    const generation = loadGeneration;
    try {
      container.replaceChildren(make("span", "rr-muted",
        "正在本机渲染原页…"));
      const dataURL = await adapter.previewPage(reference.pageIndex, 420);
      if (!state || generation !== loadGeneration
          || state.nativePDFAdapter !== adapter) return;
      const image = currentDocument().createElementNS(XHTML_NS, "img");
      image.setAttribute("src", dataURL);
      image.setAttribute("alt",
        `论文第 ${reference.pageIndex + 1} 页，图表所在原文页`);
      image.addEventListener("click",
        () => openImageZoom(dataURL, reference));
      container.replaceChildren(image);
    }
    catch (error) {
      if (!state || generation !== loadGeneration
          || state.nativePDFAdapter !== adapter) return;
      container.replaceChildren(make("span", "rr-unverified",
        safeError(error).message));
    }
  }
  function openImageZoom(dataURL, reference) {
    const shell = dialogShell("图表所在原文页", () => {});
    const image = currentDocument().createElementNS(XHTML_NS, "img");
    image.setAttribute("src", dataURL);
    image.setAttribute("alt", `论文第 ${reference.pageIndex + 1} 页`);
    setClass(image, "rr-image-zoom");
    const jump = makeApiButton("跳回原文", "rr-button-primary", () => {
      shell.close();
      void openEvidence(reference);
    });
    shell.modal.append(image, jump);
  }
  function renderAnalysis(analysis) {
    const target = state.aiResults;
    target.replaceChildren();
    if (!analysis) {
      const empty = make("div", "rr-empty");
      empty.append(make("strong", null, "尚未生成 AI 解读"));
      empty.append(make("p", null,
        "点击“AI 分析”才会提取论文文本并调用已保存的模型设置。切换论文不会自动发起模型请求。"));
      target.append(empty);
      return;
    }
    if (analysis.mode !== "model") {
      const archive = make("div", "rr-callout rr-warning");
      archive.textContent = "这是旧版抽取式存档，仅作历史记录展示；请点击“重新分析”生成完整 AI 解读。";
      target.append(archive);
      return;
    }
    const header = make("div", "rr-analysis-header");
    header.append(
      make("h2", null, "AI 解读"),
      make("span", "rr-mode-badge rr-model", "已保存 · 可直接复用"),
    );
    target.append(header);
    const source = make("div", "rr-analysis-source");
    source.append(
      make("span", null, `生成：${formatDate(analysis.createdAt)}`),
      make("span", null, `模型：${analysis.model || "未记录"}`),
      make("span", null, `协议：${analysis.provider || "未记录"}`),
    );
    if (analysis.promptHash) {
      source.append(make("span", "rr-prompt-provenance",
        `提示词：${String(analysis.promptHash).slice(0, 16)}…`));
    }
    if (analysis.promptSnapshot?.updatedAt) {
      source.append(make("span", null,
        `提示词保存：${formatDate(analysis.promptSnapshot.updatedAt)}`));
    }
    const coverage = analysis.coverage || {};
    source.append(make("span", null,
      `覆盖：${Number(coverage.analyzedCharacters || 0).toLocaleString()} / ${Number(coverage.extractedCharacters || 0).toLocaleString()} 字符 · ${percent(coverage.ratio)}%`));
    if (coverage.extractedPages != null) {
      source.append(make("span", null,
        `页：${coverage.extractedPages}${coverage.totalPages ? ` / ${coverage.totalPages}` : ""}`));
    }
    target.append(source);
    if (analysis.overview || analysis.readingGuide) {
      const narrative = make("div", "rr-narrative-grid");
      narrative.append(narrativeSection(
        "论文概览", analysis.overview, analysis.overviewEvidence,
      ));
      narrative.append(narrativeSection(
        "阅读路径", analysis.readingGuide, analysis.readingGuideEvidence,
      ));
      target.append(narrative);
    }
    const dimensions = new Map(
      (analysis.dimensions || []).map(d => [d.id, d]),
    );
    const grid = make("div", "rr-dimension-grid");
    for (const id of DIMENSION_IDS) {
      const dimension = dimensions.get(id);
      if (dimension) grid.append(dimensionCard(dimension));
    }
    target.append(grid);
    target.append(renderFigureCards(
      analysis.figureTableReferences || [],
    ));
    const limitations = Array.isArray(analysis.limitations)
      ? analysis.limitations : [];
    if (limitations.length) {
      const section = make("section", "rr-limitations");
      section.append(make("h3", null, "覆盖与核查限制"));
      const list = currentDocument().createElementNS(XHTML_NS, "ul");
      for (const limitation of limitations) {
        list.append(make("li", null, limitation));
      }
      section.append(list);
      target.append(section);
    }
  }
  function updateStatusPills(container, current) {
    container.replaceChildren();
    for (const [id, label] of Object.entries(STATUS_LABELS)) {
      const element = makeApiButton(label,
        "rr-status-choice" + (id === current ? " active" : ""),
        () => void changeStatus(id));
      element.setAttribute("data-status", id);
      container.append(element);
    }
  }
  async function changeStatus(status) {
    if (!state || !state.currentItem || state.saving) return;
    state.saving = true;
    try {
      const reading = await state.service.setState(
        state.currentItem, { status },
      );
      state.description.state = reading;
      updateStatusPills(state.statusChoices, reading.status);
      state.updated.textContent =
        `本地保存于 ${formatDate(reading.updatedAt)}`;
      const sync = reading && reading.tagSync;
      if (sync && sync.status === "synced") {
        setStatus(state.globalStatus,
          `阅读状态已保存，并同步为原生标签“${sync.tag}”。`,
          "success");
      }
      else if (sync) {
        setStatus(state.globalStatus,
          `${sync.message || "本地阅读状态已保存，但原生标签未同步。"} 点击状态可重试。`,
          "warning");
      }
      else {
        setStatus(state.globalStatus,
          `本地阅读状态已保存为“${STATUS_LABELS[status]}”；未收到原生标签同步结果。`,
          "warning");
      }
      refreshLibraries();
      void loadCatalog();
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
    notesDirty = true;
    setStatus(state.notesStatus, "正在等待自动保存…", "pending");
    if (noteTimer) clearTimeout(noteTimer);
    const item = state.currentItem;
    const text = getValue(state.notesInput);
    noteTimer = setTimeout(async () => {
      noteTimer = null;
      if (!state || state.currentItem !== item) return;
      try {
        const reading = await state.service.setState(item, { notes: text });
        if (!state || state.currentItem !== item) return;
        if (getValue(state.notesInput) === text) notesDirty = false;
        state.description.state = reading;
        state.updated.textContent =
          `本地保存于 ${formatDate(reading.updatedAt)}`;
        setStatus(state.notesStatus,
          "笔记已保存到本地插件存储。", "success");
      }
      catch (error) {
        setStatus(state.notesStatus, safeError(error).message, "error");
      }
    }, 700);
  }
  function scheduleChecklistSave(checklist) {
    if (!state || !state.currentItem) return;
    checklistDirty = true;
    setStatus(state.checklistStatus, "正在保存清单…", "pending");
    if (checklistTimer) clearTimeout(checklistTimer);
    const item = state.currentItem;
    checklistTimer = setTimeout(async () => {
      checklistTimer = null;
      if (!state || state.currentItem !== item) return;
      try {
        const reading = await state.service.setState(item, { checklist });
        if (!state || state.currentItem !== item) return;
        if (JSON.stringify(state.description.state.checklist || {}) === JSON.stringify(checklist)) checklistDirty = false;
        state.description.state = reading;
        setStatus(state.checklistStatus,
          `清单已保存：${checkedCount(checklist)}/${CHECKLIST.length}`,
          "success");
      }
      catch (error) {
        setStatus(state.checklistStatus,
          safeError(error).message, "error");
      }
    }, 350);
  }
  function renderChecklist(checklist) {
    state.checklist.replaceChildren();
    for (const [id, label] of CHECKLIST) {
      const wrapper = make("label", "rr-check");
      const input = currentDocument().createElementNS(XHTML_NS, "input");
      input.setAttribute("type", "checkbox");
      setChecked(input, !!(checklist && checklist[id]));
      input.addEventListener("change", () => {
        const next = Object.assign(
          {}, state.description.state.checklist || {},
        );
        next[id] = getChecked(input);
        state.description.state.checklist = next;
        scheduleChecklistSave(next);
      });
      wrapper.append(input, make("span", null, label));
      state.checklist.append(wrapper);
    }
  }
  async function flushPendingEdits() {
    if (!state) return;
    const view = state;
    const item = view.currentItem;
    const patch = {};
    if (item && view.description) {
      if (notesDirty || noteTimer) patch.notes = getValue(view.notesInput);
      if (checklistDirty || checklistTimer) patch.checklist = Object.assign({}, view.description.state.checklist || {});
    }
    if (noteTimer) clearTimeout(noteTimer);
    if (checklistTimer) clearTimeout(checklistTimer);
    noteTimer = checklistTimer = null;
    // Capture edits before the first await, including during the unload event.
    // Dirty flags survive a failed write so a second switch retries the save.
    if (item && Object.keys(patch).length) {
      const reading = await view.service.setState(item, patch);
      if (state === view && view.currentItem === item) {
        if (Object.hasOwn(patch, "notes") && getValue(view.notesInput) === patch.notes) notesDirty = false;
        if (Object.hasOwn(patch, "checklist") && JSON.stringify(view.description.state.checklist || {}) === JSON.stringify(patch.checklist)) checklistDirty = false;
        view.description.state = reading;
      }
    }
    if (typeof view.service.flush === "function") await view.service.flush();
  }
  function setBusy(busy) {
    if (!state) return;
    state.analyzing = busy;
    setHidden(state.cancelButton, !busy);
    setBooleanAttribute(state.noteButton, "disabled",
      !state.description || !state.description.state.analysis
      || state.description.state.analysis.mode !== "model");
    setBooleanAttribute(state.syncButton, "disabled",
      busy || !state.description);
    syncActionLocks();
  }
  function showJob(job) {
    if (!state) return;
    const current = job || { status: "idle" };
    if (["preparing", "extracting", "analyzing", "saving"]
      .includes(current.status)) {
      setBusy(true);
      setStatus(state.aiStatus,
        current.detail || "正在分析…", "pending");
    }
    else if (current.status === "error") {
      setBusy(false);
      setStatus(state.aiStatus,
        current.detail || "分析失败。", "error");
    }
    else if (current.status === "cancelled") {
      setBusy(false);
      setStatus(state.aiStatus,
        "分析已取消；此前保存的阅读状态与分析未改变。", "warning");
    }
    else if (current.status === "complete") {
      setBusy(false);
      setStatus(state.aiStatus,
        current.detail || "分析已保存到本地插件存储。", "success");
    }
    else {
      setBusy(false);
      setStatus(state.aiStatus, "", "");
    }
  }
  async function openModelSettings() {
    if (batchIsRunning()) {
      setStatus(state.globalStatus,
        "批量分析运行期间不能修改模型设置；请先取消当前批次。",
        "warning");
      return null;
    }
    return openAIConfig(state && state.currentItem);
  }
  async function runAnalysis({ force = false } = {}) {
    if (!state || !state.currentItem || state.analyzing) return;
    const targetItem = state.currentItem;
    activeJob = {
      status: "preparing",
      detail: force
        ? "正在准备重新分析…" : "正在检查已保存的 AI 解读…",
    };
    showJob(activeJob);
    try {
      const result = await state.service.analyze(targetItem, {
        attachmentID: state.currentAttachmentID,
        force: force === true,
        onProgress(job) {
          activeJob = job;
          if (state && state.currentItem === targetItem) showJob(job);
        },
      });
      if (!state || state.currentItem !== targetItem) return;
      state.description.state.analysis = result;
      renderAnalysis(result);
      setBusy(false);
      showJob({
        status: "complete",
        detail: force
          ? "新的 AI 解读已保存到本地。"
          : "已载入此论文保存的 AI 解读。",
      });
      void loadCatalog();
    }
    catch (error) {
      const safe = safeError(error);
      if (safe.code === "AI_CONFIG_REQUIRED"
          || safe.code === "AI_NOT_CONFIGURED") {
        showJob({
          status: "error",
          detail: "尚未配置 AI 模型。请点击“模型设置”，保存后可在这里直接分析。",
        });
      }
      else {
        showJob({
          status: safe.code === "CANCELLED" ? "cancelled" : "error",
          detail: safe.message,
        });
      }
    }
    finally {
      activeJob = null;
    }
  }
  function cancelAnalysis() {
    if (!state || !state.currentItem) return;
    try {
      const cancelled = state.service.cancelAnalysis(state.currentItem);
      setStatus(state.aiStatus,
        cancelled ? "正在取消…" : "当前没有可取消的分析任务。",
        cancelled ? "pending" : "warning");
    }
    catch (error) {
      setStatus(state.aiStatus, safeError(error).message, "error");
    }
  }
  function dialogShell(title, onClose) {
    const doc = currentDocument();
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
    const close = makeApiButton(
      "关闭",
      "rr-icon-button",
      () => closeDialog(),
      `关闭${title}`,
    );
    close.setAttribute("aria-label", `关闭${title}`);
    heading.append(close);
    modal.append(heading);
    overlay.append(modal);
    const onKeyDown = event => {
      if (event.key !== "Escape") return;
      const openChoice = [...choiceInstances].find(binding =>
        binding.open && binding.root.contains
        && binding.root.contains(event.target));
      if (openChoice) {
        event.preventDefault();
        event.stopPropagation();
        openChoice.close(true);
        return;
      }
      event.preventDefault();
      closeDialog();
    };
    const closeDialog = () => {
      if (closed) return;
      closed = true;
      disposeChoices(modal);
      overlay.removeEventListener("click", onOverlayClick);
      overlay.removeEventListener("keydown", onKeyDown, true);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (typeof onClose === "function") onClose();
    };
    const onOverlayClick = event => {
      if (event.target === overlay) closeDialog();
    };
    overlay.addEventListener("click", onOverlayClick);
    overlay.addEventListener("keydown", onKeyDown, true);
    body.append(overlay);
    return { overlay, modal, close: closeDialog };
  }
  function promptLengthLabel(textarea, limit) {
    return `${String(getValue(textarea) || "").length.toLocaleString()} / ${limit.toLocaleString()} 字符`;
  }
  async function openPromptSettings() {
    if (!state) return null;
    if (batchIsRunning()) {
      setStatus(state.globalStatus,
        "批量分析运行期间不能修改分析提示词；请先取消当前批次。",
        "warning");
      return null;
    }
    const shell = dialogShell("分析提示词", () => {});
    const { modal } = shell;
    const status = make("div", "rr-message");
    setHidden(status, true);
    const intro = make("div", "rr-callout");
    intro.textContent = "这里显示并保存分析和论文对话将要发送的完整系统提示词。保存或恢复默认不会调用模型；旧结果保持原样，新分析或新对话才使用当前提示词。结构化 JSON 字段与可核验原文证据仍由后端校验。";
    const system = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    system.setAttribute("rows", "15");
    system.setAttribute("spellcheck", "false");
    system.setAttribute("aria-label", "完整系统提示词");
    const synthesis = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    synthesis.setAttribute("rows", "5");
    synthesis.setAttribute("spellcheck", "false");
    synthesis.setAttribute("aria-label", "综合阶段指令");
    const chat = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    chat.setAttribute("rows", "8");
    chat.setAttribute("aria-label", "论文对话系统提示词");
    const systemCounter = make("span", "rr-field-help");
    const synthesisCounter = make("span", "rr-field-help");
    const chatCounter = make("span", "rr-field-help");
    const current = make("div", "rr-prompt-state");
    current.append(make("span", null, "正在读取当前提示词…"));
    const defaults = make("div", "rr-prompt-defaults");
    defaults.append(make("h3", null, "当前默认值（只读，预览为完整实际文本）"));
    const defaultSystem = make("pre", "rr-prompt-default");
    const defaultSynthesis = make("pre", "rr-prompt-default");
    const defaultChat = make("pre", "rr-prompt-default");
    defaults.append(
      make("span", "rr-field-label", "默认完整系统提示词"),
      defaultSystem,
      make("span", "rr-field-label", "默认综合阶段指令"),
      defaultSynthesis,
      make("span", "rr-field-label", "默认论文对话系统提示词"),
      defaultChat,
    );
    const updateCounters = () => {
      systemCounter.textContent = promptLengthLabel(
        system, PROMPT_SYSTEM_LIMIT,
      );
      synthesisCounter.textContent = promptLengthLabel(
        synthesis, PROMPT_SYNTHESIS_LIMIT,
      );
      chatCounter.textContent = promptLengthLabel(
        chat, PROMPT_SYSTEM_LIMIT,
      );
      setClass(systemCounter, "rr-field-help"
        + (getValue(system).length > PROMPT_SYSTEM_LIMIT ? " error" : ""));
      setClass(synthesisCounter, "rr-field-help"
        + (getValue(synthesis).length > PROMPT_SYNTHESIS_LIMIT ? " error" : ""));
      setClass(chatCounter, "rr-field-help"
        + (getValue(chat).length > PROMPT_SYSTEM_LIMIT ? " error" : ""));
    };
    system.addEventListener("input", updateCounters);
    synthesis.addEventListener("input", updateCounters);
    chat.addEventListener("input", updateCounters);
    const systemField = makeField("完整系统提示词", system);
    systemField.append(systemCounter);
    const synthesisField = makeField("综合阶段指令", synthesis);
    synthesisField.append(synthesisCounter);
    const chatField = makeField("论文对话系统提示词", chat);
    chatField.append(chatCounter);
    const actions = make("div", "rr-modal-actions");
    let config = null;
    let working = false;
    const cancel = makeApiButton("取消", "rr-secondary", () => shell.close());
    const reset = makeApiButton("恢复默认值", "rr-secondary",
      () => void restoreDefaults());
    const save = makeApiButton("保存提示词", "rr-button-primary",
      () => void submit());
    actions.append(cancel, reset, save);
    modal.append(
      intro, current, systemField, synthesisField, chatField,
      defaults, status, actions,
    );
    const setWorking = value => {
      working = value;
      setBooleanAttribute(save, "disabled", value);
      setBooleanAttribute(reset, "disabled", value);
      setBooleanAttribute(cancel, "disabled", value);
      setBooleanAttribute(system, "disabled", value);
      setBooleanAttribute(synthesis, "disabled", value);
      setBooleanAttribute(chat, "disabled", value);
    };
    const showConfig = next => {
      config = next;
      setValue(system, next.systemPrompt || "");
      setValue(synthesis, next.synthesisInstruction || "");
      setValue(chat, next.chatSystemPrompt || "");
      defaultSystem.textContent = next.defaultSystemPrompt || "";
      defaultSynthesis.textContent = next.defaultSynthesisInstruction || "";
      defaultChat.textContent = next.defaultChatSystemPrompt || "";
      current.replaceChildren(
        make("strong", null,
          next.isCustom ? "当前使用自定义提示词" : "当前使用默认提示词"),
        make("span", null,
          `Hash ${next.promptHash || "未记录"} · 保存于 ${formatDate(next.updatedAt)}`),
      );
      updateCounters();
    };
    const submit = async () => {
      if (working) return;
      const systemPrompt = getValue(system);
      const synthesisInstruction = getValue(synthesis);
      const chatSystemPrompt = getValue(chat);
      if (!systemPrompt.trim() || !synthesisInstruction.trim()
          || !chatSystemPrompt.trim()) {
        setStatus(status,
          "系统提示词、综合指令与对话系统提示词都不能为空。",
          "error");
        return;
      }
      if (systemPrompt.length > PROMPT_SYSTEM_LIMIT
          || synthesisInstruction.length > PROMPT_SYNTHESIS_LIMIT
          || chatSystemPrompt.length > PROMPT_SYSTEM_LIMIT) {
        setStatus(status,
          "分析/对话系统提示词各最多 40000 字符，综合指令最多 4000 字符。",
          "error");
        return;
      }
      setWorking(true);
      setStatus(status, "正在保存提示词…", "pending");
      try {
        const saved = await state.service.savePromptConfig({
          systemPrompt, synthesisInstruction, chatSystemPrompt,
        });
        showConfig(saved);
        setStatus(state.globalStatus,
          "分析提示词已保存；新分析将使用此版本。", "success");
        shell.close();
      }
      catch (error) {
        setStatus(status, safeError(error).message, "error");
      }
      finally {
        if (!working) return;
        setWorking(false);
      }
    };
    async function restoreDefaults() {
      if (working || !config) return;
      setWorking(true);
      setStatus(status, "正在恢复默认提示词…", "pending");
      try {
        const restored = await state.service.resetPromptConfig();
        showConfig(restored);
        setStatus(state.globalStatus,
          "分析提示词已恢复为当前版本默认值。", "success");
      }
      catch (error) {
        setStatus(status, safeError(error).message, "error");
      }
      finally {
        setWorking(false);
      }
    }
    setWorking(true);
    try {
      showConfig(await state.service.getPromptConfig());
      setWorking(false);
      system.focus();
    }
    catch (error) {
      setWorking(false);
      setStatus(status, safeError(error).message, "error");
    }
    return shell;
  }
  function batchTargetsForUI(targets) {
    const result = [];
    const seen = new Set();
    for (const target of targets || []) {
      const itemID = Number(target && (target.itemID ?? target.id));
      if (!Number.isSafeInteger(itemID) || itemID < 1) continue;
      if (seen.has(itemID)) continue;
      seen.add(itemID);
      const normalized = {
        id: itemID,
        itemID,
        libraryID: Number(target.libraryID) || null,
        key: String(target.key || ""),
        title: String(target.title || `文献 ${itemID}`),
      };
      if (target.attachmentID != null) {
        normalized.attachmentID = Number(target.attachmentID);
      }
      if (result.length >= MAX_BATCH_TARGETS) break;
      result.push(normalized);
    }
    return result;
  }
  async function openBatchReview({
    targets = selectedPapers(),
    title = "批量 AI 分析",
  } = {}) {
    if (!state) return null;
    if (batchIsRunning()) {
      title = "批量分析状态";
      targets = [];
    }
    const frozenTargets = batchTargetsForUI(targets);
    if (!frozenTargets.length && state.batchState?.status === "idle") {
      setStatus(state.globalStatus,
        "请先勾选至少一篇论文，再打开批量分析。", "warning");
      return null;
    }
    const shell = dialogShell(title, () => {
      if (state && state.batchDialog?.shell === shell) {
        state.batchDialog = null;
      }
    });
    const { modal } = shell;
    const status = make("div", "rr-message");
    setHidden(status, true);
    const configBox = make("div", "rr-batch-config");
    configBox.append(make("span", "rr-muted", "正在读取已保存的模型目标…"));
    const preview = make("section", "rr-batch-preview");
    const previewHead = make("div", "rr-batch-preview-head");
    const previewCount = make("strong", null,
      frozenTargets.length ? `已明确选择 ${frozenTargets.length} 篇` : "当前批次");
    const previewList = make("div", "rr-batch-preview-list");
    previewHead.append(previewCount);
    preview.append(previewHead, previewList);
    const forceInput = currentDocument().createElementNS(
      XHTML_NS, "input",
    );
    forceInput.setAttribute("type", "checkbox");
    const forceRow = make("label", "rr-check rr-batch-force");
    forceRow.append(
      forceInput,
      make("span", null,
        "重新分析已有结果（默认复用缓存；只影响本次明确目标）"),
    );
    const notice = make("div", "rr-callout rr-warning");
    notice.textContent = "点击“开始批量分析”后才会顺序调用模型。每个成功结果自动保存到既有本地分析存储；阅读状态不变。关闭窗口会取消仍在运行的批次，已保存结果保留。";
    const queue = make("div", "rr-batch-queue");
    queue.setAttribute("role", "status");
    queue.setAttribute("aria-live", "polite");
    const actions = make("div", "rr-modal-actions");
    const close = makeApiButton("关闭", "rr-secondary", () => shell.close());
    const cancelRun = makeApiButton("取消批次", "rr-danger", () => {
      try {
        const cancelled = state.service.cancelBatch();
        setStatus(status,
          cancelled ? "正在取消批次…" : "当前没有正在运行的批次。",
          cancelled ? "pending" : "warning");
      }
      catch (error) {
        setStatus(status, safeError(error).message, "error");
      }
    });
    const start = makeApiButton("开始批量分析", "rr-button-primary",
      () => void begin());
    setHidden(forceRow, !frozenTargets.length);
    actions.append(close, cancelRun, start);
    modal.append(
      preview, configBox, forceRow, notice, queue, status, actions,
    );
    let running = false;
    const renderTargets = () => {
      previewList.replaceChildren();
      const entries = frozenTargets.length
        ? frozenTargets
        : (state.batchState?.entries || []);
      if (!entries.length) {
        previewList.append(make("p", "rr-muted", "没有待分析论文。"));
      }
      for (const entry of entries.slice(0, MAX_BATCH_TARGETS)) {
        const row = make("div", "rr-batch-preview-row");
        row.append(
          make("span", "rr-batch-preview-title",
            entry.title || `文献 ${entry.itemID}`),
          make("span", "rr-batch-preview-id",
            entry.libraryID
              ? `${entry.libraryID}/${entry.key || entry.itemID}`
              : String(entry.itemID)),
        );
        if (BATCH_STATUS_LABELS[entry.status]) {
          row.append(make("span",
            "rr-batch-status rr-batch-" + entry.status,
            BATCH_STATUS_LABELS[entry.status]));
        }
        previewList.append(row);
      }
    };
    const renderQueue = () => {
      const batch = state.batchState;
      queue.replaceChildren();
      if (!batch || !Array.isArray(batch.entries)
          || !batch.entries.length || batch.status === "idle") {
        queue.append(make("span", "rr-muted",
          "尚未启动；打开此窗口不会发起任何模型请求。"));
        return;
      }
      const head = make("div", "rr-batch-queue-head");
      head.append(
        make("strong", null,
          batch.status === "running" ? "正在顺序执行"
            : batch.status === "cancelled" ? "批次已取消"
              : "批次已完成"),
        make("span", null, batchCountsText(batch)),
      );
      queue.append(head);
      const list = make("div", "rr-batch-queue-list");
      for (const entry of batch.entries) {
        const row = make("div", "rr-batch-queue-row");
        const identity = make("div", "rr-batch-queue-copy");
        identity.append(
          make("strong", null, entry.title || `文献 ${entry.itemID}`),
          make("span", null,
            [entry.stage, entry.error?.message].filter(Boolean).join(" · ")
              || "等待处理"),
        );
        row.append(
          identity,
          make("span", "rr-batch-status rr-batch-" + entry.status,
            BATCH_STATUS_LABELS[entry.status] || entry.status),
        );
        list.append(row);
      }
      queue.append(list);
      const failed = batch.entries.filter(entry => entry.status === "failed");
      if (failed.length && batch.status !== "running") {
        const retryTargets = failed.map(entry => ({
          id: entry.itemID,
          itemID: entry.itemID,
          libraryID: entry.libraryID,
          key: entry.key,
          title: entry.title,
        }));
        const retry = makeApiButton(`重试 ${failed.length} 篇失败项`,
          "rr-secondary", () => {
            shell.close();
            void openBatchReview({
              targets: retryTargets,
              title: "重试失败论文",
            });
          });
        queue.append(retry);
      }
    };
    const setRunning = value => {
      running = value;
      setHidden(start, !frozenTargets.length);
      setBooleanAttribute(start, "disabled", value || !frozenTargets.length);
      setBooleanAttribute(forceInput, "disabled", value);
      setBooleanAttribute(cancelRun, "disabled", !value);
    };
    const render = () => {
      const active = batchIsRunning();
      setRunning(active);
      renderTargets();
      renderQueue();
    };
    state.batchDialog = { shell, render };
    render();
    if (frozenTargets.length) {
      try {
        const config = await state.service.getAIConfig();
        const context = endpointContext(config.endpoint);
        configBox.replaceChildren(
          make("strong", null,
            `${config.provider || "未记录"} · ${config.model || "未设置模型"}`),
          make("span", null,
            context.ok ? `端点 origin：${context.origin}` : "端点 origin 无法识别"),
        );
      }
      catch (error) {
        configBox.replaceChildren(make("span", "rr-unverified",
          `模型目标读取失败：${safeError(error).message}`));
      }
    }
    else {
      configBox.replaceChildren(make("span", "rr-muted",
        "此视图展示当前批次状态；已保存结果可从论文目录和当前论文读取。"));
    }
    async function begin() {
      if (running || batchIsRunning() || !frozenTargets.length) return;
      const sessionState = state;
      const targetsAtClick = frozenTargets.map(target => ({
        itemID: target.itemID,
        ...(target.attachmentID == null
          ? {} : { attachmentID: target.attachmentID }),
      }));
      const force = getChecked(forceInput);
      setRunning(true);
      setStatus(status,
        `正在启动 ${targetsAtClick.length} 篇论文的顺序队列…`,
        "pending");
      activeBatch = { startedAt: new Date().toISOString() };
      try {
        const finalState = await sessionState.service.analyzeBatch(
          targetsAtClick,
          {
            force,
            onProgress: handleBatchProgress,
          },
        );
        if (!state || state !== sessionState) return;
        applyBatchState(finalState);
        setStatus(status,
          finalState.status === "cancelled"
            ? "批次已取消；已完成的结果已保留。"
            : "批次已完成；每篇成功结果均已自动保存。",
          finalState.status === "cancelled" ? "warning" : "success");
      }
      catch (error) {
        const safe = safeError(error);
        if (!state || state !== sessionState) return;
        if (safe.code !== "BATCH_RUNNING") {
          applyBatchState(sessionState.service.getBatchState());
        }
        setStatus(status, safe.message, "error");
      }
      finally {
        activeBatch = null;
        if (state === sessionState) {
          render();
          syncActionLocks();
        }
      }
    }
    return shell;
  }
  async function selectCurrentPage() {
    if (!state || batchIsRunning()) return;
    let added = 0;
    let capped = false;
    for (const paper of state.catalog.items || []) {
      if (state.selectedPapers.size >= MAX_BATCH_TARGETS) {
        capped = true;
        break;
      }
      if (rememberSelectedPaper(paper)) added++;
    }
    renderCatalog();
    updateSelectionControls();
    selectionStatus(
      capped
        ? `已达到 ${MAX_BATCH_TARGETS} 篇上限；当前页其余论文未加入。`
        : `当前页新增 ${added} 篇，已选 ${state.selectedPapers.size} 篇。`,
      capped ? "warning" : "success",
    );
  }
  async function addFilteredSelection() {
    if (!state || state.selectionLoading || batchIsRunning()) return;
    const generation = ++selectionGeneration;
    const scope = catalogScope();
    const query = getValue(state.searchInput).trim();
    const focusOnly = state.catalog.focusOnly === true;
    state.selectionLoading = true;
    updateSelectionControls();
    selectionStatus("正在按当前筛选逐页收集目标…", "pending");
    let offset = 0;
    let total = null;
    let added = 0;
    try {
      while (generation === selectionGeneration) {
        const limit = Math.min(200, MAX_BATCH_TARGETS
          - state.selectedPapers.size + 1);
        if (limit < 1) break;
        const result = await state.service.listPapers({
          libraryID: scope.libraryID,
          collectionID: scope.collectionID,
          query,
          focusOnly,
          offset,
          limit,
        });
        if (!state || generation !== selectionGeneration) return;
        const items = Array.isArray(result.items) ? result.items : [];
        total = Number(result.total) || 0;
        for (const paper of items) {
          if (state.selectedPapers.size >= MAX_BATCH_TARGETS) break;
          if (rememberSelectedPaper(paper)) added++;
        }
        offset += items.length;
        if (!items.length || offset >= total
            || state.selectedPapers.size >= MAX_BATCH_TARGETS) break;
      }
      renderCatalog();
      const remaining = Math.max(
        0, Number(total || 0) - offset,
      );
      selectionStatus(
        `当前筛选新增 ${added} 篇，已选 ${state.selectedPapers.size} 篇。`
          + (state.selectedPapers.size >= MAX_BATCH_TARGETS && remaining
            ? ` 已达到 ${MAX_BATCH_TARGETS} 篇上限，剩余 ${remaining} 篇未加入。`
            : ""),
        state.selectedPapers.size >= MAX_BATCH_TARGETS && remaining
          ? "warning" : "success",
      );
    }
    catch (error) {
      if (state && generation === selectionGeneration) {
        selectionStatus(
          `筛选范围收集未完成：${safeError(error).message}`, "error",
        );
      }
    }
    finally {
      if (state && generation === selectionGeneration) {
        state.selectionLoading = false;
        updateSelectionControls();
      }
    }
  }
  function clearBatchSelection() {
    if (!state || batchIsRunning()) return;
    state.selectedPapers.clear();
    renderCatalog();
    updateSelectionControls();
    selectionStatus("已清空明确勾选的论文。", "");
  }
  function openAIConfig(item = state && state.currentItem) {
    return new Promise(resolve => {
      const doc = currentDocument();
      const providers = getProviderCatalog();
      const defaultProvider = providers.find(
        provider => provider.id === DEFAULT_PROVIDER,
      ) || providers[0];
      const groupRemoteForbidden = isGroupLibrary(item);
      const session = {
        generation: 0,
        timer: null,
        controller: null,
        finished: false,
        models: [],
        discoveryPending: false,
        lastEndpoint: defaultProvider.defaultEndpoint,
        lastProvider: defaultProvider.id,
        configOrigin: null,
        configProvider: null,
        consentOrigin: null,
        consentProvider: null,
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
      const shell = dialogShell("模型设置", () => {
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
        setValue(option, entry.id);
        option.textContent = entry.label;
        provider.append(option);
      }
      setValue(provider, defaultProvider.id);
      const providerChoice = makeChoice(provider, {
        label: "AI 协议", className: "rr-provider-choice",
      });
      providerChoice.binding.syncOptions();
      providerChoice.binding.syncSelection(defaultProvider.id);
      const providerHint = make("p", "rr-field-help");
      const endpoint = doc.createElementNS(XHTML_NS, "input");
      endpoint.setAttribute("type", "url");
      setValue(endpoint, defaultProvider.defaultEndpoint);
      endpoint.setAttribute("autocomplete", "off");
      endpoint.setAttribute("spellcheck", "false");
      endpoint.setAttribute("placeholder",
        "例如 http://127.0.0.1:11434/v1");
      const model = doc.createElementNS(XHTML_NS, "input");
      model.setAttribute("type", "text");
      model.setAttribute("placeholder",
        "搜索自动获取的模型，或手工填写模型 ID");
      model.setAttribute("autocomplete", "off");
      model.setAttribute("role", "combobox");
      model.setAttribute("aria-autocomplete", "list");
      model.setAttribute("aria-expanded", "false");
      const modelOptions = doc.createElementNS(XHTML_NS, "div");
      modelOptions.setAttribute("id", "rr-model-options");
      modelOptions.setAttribute("role", "listbox");
      setClass(modelOptions, "rr-model-options");
      setHidden(modelOptions, true);
      const discoveryStatus = make("div", "rr-message");
      discoveryStatus.setAttribute("role", "status");
      discoveryStatus.setAttribute("aria-live", "polite");
      setHidden(discoveryStatus, true);
      const refresh = makeApiButton(
        "获取模型列表",
        "rr-secondary",
        () => scheduleDiscovery(0, true),
      );
      const apiKey = doc.createElementNS(XHTML_NS, "input");
      apiKey.setAttribute("type", "password");
      apiKey.setAttribute("autocomplete", "new-password");
      apiKey.setAttribute("placeholder",
        "留空则保留当前目标已安全保存的密钥");
      const rememberKey = doc.createElementNS(XHTML_NS, "input");
      rememberKey.setAttribute("type", "checkbox");
      const rememberRow = make("label", "rr-check");
      rememberRow.append(
        rememberKey,
        make("span", null,
          "安全记住此设备的 API 密钥（加密保存）"),
      );
      const clearKey = doc.createElementNS(XHTML_NS, "input");
      clearKey.setAttribute("type", "checkbox");
      const clearRow = make("label", "rr-check rr-warning-check");
      clearRow.append(
        clearKey,
        make("span", null,
          "主动清除当前目标已保存的 API 密钥（本机端点仍可匿名分析）"),
      );
      const discoveryRemote = doc.createElementNS(XHTML_NS, "input");
      discoveryRemote.setAttribute("type", "checkbox");
      const discoveryRemoteRow = make(
        "label", "rr-check rr-warning-check",
      );
      discoveryRemoteRow.setAttribute("data-ai-permission", "discovery");
      discoveryRemoteRow.append(
        discoveryRemote,
        make("span", null,
          "允许此 origin 获取模型列表（只发送协议、端点及已存密钥，不发送论文正文）。"),
      );
      const analysisRemote = doc.createElementNS(XHTML_NS, "input");
      analysisRemote.setAttribute("type", "checkbox");
      const analysisRemoteRow = make(
        "label", "rr-check rr-warning-check",
      );
      analysisRemoteRow.setAttribute("data-ai-permission", "analysis");
      analysisRemoteRow.append(
        analysisRemote,
        make("span", null,
          "允许在我点击 AI 分析时，将所选论文的部分文本发送到此 HTTPS 服务。"),
      );
      const warning = make("div", "rr-callout rr-warning");
      warning.textContent = "启动、打开或切换论文都不会调用模型。AI 按钮直接使用保存的配置；无密钥的本机端点可匿名分析。更换协议或 origin 会立即撤销旧许可并清空未提交密钥。";
      const actions = make("div", "rr-modal-actions");
      const cancel = makeApiButton(
        "取消", "rr-secondary", () => finish(null),
      );
      const save = makeApiButton(
        "保存模型设置",
        "rr-button-primary",
        () => void submit(),
      );
      actions.append(cancel, save);
      const modalStatus = make("div", "rr-message");
      setHidden(modalStatus, true);
      const keyHint = make("p", "rr-field-help");
      keyHint.textContent = "加载时不读取或显示明文密钥。";
      const modelField = makeField(
        "模型（可搜索或手工输入）", model,
      );
      modelField.append(modelOptions, discoveryStatus, refresh);
      const providerField = makeField("AI 协议", providerChoice.root);
      providerField.append(providerHint);
      const keyField = makeField("API 密钥", apiKey);
      keyField.append(keyHint, rememberRow, clearRow);
      modal.append(
        providerField,
        makeField("API 端点", endpoint),
        keyField,
        discoveryRemoteRow,
        modelField,
        analysisRemoteRow,
        warning,
        modalStatus,
        actions,
      );

      const updateProviderHint = () => {
        const selected = providers.find(
          entry => entry.id === getValue(provider),
        ) || defaultProvider;
        providerHint.textContent = selected.endpointHint
          || "端点可填写服务商 base URL；后端会统一规范化列表与请求地址。";
      };
      const clearModels = () => {
        session.models = [];
        modelOptions.replaceChildren();
        setHidden(modelOptions, true);
        model.setAttribute("aria-expanded", "false");
      };
      const resetRemoteConsent = () => {
        setChecked(discoveryRemote, false);
        setChecked(analysisRemote, false);
      };
      const resetStaleState = clearInputKey => {
        session.generation++;
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
        if (clearInputKey) setValue(apiKey, "");
      };
      const updateConsentRows = () => {
        const context = endpointContext(getValue(endpoint));
        setHidden(discoveryRemoteRow, !context.ok || context.local);
        setHidden(analysisRemoteRow, !context.ok || context.local);
        setBooleanAttribute(analysisRemote, "disabled",
          !context.ok || context.local || groupRemoteForbidden);
        if (!context.ok || context.local) resetRemoteConsent();
        const description = analysisRemoteRow.lastElementChild;
        if (description) {
          description.textContent = groupRemoteForbidden
            ? "群组文库禁止远程正文分析；可仅授权获取模型列表。"
            : "允许在我点击 AI 分析时，将所选论文的部分文本发送到此 HTTPS 服务。";
        }
      };
      const addModelOptions = (models, query) => {
        const needle = query.toLowerCase();
        const visible = models.filter(entry => !needle
          || String(entry.id).toLowerCase().includes(needle)
          || String(entry.name).toLowerCase().includes(needle)).slice(0, 80);
        modelOptions.replaceChildren();
        for (const entry of visible) {
          const option = make(
            "button", "rr-model-option", entry.name || entry.id,
          );
          option.setAttribute("type", "button");
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected",
            String(entry.id === getValue(model).trim()));
          if (entry.name && entry.name !== entry.id) {
            option.append(make("span", "rr-model-id", entry.id));
          }
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
      const discover = async generation => {
        if (session.finished || generation !== session.generation) return;
        const selectedProvider = providers.find(
          entry => entry.id === getValue(provider),
        ) || defaultProvider;
        const context = endpointContext(getValue(endpoint));
        if (!context.ok) {
          setStatus(discoveryStatus,
            context.error + " 仍可手工填写模型 ID。", "warning");
          setBooleanAttribute(refresh, "disabled", true);
          return;
        }
        const allowRemote = !context.local && getChecked(discoveryRemote);
        if (!context.local && !allowRemote) {
          setStatus(discoveryStatus,
            "远程端点尚未授权获取模型列表；勾选上方许可，或手工填写模型 ID。",
            "warning");
          setBooleanAttribute(refresh, "disabled", false);
          return;
        }
        const controller = new (
          state.window.AbortController || AbortController
        )();
        session.controller = controller;
        session.discoveryPending = true;
        setBooleanAttribute(refresh, "disabled", true);
        setStatus(discoveryStatus,
          `正在从 ${selectedProvider.label} 获取模型列表…`, "pending");
        try {
          const explicitKey = getValue(apiKey);
          const options = {
            provider: selectedProvider.id,
            endpoint: getValue(endpoint).trim(),
            apiKey: explicitKey || undefined,
            allowRemote,
            signal: controller.signal,
            item,
          };
          const result = typeof state.service.listConfiguredModels
            === "function"
            && !explicitKey
            && context.origin === session.configOrigin
            && selectedProvider.id === session.configProvider
            ? await state.service.listConfiguredModels({
              signal: controller.signal, item,
            })
            : await state.service.listModels(options);
          if (session.finished || generation !== session.generation) return;
          const models = Array.isArray(result && result.models)
            ? result.models.filter(entry =>
              entry && String(entry.id || "").trim())
              .map(entry => ({
                id: String(entry.id).trim(),
                name: String(entry.name || entry.id).trim()
                  || String(entry.id).trim(),
              })) : [];
          session.models = models;
          if (result && result.endpoint
              && String(result.endpoint).trim()) {
            session.lastEndpoint = String(result.endpoint).trim();
          }
          session.discoveryPending = false;
          setStatus(discoveryStatus, models.length
            ? `已获取 ${models.length} 个模型；可在模型框中搜索，也可继续手工输入。`
            : "服务返回了空模型列表；请确认账号权限，或手工填写模型 ID。",
          models.length ? "success" : "warning");
          refresh.textContent = "刷新模型列表";
          refreshModels();
        }
        catch (error) {
          if (session.finished || generation !== session.generation) return;
          session.discoveryPending = false;
          const cancelled = controller.signal
            && controller.signal.aborted
            || String(error && error.code || "") === "CANCELLED";
          if (!cancelled) {
            setStatus(discoveryStatus,
              modelDiscoveryFailure(error), "error");
            refresh.textContent = "重试获取模型列表";
          }
        }
        finally {
          session.discoveryPending = false;
          if (!session.finished && generation === session.generation) {
            if (session.controller === controller) {
              session.controller = null;
            }
            setBooleanAttribute(refresh, "disabled", false);
          }
        }
      };
      function scheduleDiscovery(
        delay = MODEL_DISCOVERY_DELAY, force = false,
      ) {
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
        if (!force) clearModels();
        setStatus(discoveryStatus,
          delay ? "正在等待地址、协议或密钥变化结束…" : "",
          delay ? "pending" : "");
        session.timer = setTimeout(() => {
          if (session.finished || generation !== session.generation) return;
          session.timer = null;
          void discover(generation);
        }, delay);
      }
      const providerChanged = () => {
        const selected = providers.find(
          entry => entry.id === getValue(provider),
        ) || defaultProvider;
        resetStaleState(true);
        resetRemoteConsent();
        session.consentOrigin = null;
        session.consentProvider = null;
        setValue(endpoint, selected.defaultEndpoint);
        setValue(model, "");
        session.lastProvider = selected.id;
        session.lastEndpoint = selected.defaultEndpoint;
        updateProviderHint();
        updateConsentRows();
        scheduleDiscovery();
      };
      const endpointChanged = () => {
        const context = endpointContext(getValue(endpoint));
        const previous = endpointContext(session.lastEndpoint);
        const originChanged = !context.ok || !previous.ok
          || context.origin !== previous.origin;
        resetStaleState(originChanged);
        if (originChanged) {
          resetRemoteConsent();
          session.consentOrigin = null;
          session.consentProvider = null;
        }
        session.lastEndpoint = getValue(endpoint).trim();
        updateConsentRows();
        scheduleDiscovery();
      };
      const credentialChanged = () => {
        resetStaleState(false);
        refresh.textContent = "获取模型列表";
        scheduleDiscovery();
      };
      const clearKeyChanged = () => {
        if (getChecked(clearKey)) setValue(apiKey, "");
      };
      const updateConsentBinding = () => {
        const context = endpointContext(getValue(endpoint));
        const providerID = getValue(provider);
        const checked = getChecked(discoveryRemote)
          || getChecked(analysisRemote);
        session.consentOrigin = context.ok && !context.local && checked
          ? context.origin : null;
        session.consentProvider = context.ok && !context.local && checked
          ? providerID : null;
      };
      const submit = async () => {
        const selectedProvider = providers.find(
          entry => entry.id === getValue(provider),
        ) || defaultProvider;
        const context = endpointContext(getValue(endpoint));
        const modelID = getValue(model).trim();
        if (!context.ok) {
          setStatus(modalStatus, context.error, "error");
          endpoint.focus();
          return;
        }
        if (!modelID) {
          setStatus(modalStatus,
            "请从模型列表中选择，或手工填写模型 ID。", "error");
          model.focus();
          return;
        }
        if (!context.local && groupRemoteForbidden
            && getChecked(analysisRemote)) {
          setStatus(modalStatus,
            "群组文库禁止远程正文分析。", "error");
          return;
        }
        updateConsentBinding();
        const remoteConsentRequested = !context.local
          && (getChecked(discoveryRemote)
            || (!groupRemoteForbidden && getChecked(analysisRemote)));
        const input = {
          provider: selectedProvider.id,
          endpoint: getValue(endpoint).trim(),
          model: modelID,
          allowRemoteDiscovery:
            !context.local && getChecked(discoveryRemote),
          allowRemoteAnalysis: !context.local && !groupRemoteForbidden
            && getChecked(analysisRemote),
          consentOrigin: remoteConsentRequested
            ? session.consentOrigin : null,
          consentProvider: remoteConsentRequested
            ? session.consentProvider : null,
        };
        setBooleanAttribute(save, "disabled", true);
        setStatus(modalStatus, "正在保存模型设置…", "pending");
        try {
          await state.service.saveAIConfig(input, {
            apiKey: getValue(apiKey) || undefined,
            rememberKey: getChecked(rememberKey),
            clearKey: getChecked(clearKey),
          });
          finish({ saved: true });
        }
        catch (error) {
          setBooleanAttribute(save, "disabled", false);
          setStatus(modalStatus, safeError(error).message, "error");
        }
      };
      providerChoice.binding.syncOptions();
      providerChoice.binding.syncSelection(getValue(provider));
      provider.addEventListener("change", providerChanged);
      endpoint.addEventListener("input", endpointChanged);
      endpoint.addEventListener("change", endpointChanged);
      apiKey.addEventListener("input", credentialChanged);
      clearKey.addEventListener("change", clearKeyChanged);
      discoveryRemote.addEventListener("change", () => {
        updateConsentBinding();
        scheduleDiscovery(0, true);
      });
      analysisRemote.addEventListener("change", updateConsentBinding);
      model.addEventListener("input", refreshModels);
      model.addEventListener("focus", refreshModels);
      model.addEventListener("keydown", event => {
        if (event.key === "Escape"
            && !modelOptions.hasAttribute("hidden")) {
          event.stopPropagation();
          setHidden(modelOptions, true);
          model.setAttribute("aria-expanded", "false");
        }
      });
      updateProviderHint();
      updateConsentRows();
      void state.service.getAIConfig().then(config => {
        if (session.finished) return;
        const providerID = providers.some(
          entry => entry.id === config.provider,
        ) ? config.provider : defaultProvider.id;
        setValue(provider, providerID);
        setValue(endpoint,
          config.endpoint || defaultProvider.defaultEndpoint);
        setValue(model, config.model || "");
        setChecked(rememberKey, config.rememberKey !== false);
        setChecked(clearKey, false);
        const configContext = endpointContext(config.endpoint);
        const consentMatches = configContext.ok
          && configContext.origin === config.consentOrigin
          && config.consentProvider === providerID;
        setChecked(discoveryRemote,
          consentMatches && config.allowRemoteDiscovery === true);
        setChecked(analysisRemote,
          consentMatches && config.allowRemoteAnalysis === true);
        session.configOrigin = configContext.origin || null;
        session.configProvider = providerID;
        session.lastProvider = providerID;
        session.lastEndpoint =
          config.endpoint || defaultProvider.defaultEndpoint;
        keyHint.textContent = config.hasApiKey
          ? "本机已安全保存 API 密钥；留空保存会保留。输入新值可替换。"
          : "本机未保存 API 密钥；无密钥的本机端点仍可分析。";
        setBooleanAttribute(rememberKey, "disabled",
          config.keyStorageAvailable === false);
        updateProviderHint();
        updateConsentRows();
        scheduleDiscovery();
      }).catch(error => {
        if (!session.finished) {
          setStatus(modalStatus, safeError(error).message, "error");
        }
      });
      modal.focus();
    });
  }
  async function saveAnalysisNote() {
    if (!state || !state.currentItem
        || !state.description.state.analysis) return;
    setBooleanAttribute(state.noteButton, "disabled", true);
    setStatus(state.noteStatus,
      "正在创建插件分析笔记…", "pending");
    try {
      const result = await state.service.saveAnalysisNote(
        state.currentItem,
      );
      setStatus(state.noteStatus,
        result.created
          ? "已显式创建新的 Zotero 分析笔记。"
          : "同一分析已有插件笔记，未重复创建。",
        "success");
    }
    catch (error) {
      setStatus(state.noteStatus, safeError(error).message, "error");
    }
    finally {
      if (state) setBusy(false);
    }
  }
  async function syncStateNote() {
    if (!state || !state.currentItem) return;
    setBooleanAttribute(state.syncButton, "disabled", true);
    setStatus(state.noteStatus,
      "正在同步阅读记录到个人库笔记…", "pending");
    try {
      const result = await state.service.syncStateNote(
        state.currentItem,
      );
      const text = result.changed
        ? (result.created
          ? "已显式创建阅读记录笔记。"
          : "已更新本插件创建的阅读记录笔记。")
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
      lines.push(
        `- [${reading.checklist && reading.checklist[id] ? "x" : " "}] ${label}`,
      );
    }
    if (analysis && analysis.mode === "model") {
      lines.push("", "## AI 解读（待核对）", "");
      if (analysis.overview) {
        lines.push("### 概览", "", analysis.overview, "");
      }
      if (analysis.readingGuide) {
        lines.push("### 阅读路径", "", analysis.readingGuide, "");
      }
      for (const dimension of analysis.dimensions || []) {
        lines.push(
          `### ${dimension.label}`, "",
          dimension.summary || "信息不足", "",
        );
        for (const entry of dimension.evidence || []) {
          const location = entry.pageIndex == null
            ? "页码未确认，打开附件核查"
            : `PDF 第 ${entry.pageIndex + 1} 页`;
          lines.push(
            `> ${entry.quote || ""}`, "",
            `— ${location}；${entry.verified ? "原文逐字匹配" : "未验证"}`,
            "",
          );
        }
      }
      const coverage = analysis.coverage || {};
      lines.push(
        "## 覆盖范围与限制", "",
        `- 分析字符：${coverage.analyzedCharacters || 0} / ${coverage.extractedCharacters || 0}`,
        `- 页码边界：${coverage.pageAware ? "可用" : "未确认"}`,
      );
      for (const limitation of analysis.limitations || []) {
        lines.push(`- ${limitation}`);
      }
    }
    lines.push(
      "",
      "> 本文件由 Zotero 插件在本地显式导出；不包含自动云端上传。",
      "",
    );
    return lines.join("\n");
  }
  async function chooseExport(type) {
    if (!state || !state.description) return;
    try {
      const { FilePicker } = ChromeUtils.importESModule(
        "chrome://zotero/content/modules/filePicker.mjs",
      );
      const picker = new FilePicker();
      picker.init(
        state.window,
        type === "json"
          ? "导出阅读室 JSON" : "导出阅读室 Markdown",
        picker.modeSave,
      );
      const safeTitle = String(
        state.description.item.title || "reading-room",
      ).replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80);
      picker.defaultString = `${safeTitle}.${type}`;
      picker.defaultExtension = type;
      picker.appendFilter(
        type === "json" ? "JSON" : "Markdown", `*.${type}`,
      );
      const result = await picker.show();
      if (![picker.returnOK, picker.returnReplace].includes(result)) {
        return;
      }
      const content = type === "json"
        ? JSON.stringify(state.description, null, 2)
        : markdownFor(state.description);
      await IOUtils.writeUTF8(picker.file, content, { flush: true });
      setStatus(state.exportStatus,
        `已导出到 ${picker.file}`, "success");
    }
    catch (error) {
      setStatus(state.exportStatus,
        `导出失败：${safeError(error).message}`, "error");
    }
  }
  function nativeReaderForContext() {
    const tabID = state.nativeContext && state.nativeContext.tabID;
    try {
      return tabID && Zotero.Reader && typeof Zotero.Reader.getByTabID === "function"
        ? Zotero.Reader.getByTabID(String(tabID)) : null;
    }
    catch (_) {
      return null;
    }
  }
  async function destroyPdf() {
    if (!state) return;
    const preview = state.nativePreview;
    state.nativePreview = null;
    if (preview && typeof preview.destroy === "function") {
      try { await preview.destroy(); } catch (_) {}
    }
  }
  function setNativePDFAdapter(attachment, generation) {
    state.nativePDFAdapter = {
      attachment,
      async navigate(pageIndex) {
        if (!Number.isInteger(pageIndex) || pageIndex < 0) {
          throw new Error("页码无效。");
        }
        if (!state || generation !== loadGeneration
            || state.nativePDFAdapter !== this) throw new Error("论文已切换。");
        const reader = nativeReaderForContext();
        if (!reader || typeof reader.navigate !== "function") {
          throw new Error("当前论文没有可导航的原生 PDF 阅读标签页。");
        }
        if (attachment && Number(reader.itemID) !== Number(attachment.id)) {
          throw new Error("当前原生阅读标签页不是所选 PDF 附件。");
        }
        await reader.navigate({ pageIndex });
        return true;
      },
      async previewPage(pageIndex, width = 520) {
        if (!Number.isInteger(pageIndex) || pageIndex < 0) {
          throw new Error("页码无效。");
        }
        if (!state || generation !== loadGeneration
            || state.nativePDFAdapter !== this) throw new Error("论文已切换。");
        if (!attachment || !attachment.available || !attachment.path) {
          throw new Error("此 PDF 在本机不可用。");
        }
        await destroyPdf();
        if (!state || generation !== loadGeneration
            || state.nativePDFAdapter !== this) throw new Error("论文已切换。");
        const API = scope.ReadingRoomPDF;
        if (!API || typeof API.mount !== "function") {
          throw new Error("本机 PDF 预览组件不可用。");
        }
        const container = currentDocument().createElementNS(XHTML_NS, "div");
        setClass(container, "rr-native-preview-host");
        container.setAttribute("aria-hidden", "true");
        state.document.documentElement.append(container);
        let controller = null;
        try {
          controller = API.mount({
            window: state.window,
            container,
            attachment,
          });
          await controller.initialized;
          if (!state || generation !== loadGeneration
              || state.nativePDFAdapter !== this) throw new Error("论文已切换。");
          state.nativePreview = controller;
          return await controller.previewPage({
            pageIndex,
            width: Math.max(160, Math.min(520, Number(width) || 420)),
          });
        }
        catch (error) {
          if (controller && state && state.nativePreview === controller) {
            state.nativePreview = null;
          }
          if (controller) {
            try { await controller.destroy(); } catch (_) {}
          }
          container.remove();
          throw error;
        }
      },
    };
    return state.nativePDFAdapter;
  }
  async function selectPaper(paper) {
    if (!state || !paper) return;
    try {
      await flushPendingEdits();
    }
    catch (error) {
      setStatus(
        state.globalStatus,
        `切换已取消：当前笔记保存失败（${safeError(error).message}）。`,
        "error",
      );
      return;
    }
    const item = Zotero.Items.get(Number(paper.id));
    if (!item) {
      setStatus(state.globalStatus, "无法读取所选论文条目。", "error");
      return;
    }
    if (isEmbedded() && Zotero.ReadingRoom?.show) {
      await Zotero.ReadingRoom.show({ itemID: item.id });
      return;
    }
    await selectItem(item);
  }
  async function selectHostItem(item) {
    if (!state || !item) return;
    const parent = state.service.normalizeItem(item);
    const reader = isEmbedded() ? nativeReaderForContext() : null;
    if (state.currentItem && parent
        && Number(state.currentItem.id) === Number(parent.id)
        && (!reader || Number(reader.itemID) === Number(state.currentAttachmentID))) return;
    await flushPendingEdits();
    await selectItem(item);
  }
  function analysisForAttachment(description, attachmentID) {
    const attachment = description?.attachments?.find(value => Number(value.id) === Number(attachmentID));
    const saved = description?.state;
    if (!attachment || !saved) return null;
    return saved.analyses?.[attachment.key]
      || (saved.analysis?.source?.attachmentKey === attachment.key ? saved.analysis : null);
  }
  async function selectItem(item) {
    if (!state || !item) return;
    const generation = ++loadGeneration;
    const priorItem = state.currentItem;
    const priorAttachment = state.currentAttachmentID;
    const nextParent = state.service.normalizeItem(item);
    if (priorItem && (Number(priorItem.id) !== Number(nextParent && nextParent.id)
        || Number(priorItem.libraryID) !== Number(nextParent && nextParent.libraryID))) {
      chatGeneration++;
      if (chatController) {
        try { chatController.abort(); } catch (_) {}
        chatController = null;
      }
      if (state.chatLoading && typeof state.service.cancelChat === "function") {
        try { state.service.cancelChat(priorItem); } catch (_) {}
      }
    }
    state.chatLoading = false;
    renderChat(null);
    await destroyPdf();
    state.currentItem = null;
    state.currentPaper = null;
    state.currentAttachmentID = null;
    state.description = null;
    setStatus(state.globalStatus, "正在读取文献…", "pending");
    state.title.textContent = "正在加载…";
    state.subtitle.textContent = "";
    state.aiResults.replaceChildren(make(
      "div", "rr-empty", "正在读取当前文献…",
    ));
    renderFocusedChips();
    try {
      const parent = nextParent;
      if (!parent) throw new Error("请选择一篇论文条目。");
      const description = await state.service.describe(parent);
      if (generation !== loadGeneration || !state) return;
      state.currentItem = parent;
      state.currentPaper = {
        id: description.item.id,
        libraryID: description.item.libraryID,
        key: description.item.key,
        title: description.item.title,
      };
      state.description = description;
      notesDirty = checklistDirty = false;
      const pdfs = description.attachments.filter(
        attachment => attachment.contentType === "application/pdf",
      );
      const boundReader = isEmbedded() ? nativeReaderForContext() : null;
      const available = pdfs.find(attachment => attachment.available
        && Number(attachment.id) === Number(boundReader?.itemID))
        || pdfs.find(attachment => attachment.available);
      state.currentAttachmentID = available
        ? available.id : pdfs[0] ? pdfs[0].id : null;
      description.state.analysis = analysisForAttachment(description, state.currentAttachmentID);
      state.title.textContent =
        description.item.title || "未命名文献";
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
        const option = currentDocument().createElementNS(
          XHTML_NS, "option",
        );
        setValue(option, "");
        option.textContent = "未找到 PDF 附件";
        state.attachmentSelect.append(option);
      }
      else {
        for (const attachment of pdfs) {
          const option = currentDocument().createElementNS(
            XHTML_NS, "option",
          );
          setValue(option, String(attachment.id));
          option.textContent = `${attachment.title || "PDF"}${attachment.available ? "" : "（本地不可用）"}`;
          setBooleanAttribute(option, "disabled", !attachment.available);
          setBooleanAttribute(option, "selected",
            attachment.id === state.currentAttachmentID);
          state.attachmentSelect.append(option);
        }
        setValue(
          state.attachmentSelect, String(state.currentAttachmentID),
        );
      }
      setBooleanAttribute(
        state.attachmentSelect,
        "disabled",
        !pdfs.some(attachment => attachment.available),
      );
      choiceBindings.get(state.attachmentSelect)?.syncOptions();
      updateStatusPills(
        state.statusChoices, description.state.status,
      );
      setValue(state.notesInput, description.state.notes || "");
      renderChecklist(description.state.checklist || {});
      state.updated.textContent =
        `本地保存于 ${formatDate(description.state.updatedAt)}`;
      state.counts.textContent =
        `Zotero 笔记 ${description.counts.notes} · 注释 ${description.counts.annotations}`;
      renderAnalysis(description.state.analysis);
      showJob(description.state.analysisJob || { status: "idle" });
      setBooleanAttribute(
        state.noteButton,
        "disabled",
        !description.state.analysis
          || description.state.analysis.mode !== "model",
      );
      setBooleanAttribute(state.syncButton, "disabled", false);
      syncActionLocks();
      if (priorItem && priorAttachment !== state.currentAttachmentID) {
        if (chatController) {
          try { chatController.abort(); } catch (_) {}
          chatController = null;
        }
        if (state.chatLoading && typeof state.service.cancelChat === "function") {
          try { state.service.cancelChat(priorItem); } catch (_) {}
        }
      }
      let attachment = null;
      if (state.currentAttachmentID) {
        try {
          attachment = await state.service.getReaderAttachment(
            parent, { attachmentID: state.currentAttachmentID },
          );
        }
        catch (error) {
          logError("reader attachment", error);
        }
      }
      if (generation !== loadGeneration || !state) return;
      setNativePDFAdapter(attachment, generation);
      state.openZoteroButton.disabled = !attachment;
      if (generation !== loadGeneration || !state) return;
      setStatus(
        state.globalStatus,
        attachment && attachment.available
          ? "Zotero 原生 PDF 位于左侧；切换论文不会自动调用模型。"
          : "PDF 不在本机；元数据、笔记和已保存的 AI 解读仍可使用。",
        attachment && attachment.available ? "success" : "warning",
      );
      void loadConversation(generation);
      renderFocusedChips();
      void loadCatalog();
    }
    catch (error) {
      if (generation !== loadGeneration || !state) return;
      state.title.textContent = "无法打开当前文献";
      state.subtitle.textContent = safeError(error).message;
      state.aiResults.replaceChildren(make(
        "div", "rr-empty", safeError(error).message,
      ));
      setStatus(state.globalStatus, safeError(error).message, "error");
    }
  }
  async function openZoteroAttachment() {
    if (!state || !state.currentItem
        || !state.currentAttachmentID) return;
    try {
      const reader = await Zotero.Reader.open(
        state.currentAttachmentID, null, {
          openInWindow: false,
          allowDuplicate: false,
        },
      );
      if (reader && reader.tabID && state.nativeContext) {
        state.nativeContext.tabID = String(reader.tabID);
      }
    }
    catch (error) {
      setStatus(state.globalStatus,
        safeError(error).message, "error");
    }
  }
  async function changePdfPage(delta) {
    if (!state || !state.nativePDFAdapter) return;
    const current = Number(getValue(state.pageInput));
    const page = Math.max(
      1, (Number.isInteger(current) ? current : 1) + delta,
    );
    try {
      await state.nativePDFAdapter.navigate(page - 1);
      setValue(state.pageInput, String(page));
    }
    catch (error) {
      setStatus(state.globalStatus,
        safeError(error).message, "error");
    }
  }
  async function jumpPdfPage() {
    if (!state || !state.nativePDFAdapter) return;
    const page = Number(getValue(state.pageInput));
    if (!Number.isInteger(page) || page < 1) {
      setStatus(state.globalStatus, "请输入有效页码。", "error");
      return;
    }
    try {
      await state.nativePDFAdapter.navigate(page - 1);
    }
    catch (error) {
      setStatus(state.globalStatus,
        safeError(error).message, "error");
    }
  }
  function buildWindow(targetWindow, targetDocument) {
    state.document = targetDocument;
    state.window = targetWindow;
    targetDocument.title = "Reading Room · 论文阅读室";
    targetDocument.documentElement.removeAttribute("windowtype");
    const head = documentHead(targetDocument);
    const body = documentBody(targetDocument);
    if (!head || !body) {
      throw new Error("阅读室页面缺少 XHTML head/body 节点。");
    }
    const embedded = state.nativeContext && state.nativeContext.embedded === true;
    targetDocument.documentElement.setAttribute(
      "data-embedded", embedded ? "true" : "false");
    const css = currentDocument().createElementNS(XHTML_NS, "link");
    css.setAttribute("rel", "stylesheet");
    css.setAttribute("href", state.cssURL);
    head.append(css);

    const app = make("main", "rr-app");
    const header = make("header", "rr-topbar");
    const identity = make("div", "rr-identity");
    const icon = currentDocument().createElementNS(XHTML_NS, "img");
    icon.setAttribute("src", state.iconURL);
    icon.setAttribute("alt", "");
    identity.append(icon, make("div", "rr-brand-copy"));
    identity.lastElementChild.append(
      make("strong", null, "Reading Room"),
      make("span", null, embedded
        ? "论文阅读室 · Zotero 右侧栏"
        : "论文阅读室 · 原文与 AI 对照"),
    );
    const headerActions = make("div", "rr-header-actions");
    const promptButton = makeApiButton("分析提示词", "rr-secondary",
      () => void openPromptSettings(),
      "查看、编辑或恢复 AI 分析提示词");
    const modelButton = makeApiButton("模型设置", "rr-secondary",
      () => void openModelSettings());
    headerActions.append(promptButton, modelButton);
    if (!embedded) {
      headerActions.append(
        makeApiButton("导出 JSON", "rr-secondary",
          () => void chooseExport("json")),
        makeApiButton("导出 Markdown", "rr-secondary",
          () => void chooseExport("md")),
      );
    }
    header.append(identity, headerActions);
    app.append(header);

    const globalStatus = make("div", "rr-message");
    setHidden(globalStatus, true);
    app.append(globalStatus);
    const batchMonitor = make("div", "rr-batch-monitor");
    setHidden(batchMonitor, true);
    app.append(batchMonitor);

    const workspace = make("div", embedded
      ? "rr-workspace rr-workspace-embedded" : "rr-workspace");
    const navigation = make("aside", "rr-navigation");
    const navigationHead = make("div", "rr-navigation-head");
    const navigationTitle = make("h2", null, "论文目录");
    navigationHead.append(navigationTitle);
    const setNavigationCollapsed = collapsed => {
      state.navigationCollapsed = collapsed;
      setClass(workspace, (embedded ? "rr-workspace rr-workspace-embedded" : "rr-workspace")
        + (collapsed ? " navigation-collapsed" : ""));
      setClass(navigation, "rr-navigation"
        + (collapsed ? " collapsed" : ""));
      setHidden(navigationTitle, collapsed);
      collapse.textContent = collapsed ? "展开" : "收起";
      collapse.setAttribute("aria-expanded", String(!collapsed));
      collapse.setAttribute("aria-label", collapsed ? "展开论文目录" : "收起论文目录");
      if (!collapsed) navigationTitle.focus?.();
    };
    const collapse = makeApiButton("收起", "rr-icon-button",
      () => setNavigationCollapsed(!state.navigationCollapsed));
    collapse.setAttribute("aria-expanded", "true");
    navigationHead.append(collapse);
    navigation.append(navigationHead);
    const navigationBody = make("div", "rr-navigation-body");
    const search = currentDocument().createElementNS(
      XHTML_NS, "input",
    );
    search.setAttribute("type", "search");
    search.setAttribute("placeholder",
      "搜索标题、作者、年份、DOI…");
    search.setAttribute("aria-label", "搜索文库论文");
    const librarySelect = currentDocument().createElementNS(
      XHTML_NS, "select",
    );
    librarySelect.setAttribute("aria-label", "选择文库");
    const libraryChoice = makeChoice(librarySelect, {
      label: "选择文库", className: "rr-library-choice",
    });
    const collectionSelect = currentDocument().createElementNS(
      XHTML_NS, "select",
    );
    collectionSelect.setAttribute("aria-label", "当前收藏夹");
    const collectionChoice = makeChoice(collectionSelect, {
      label: "当前收藏夹", className: "rr-collection-choice",
    });
    const collectionTree = make("div", "rr-collection-tree");
    collectionTree.setAttribute("role", "tree");
    collectionTree.setAttribute("aria-label", "Zotero 文库与收藏夹");
    const catalogScope = make("div", "rr-catalog-scope", "全部可访问文库");
    const filters = make("div", "rr-catalog-filters");
    const allFilter = makeApiButton(
      "全部", "rr-filter active", () => setCatalogFilter(false),
    );
    const focusFilter = makeApiButton(
      "★ 关注", "rr-filter", () => setCatalogFilter(true),
    );
    filters.append(allFilter, focusFilter);
    const focusedChips = make("div", "rr-focus-chips");
    focusedChips.append(make("span", "rr-chip-empty",
      "关注论文后会显示在这里。"));
    const selectionBar = make("div", "rr-selection-bar");
    const selectionCount = make("strong", null, "已选 0 篇");
    const selectPageButton = makeApiButton(
      "选择当前页", "rr-link-button", () => void selectCurrentPage(),
    );
    const addFilteredButton = makeApiButton(
      "加入当前筛选全部", "rr-link-button",
      () => void addFilteredSelection(),
    );
    const clearSelectionButton = makeApiButton(
      "清空选择", "rr-link-button", clearBatchSelection,
    );
    const batchButton = makeApiButton(
      "批量 AI 分析", "rr-button-primary",
      () => void openBatchReview(),
      "先核对明确选择的目标，再启动分析",
    );
    const batchStateButton = makeApiButton(
      "批次状态", "rr-link-button",
      () => void openBatchReview({ targets: [], title: "批量分析状态" }),
      "查看上次批次的逐篇结果",
    );
    selectionBar.append(
      selectionCount,
      selectPageButton,
      addFilteredButton,
      clearSelectionButton,
      batchButton,
      batchStateButton,
    );
    const selectionStatus = make("div",
      "rr-message rr-selection-status");
    setHidden(selectionStatus, true);
    const paperList = make("div", "rr-paper-list");
    const pager = make("div", "rr-pager");
    const prevButton = makeApiButton("上一页", "rr-secondary", () => {
      state.catalog.offset = Math.max(
        0, state.catalog.offset - PAGE_SIZE,
      );
      void loadCatalog();
    });
    const catalogCount = make("span", "rr-muted", "0 篇");
    const nextButton = makeApiButton("下一页", "rr-secondary", () => {
      state.catalog.offset += PAGE_SIZE;
      void loadCatalog();
    });
    pager.append(prevButton, catalogCount, nextButton);
    navigationBody.append(
      search,
      libraryChoice.root,
      collectionChoice.root,
      collectionTree,
      catalogScope,
      filters,
      make("h3", "rr-nav-label", "快速切换"),
      focusedChips,
      selectionBar,
      selectionStatus,
      paperList,
      pager,
    );
    navigation.append(navigationBody);

    const reading = make("section", "rr-reading-workspace");
    const paperHead = make("header", "rr-paper-head");
    const titleBlock = make("div", "rr-title-block");
    const title = make("h1", null, "选择一篇论文");
    const subtitle = make("p", null,
      "从左侧文库目录选择，或使用 Zotero 条目菜单打开。");
    titleBlock.append(title, subtitle);
    const counts = make("span", "rr-count-badge", "");
    paperHead.append(titleBlock, counts);
    reading.append(paperHead);

    const readingGrid = make("div", embedded
      ? "rr-reading-grid rr-reading-grid-embedded" : "rr-reading-grid");
    const sourcePane = make("section", "rr-source-pane");
    const sourceHead = make("div", "rr-pane-head");
    sourceHead.append(make("h2", null, "论文原文"));
    const sourceControls = make("div", "rr-source-controls");
    const prevPage = makeApiButton(
      "‹", "rr-icon-button", () => void changePdfPage(-1), "上一页",
    );
    prevPage.setAttribute("aria-label", "上一页");
    const pageInput = currentDocument().createElementNS(
      XHTML_NS, "input",
    );
    pageInput.setAttribute("type", "number");
    pageInput.setAttribute("min", "1");
    pageInput.setAttribute("aria-label", "PDF 页码");
    setValue(pageInput, "1");
    const nextPage = makeApiButton(
      "›", "rr-icon-button", () => void changePdfPage(1), "下一页",
    );
    nextPage.setAttribute("aria-label", "下一页");
    const jump = makeApiButton(
      "跳转", "rr-link-button", () => void jumpPdfPage(),
    );
    const fitPage = makeApiButton("适合页", "rr-icon-button", () => {
      setStatus(state.globalStatus,
        "原文由 Zotero 原生阅读器管理缩放；请在左侧 PDF 工具栏调整。",
        "warning");
    });
    const fitWidth = makeApiButton("适合宽", "rr-icon-button", () => {
      setStatus(state.globalStatus,
        "原文由 Zotero 原生阅读器管理缩放；请在左侧 PDF 工具栏调整。",
        "warning");
    });
    const openZoteroButton = makeApiButton(
      "在 Zotero 打开",
      "rr-secondary",
      () => void openZoteroAttachment(),
    );
    sourceControls.append(
      prevPage,
      pageInput,
      nextPage,
      jump,
      fitPage,
      fitWidth,
      openZoteroButton,
    );
    sourceHead.append(sourceControls);
    const pdfHost = make("div", "rr-pdf-host");
    pdfHost.append(make(
      "div",
      "rr-reader-placeholder",
      "从左侧选择论文以载入 PDF。",
    ));
    sourcePane.append(sourceHead, pdfHost);

    const splitter = make("div", "rr-splitter");
    splitter.setAttribute("role", "separator");
    splitter.setAttribute("aria-orientation", "vertical");
    splitter.setAttribute("tabindex", "0");

    const insightPane = make("section", "rr-insight-pane");
    const insightHead = make("div", "rr-pane-head");
    insightHead.append(make("h2", null, "AI 解读与笔记"));
    const analysisActions = make("div", "rr-analysis-actions");
    const aiButton = makeApiButton(
      "AI 分析",
      "rr-button-primary",
      () => void runAnalysis(),
      "使用已保存的模型设置；有缓存时直接复用",
    );
    const reanalyzeButton = makeApiButton(
      "重新分析",
      "rr-secondary",
      () => void runAnalysis({ force: true }),
      "明确请求新的模型分析",
    );
    const cancelButton = makeApiButton(
      "取消", "rr-danger", cancelAnalysis,
    );
    setHidden(cancelButton, true);
    analysisActions.append(aiButton, reanalyzeButton, cancelButton);
    insightHead.append(analysisActions);
    const insightBody = make("div", "rr-insight-body");
    const aiStatus = make("div", "rr-message");
    setHidden(aiStatus, true);
    const aiResults = make("div", "rr-analysis-results");
    aiResults.append(make("div", "rr-empty",
      "选择论文后查看已保存的 AI 解读。"));

    const chatSection = make("section", "rr-chat-panel");
    const chatHead = make("div", "rr-section-head");
    chatHead.append(
      make("h2", null, "论文对话"),
      make("span", "rr-muted", "仅基于当前 PDF"),
    );
    const chatNotice = make("div", "rr-callout rr-warning");
    chatNotice.textContent = "打开、切换论文或加载历史不会调用模型。点击发送后才会把问题与有界原文片段发送到已配置模型；无核验来源的回答会明确标记。";
    const chatMessages = make("div", "rr-chat-messages");
    chatMessages.setAttribute("role", "log");
    chatMessages.setAttribute("aria-live", "polite");
    const chatInput = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    chatInput.setAttribute("rows", "3");
    chatInput.setAttribute("maxlength", "6000");
    chatInput.setAttribute("placeholder",
      "询问研究问题、方法、证据、限制或与其他工作的关系…");
    chatInput.setAttribute("aria-label", "询问当前论文");
    const chatActions = make("div", "rr-chat-actions");
    const chatSendButton = makeApiButton(
      "发送", "rr-button-primary", () => void sendChat());
    const chatCancelButton = makeApiButton(
      "取消对话", "rr-danger", cancelOwnedChat);
    setBooleanAttribute(chatCancelButton, "disabled", true);
    chatActions.append(chatCancelButton, chatSendButton);
    const chatStatus = make("div", "rr-message");
    setHidden(chatStatus, true);
    chatSection.append(
      chatHead, chatNotice, chatMessages, chatInput, chatActions, chatStatus,
    );

    const notesSection = make("section", "rr-notes-panel");
    const notesHead = make("div", "rr-section-head");
    notesHead.append(make("h2", null, "阅读笔记"));
    const updated = make("span", "rr-muted", "尚未保存");
    notesHead.append(updated);
    const statusChoices = make("div", "rr-status-choices");
    const attachmentField = make(
      "label", "rr-field rr-attachment-field",
    );
    attachmentField.append(make(
      "span", "rr-field-label", "用于原文与分析的本地 PDF",
    ));
    const attachmentSelect = currentDocument().createElementNS(
      XHTML_NS, "select",
    );
    setValue(attachmentSelect, "");
    const attachmentChoice = makeChoice(attachmentSelect, {
      label: "选择用于原文与分析的本地 PDF",
      className: "rr-attachment-choice",
    });
    attachmentField.append(attachmentChoice.root);
    const notesLabel = make("label", "rr-field rr-notes-field");
    notesLabel.append(make(
      "span", "rr-field-label", "阅读笔记 · 切换论文前自动保存",
    ));
    const notesInput = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    notesInput.setAttribute("rows", "8");
    notesInput.setAttribute(
      "placeholder",
      "记录问题、方法、证据、可复用观点和待核查项…",
    );
    notesInput.setAttribute("spellcheck", "true");
    notesLabel.append(notesInput);
    const notesStatus = make("div", "rr-message");
    setHidden(notesStatus, true);
    const checklist = make("div", "rr-checklist");
    const checklistStatus = make("div", "rr-message");
    setHidden(checklistStatus, true);
    notesSection.append(
      notesHead,
      statusChoices,
      attachmentField,
      notesLabel,
      notesStatus,
      checklist,
      checklistStatus,
    );

    const noteActions = make("div", "rr-note-actions");
    const noteButton = makeApiButton(
      "保存为新的 Zotero 分析笔记",
      "rr-secondary",
      () => void saveAnalysisNote(),
      "仅在点击时创建插件专用分析笔记",
    );
    const syncButton = makeApiButton(
      "同步阅读记录到个人库笔记",
      "rr-secondary",
      () => void syncStateNote(),
      "仅在点击时创建或更新插件专用阅读状态快照",
    );
    noteActions.append(noteButton, syncButton);
    const noteStatus = make("div", "rr-message");
    setHidden(noteStatus, true);

    const details = currentDocument().createElementNS(
      XHTML_NS, "details",
    );
    setClass(details, "rr-metadata-details");
    details.append(make("summary", null, "文献元数据"));
    const metadata = make("section", "rr-card rr-metadata");
    metadata.append(make("h2", null, "文献信息"));
    details.append(metadata);
    const exportStatus = make("div", "rr-message");
    setHidden(exportStatus, true);
    insightBody.append(
      aiStatus,
      chatSection,
      aiResults,
      notesSection,
      noteActions,
      noteStatus,
      details,
      exportStatus,
    );
    insightPane.append(insightHead, insightBody);
    if (embedded) {
      readingGrid.append(insightPane);
    }
    else {
      readingGrid.append(sourcePane, splitter, insightPane);
    }
    reading.append(readingGrid);
    workspace.append(navigation, reading);
    app.append(workspace);
    body.replaceChildren(app);

    state = Object.assign(state, {
      chatMessages,
      navigation,
      navigationBody,
      searchInput: search,
      workspace,
      navigationCollapsed: false,
      librarySelect,
      libraryChoice: libraryChoice.binding,
      collectionSelect,
      collectionChoice: collectionChoice.binding,
      collectionTree,
      catalogScope,
      selectionBar,
      selectionCount,
      selectionStatus,
      selectPageButton,
      addFilteredButton,
      clearSelectionButton,
      batchButton,
      batchStateButton,
      batchMonitor,
      modelButton,
      promptButton,
      libraries: [],
      collections: [],
      expandedCollections: new Set(),
      collectionsLoading: false,
      collectionsError: "",
      splitPercent: 52,
      allFilter,
      focusFilter,
      focusedChips,
      paperList,
      prevButton,
      nextButton,
      catalogCount,
      title,
      subtitle,
      counts,
      metadata,
      statusChoices,
      attachmentSelect,
      notesInput,
      notesStatus,
      checklist,
      checklistStatus,
      updated,
      globalStatus,
      aiButton,
      reanalyzeButton,
      cancelButton,
      aiStatus,
      aiResults,
      chatSection,
      chatMessages,
      chatInput,
      chatSendButton,
      chatCancelButton,
      chatStatus,
      chatLoading: false,
      noteButton,
      syncButton,
      noteStatus,
      exportStatus,
      pageInput,
      openZoteroButton,
      pdfHost,
      sourcePane,
      insightPane,
      readingGrid,
      currentItem: null,
      currentPaper: null,
      description: null,
      currentAttachmentID: null,
      nativePDFAdapter: null,
      nativePreview: null,
      analyzing: false,
      saving: false,
      navigationCollapsed: false,
      catalog: {
        items: [], total: 0, offset: 0, limit: PAGE_SIZE,
        query: "", focusOnly: false,
      },
      focusedPapers: [],
      selectedPapers: new Map(),
      selectionLoading: false,
      batchState: { id: null, status: "idle", entries: [] },
      batchDialog: null,
      catalogLoading: false,
      window: targetWindow,
      document: targetDocument,
    });
    try {
      if (typeof state.service.getBatchState === "function") {
        state.batchState = state.service.getBatchState();
        renderBatchMonitor();
      }
    }
    catch (error) {
      logError("load persisted batch state", error);
    }
    renderChat(null);
    if (embedded) setNavigationCollapsed(true);

    search.addEventListener("input", () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        searchTimer = null;
        state.catalog.offset = 0;
        void loadCatalog();
      }, 280);
    });
    librarySelect.addEventListener("change", () => {
      const libraryValue = getValue(librarySelect);
      const library = state.libraries.find(entry =>
        String(entry.id) === libraryValue);
      setValue(collectionSelect, "");
      collectionChoice.binding.syncSelection("");
      state.libraryChoice.syncSelection(libraryValue);
      void (async () => {
        await loadCollections(library ? library.id : null);
        resetCatalogScope();
      })();
    });
    collectionSelect.addEventListener("change", () => {
      const collectionID = getValue(collectionSelect);
      const collection = state.collections.find(entry =>
        String(entry.id) === collectionID);
      if (collection) {
        setValue(librarySelect, String(collection.libraryID));
        libraryChoice.binding.syncSelection(getValue(librarySelect));
      }
      collectionChoice.binding.syncSelection(collectionID);
      resetCatalogScope();
    });
    notesInput.addEventListener("input", scheduleNotesSave);
    attachmentSelect.addEventListener("change", () => {
      const id = Number(getValue(attachmentSelect));
      state.currentAttachmentID =
        Number.isInteger(id) && id > 0 ? id : null;
      if (state.description) {
        if (typeof state.service.getState === "function") {
          state.description.state = state.service.getState(state.currentItem);
        }
        state.description.state.analysis = analysisForAttachment(state.description, state.currentAttachmentID);
        renderAnalysis(state.description.state.analysis);
      }
      chatGeneration++;
      if (chatController) {
        try { chatController.abort(); } catch (_) {}
        chatController = null;
      }
      if (state.chatLoading && state.currentItem && typeof state.service.cancelChat === "function") {
        try { state.service.cancelChat(state.currentItem); } catch (_) {}
      }
      state.chatLoading = false;
      renderChat(null);
      if (state.currentItem) {
        void (async () => {
          await destroyPdf();
          const generation = loadGeneration;
          try {
            const attachment = await state.service.getReaderAttachment(
              state.currentItem,
              { attachmentID: state.currentAttachmentID },
            );
            if (generation !== loadGeneration || !state) return;
            setNativePDFAdapter(attachment, generation);
            state.openZoteroButton.disabled = !attachment;
            await loadConversation(generation);
            syncActionLocks();
          }
          catch (error) {
            state.pdfHost.replaceChildren(make(
              "div", "rr-reader-empty", safeError(error).message,
            ));
            setStatus(state.chatStatus,
              safeError(error).message, "error");
          }
        })();
      }
      setStatus(
        state.aiStatus,
        state.currentAttachmentID
          ? "已切换阅读附件；已有分析不会被删除。"
          : "没有可用的本地 PDF。",
        state.currentAttachmentID ? "" : "warning",
      );
    });
    splitter.addEventListener("keydown", event => {
      if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      const width = Math.max(
        28,
        Math.min(
          72,
          (state.splitPercent || 52)
            + (event.key === "ArrowRight" ? 4 : -4),
        ),
      );
      setSplitPercent(width);
    });
    let dragStartX = null;
    let dragStartPercent = 52;
    const finishSplitDrag = () => {
      dragStartX = null;
      setClass(splitter, "rr-splitter");
    };
    splitter.addEventListener("pointerdown", event => {
      if (event.button != null && event.button !== 0) return;
      event.preventDefault();
      dragStartX = Number(event.clientX) || 0;
      dragStartPercent = state.splitPercent || 52;
      setClass(splitter, "rr-splitter dragging");
      splitter.setPointerCapture?.(event.pointerId);
    });
    splitter.addEventListener("pointermove", event => {
      if (dragStartX == null || !readingGrid.getBoundingClientRect) return;
      const rect = readingGrid.getBoundingClientRect();
      if (!rect || !rect.width) return;
      const delta = (Number(event.clientX) - dragStartX) / rect.width * 100;
      setSplitPercent(dragStartPercent + delta);
    });
    splitter.addEventListener("pointerup", finishSplitDrag);
    splitter.addEventListener("pointercancel", finishSplitDrag);
    bindChoiceOutsideDismiss();
    renderCollectionTree();
    renderCatalogScope();
    setBusy(false);
  }
  function setCatalogFilter(focusOnly) {
    if (!state) return;
    if (batchIsRunning()) {
      selectionStatus(
        "批量分析运行期间可以浏览目录，但不能切换选择范围。",
        "warning",
      );
      return;
    }
    state.catalog.focusOnly = focusOnly === true;
    state.catalog.offset = 0;
    setClass(state.allFilter,
      "rr-filter" + (!focusOnly ? " active" : ""));
    setClass(state.focusFilter,
      "rr-filter" + (focusOnly ? " active" : ""));
    void loadCatalog();
  }
  function resetCatalogScope() {
    state.catalog.offset = 0;
    state.catalog.items = [];
    state.catalog.total = 0;
    state.catalog.query = getValue(state.searchInput).trim();
    renderCatalogScope();
    renderCollectionTree();
    void loadCatalog();
  }
  async function selectLibrary(library) {
    if (!state || !library) return;
    setValue(state.librarySelect, String(library.id));
    setValue(state.collectionSelect, "");
    state.libraryChoice.syncSelection(getValue(state.librarySelect));
    state.collectionChoice.syncSelection("");
    await loadCollections(library.id);
    resetCatalogScope();
  }
  async function selectCollection(collection) {
    if (!state || !collection) return;
    try {
      await flushPendingEdits();
    }
    catch (error) {
      setStatus(
        state.globalStatus,
        `切换已取消：当前笔记保存失败（${safeError(error).message}）。`,
        "error",
      );
      return;
    }
    setValue(state.librarySelect, String(collection.libraryID));
    setValue(state.collectionSelect, String(collection.id));
    state.libraryChoice.syncSelection(getValue(state.librarySelect));
    state.collectionChoice.syncSelection(getValue(state.collectionSelect));
    resetCatalogScope();
  }
  function setSplitPercent(value) {
    if (!state) return;
    if (state.nativeContext && state.nativeContext.embedded) return;
    const width = Math.max(28, Math.min(72, Number(value) || 52));
    state.splitPercent = width;
    state.readingGrid.setAttribute(
      "style",
      `grid-template-columns: minmax(0, ${width}fr) 6px minmax(0, ${100 - width}fr);`,
    );
    if (pdfResizeTimer != null) clearTimeout(pdfResizeTimer);
    pdfResizeTimer = setTimeout(() => {
      pdfResizeTimer = null;
    }, 120);
  }
  function selectedHostScope() {
    try {
      const win = Zotero.getMainWindow();
      const pane = win && win.ZoteroPane;
      if (!pane) return null;
      const libraryID = typeof pane.getSelectedLibraryIDs === "function"
        ? Number(pane.getSelectedLibraryIDs()[0])
        : typeof pane.getSelectedLibraryID === "function" ? Number(pane.getSelectedLibraryID()) : null;
      const collection = typeof pane.getSelectedCollections === "function"
        ? pane.getSelectedCollections()[0]
        : typeof pane.getSelectedCollection === "function" ? pane.getSelectedCollection() : null;
      if (collection && Number.isSafeInteger(Number(collection.id))) {
        return {
          libraryID: Number(collection.libraryID),
          collectionID: Number(collection.id),
        };
      }
      return Number.isSafeInteger(libraryID) && libraryID > 0
        ? { libraryID, collectionID: null } : null;
    }
    catch (error) {
      logError("read host collection scope", error);
      return null;
    }
  }
  async function loadLibraries() {
    if (!state) return;
    try {
      const libraries = await state.service.listLibraries();
      state.libraries = Array.isArray(libraries) ? libraries : [];
      state.librarySelect.replaceChildren();
      state.libraryChoice.close(false);
      const all = currentDocument().createElementNS(
        XHTML_NS, "option",
      );
      setValue(all, "");
      all.textContent = "全部可访问文库";
      state.librarySelect.append(all);
      for (const library of state.libraries) {
        const option = currentDocument().createElementNS(
          XHTML_NS, "option",
        );
        setValue(option, String(library.id));
        option.textContent = `${library.name || "未命名文库"}${library.type === "group" ? " · 群组" : ""}`;
        state.librarySelect.append(option);
      }
      setValue(state.librarySelect, "");
      state.libraryChoice.syncOptions();
      const hostScope = selectedHostScope();
      if (hostScope && state.libraries.some(
        library => Number(library.id) === hostScope.libraryID,
      )) {
        setValue(state.librarySelect, String(hostScope.libraryID));
        state.libraryChoice.syncSelection(getValue(state.librarySelect));
        await loadCollections(hostScope.libraryID);
        if (hostScope.collectionID
            && state.collections.some(entry =>
              Number(entry.id) === hostScope.collectionID)) {
          setValue(state.collectionSelect, String(hostScope.collectionID));
          state.collectionChoice.syncSelection(
            getValue(state.collectionSelect),
          );
          const selected = state.collections.find(entry => entry.id === hostScope.collectionID);
          let parent = state.collections.find(entry => entry.id === selected?.parentID);
          const seen = new Set();
          while (parent && !seen.has(parent.id)) {
            seen.add(parent.id);
            state.expandedCollections.add(parent.id);
            parent = state.collections.find(entry => entry.id === parent.parentID);
          }
        }
      }
      else await loadCollections(null);
      renderCollectionTree();
      renderCatalogScope();
    }
    catch (error) {
      state.librarySelect.replaceChildren(
        make("option", null, "文库读取失败"),
      );
      state.libraryChoice.syncOptions();
      setStatus(state.globalStatus, safeError(error).message, "error");
    }
  }
  async function loadCollections(libraryID) {
    if (!state) return;
    const generation = ++collectionsGeneration;
    state.collectionsLoading = true;
    state.collectionsError = "";
    renderCollectionTree();
    try {
      if (typeof state.service.listCollections !== "function") {
        throw Object.assign(new Error("当前服务版本不支持收藏夹目录。"), {
          code: "COLLECTIONS_UNAVAILABLE",
        });
      }
      const rows = await state.service.listCollections({
        libraryID: null,
      });
      if (!state || generation !== collectionsGeneration) return;
      state.collections = Array.isArray(rows) ? rows.filter(row =>
        row && Number.isSafeInteger(Number(row.id))
        && Number.isSafeInteger(Number(row.libraryID))) : [];
      state.collectionSelect.replaceChildren();
      state.collectionChoice.close(false);
      const root = currentDocument().createElementNS(
        XHTML_NS, "option",
      );
      setValue(root, "");
      root.textContent = "当前文库全部论文";
      state.collectionSelect.append(root);
      const visible = state.collections;
      for (const collection of visible) {
        const option = currentDocument().createElementNS(
          XHTML_NS, "option",
        );
        setValue(option, String(collection.id));
        const names = [];
        const seen = new Set();
        let current = collection;
        while (current && !seen.has(current.id)) {
          seen.add(current.id);
          names.unshift(current.name || "未命名收藏夹");
          current = state.collections.find(row => row.id === current.parentID
            && row.libraryID === collection.libraryID);
        }
        const library = state.libraries.find(row => row.id === collection.libraryID);
        option.textContent = [library?.name || "文库", ...names].join(" / ");
        state.collectionSelect.append(option);
      }
      state.collectionChoice.syncOptions();
      const selected = getValue(state.collectionSelect);
      if (selected && !visible.some(entry =>
        String(entry.id) === selected)) {
        setValue(state.collectionSelect, "");
        state.collectionChoice.syncSelection("");
      }
    }
    catch (error) {
      if (!state || generation !== collectionsGeneration) return;
      const safe = safeError(error);
      state.collections = [];
      state.collectionsError = safe.message;
      state.collectionSelect.replaceChildren();
      const root = currentDocument().createElementNS(
        XHTML_NS, "option",
      );
      setValue(root, "");
      root.textContent = "当前文库全部论文";
      state.collectionSelect.append(root);
      state.collectionChoice.syncOptions();
      if (!["COLLECTIONS_UNAVAILABLE"].includes(safe.code)) {
        setStatus(state.globalStatus, safe.message, "error");
      }
    }
    finally {
      if (state && generation === collectionsGeneration) {
        state.collectionsLoading = false;
        renderCollectionTree();
        renderCatalogScope();
      }
    }
  }
  function runtimeContext(targetWindow) {
    try {
      if (targetWindow && targetWindow.ReadingRoomNativeContext) {
        return { ...targetWindow.ReadingRoomNativeContext };
      }
      const parent = targetWindow && targetWindow.parent;
      if (parent && parent !== targetWindow && parent.ReadingRoomNativeContext) {
        return { ...parent.ReadingRoomNativeContext };
      }
      const search = new URL(String(targetWindow && targetWindow.location || "")).searchParams;
      return {
        embedded: search.get("embedded") === "1",
        itemID: Number(search.get("itemID")) || null,
        tabID: search.get("tabID") || null,
      };
    }
    catch (_) {
      return { embedded: false, itemID: null, tabID: null };
    }
  }
  function disposeRuntime() {
    const view = state;
    if (!view) return;
    loadGeneration++;
    catalogGeneration++;
    collectionsGeneration++;
    selectionGeneration++;
    chatGeneration++;
    closeOpenChoices();
    disposeChoices(view.document && view.document.documentElement);
    if (noteTimer) clearTimeout(noteTimer);
    if (checklistTimer) clearTimeout(checklistTimer);
    if (searchTimer) clearTimeout(searchTimer);
    if (pdfResizeTimer != null) clearTimeout(pdfResizeTimer);
    noteTimer = checklistTimer = searchTimer = null;
    pdfResizeTimer = null;
    if (chatController) {
      try { chatController.abort(); } catch (_) {}
      chatController = null;
    }
    if (view.chatLoading && view.currentItem && view.service && typeof view.service.cancelChat === "function") {
      try { view.service.cancelChat(view.currentItem); } catch (_) {}
    }
    if (activeJob && view.currentItem && view.service) {
      try { view.service.cancelAnalysis(view.currentItem); } catch (_) {}
    }
    if (activeBatch && view.service) {
      try { view.service.cancelBatch(); } catch (_) {}
    }
    activeJob = activeBatch = null;
    if (aiConfigSession) {
      const session = aiConfigSession;
      session.finished = true;
      session.generation++;
      if (session.timer != null) clearTimeout(session.timer);
      try { session.controller?.abort(); } catch (_) {}
      if (typeof session.close === "function") {
        try { session.close(); } catch (_) {}
      }
      aiConfigSession = null;
    }
    const flushed = typeof flushPendingEdits === "function"
      ? flushPendingEdits().catch(error => logError("flush disposed view", error))
      : Promise.resolve();
    const previewDestroyed = destroyPdf();
    state = null;
    started = false;
    ownsShutdown = false;
    try {
      if (view.window && view.window.ReadingRoomWindow) {
        delete view.window.ReadingRoomWindow;
      }
    }
    catch (_) {}
    return Promise.allSettled([flushed, previewDestroyed]);
  }
  function start(options = {}) {
    const targetWindow = options.window || mainWindow;
    const targetDocument = options.document
      || (targetWindow && targetWindow.document);
    if (!targetWindow || !targetDocument) return;
    const context = options.nativeContext || runtimeContext(targetWindow);
    if (targetWindow.ReadingRoomWindow
        && targetWindow.ReadingRoomWindow._started) {
      if (options.itemID) {
        targetWindow.ReadingRoomWindow.selectItem(
          Zotero.Items.get(Number(options.itemID)),
        );
      }
      if (targetWindow.ReadingRoomWindow.updateContext && context) {
        targetWindow.ReadingRoomWindow.updateContext(context);
      }
      return;
    }
    state.nativeContext = context;
    buildWindow(targetWindow, targetDocument);
    targetWindow.ReadingRoomWindow = {
      _started: true,
      selectItem: item => selectHostItem(item),
      show,
      dispose: disposeRuntime,
      updateContext(next) {
        if (!state || !next) return;
        state.nativeContext = { ...state.nativeContext, ...next };
      },
    };
    void (async () => {
      await loadLibraries();
      await loadCatalog();
      let selected = null;
      try {
        const win = Zotero.getMainWindow();
        selected = options.itemID || context.itemID
          ? Zotero.Items.get(Number(options.itemID || context.itemID))
          : selectedPaneItem(win);
      }
      catch (error) {
        logError("initial selection", error);
      }
      if (selected) await selectItem(selected);
    })();
    targetWindow.addEventListener("unload", disposeRuntime, { once: true });
  }
  scope.ReadingRoomUI = Object.freeze({
    startup,
    shutdown,
    show,
    mountWindow,
    window: () => null,
    onMainWindowLoad,
    onMainWindowUnload,
  });
  scope.ReadingRoomWindow = Object.freeze({
    start,
    selectItem: item => selectHostItem(item),
    dispose: disposeRuntime,
  });
})(this);
