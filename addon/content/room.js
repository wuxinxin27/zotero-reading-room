/* global ChromeUtils, IOUtils, Services, Zotero */
(function (scope) {
  "use strict";

  const XHTML_NS = "http://www.w3.org/1999/xhtml";
  const STATUS_LABELS = Object.freeze({
    unread: "未读",
    to_read: "待读",
    reading: "在读",
    read: "已读",
    parked: "搁置",
  });
  const DIMENSION_IDS = Object.freeze([
    "problem", "novelty", "contributions",
    "prior-work", "superiority", "technical-uniqueness",
  ]);
  const DEFAULT_PROVIDER = "openai";
  const OPENAI_LEGACY_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
  const MODEL_DISCOVERY_DELAY = 700;
  const PROMPT_SYSTEM_LIMIT = 40000;
  const PROMPT_SYNTHESIS_LIMIT = 4000;
  const FALLBACK_API_PROVIDERS = Object.freeze([
    { id: "openai", label: "OpenAI 兼容 API", defaultEndpoint: OPENAI_LEGACY_ENDPOINT, endpointHint: "可填写 base URL，或旧的完整 chat completions 地址。" },
    { id: "anthropic", label: "Anthropic Messages API", defaultEndpoint: "https://api.anthropic.com/v1", endpointHint: "填写 Anthropic API base URL。" },
    { id: "gemini", label: "Google Gemini API", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", endpointHint: "填写 Gemini API base URL。" },
    { id: "ollama", label: "Ollama API", defaultEndpoint: "http://127.0.0.1:11434", endpointHint: "填写本机 Ollama API 地址。" },
  ]);

  let state = null;
  let activeJob = null;
  let analysisController = null;
  let contextGeneration = 0;
  let contextUpdate = Promise.resolve();
  let noteTimer = null;
  let notesDirty = false;
  let aiConfigSession = null;
  let dialogSequence = 0;
  const dialogClosers = new Set();
  let loadGeneration = 0;
  let started = false;
  let choiceSequence = 0;
  let chatController = null;
  let chatClearController = null;
  let chatClearSession = null;
  let chatClearDialog = null;
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
  function taskErrorText(task, error) {
    const safe = safeError(error);
    return `${task}失败 [${safe.code}]：${fixedTaskErrorMessage(task, safe)}`;
  }
  const fixedTaskErrorMessages = Object.freeze({
    MODEL_OUTPUT_TRUNCATED:
      "模型输出被长度限制截断；请提高模型输出上限或精简提示词后重试。",
    MODEL_OUTPUT_INCOMPLETE:
      "模型响应尚未完成；请检查服务完成状态后重试。",
    MODEL_OUTPUT_REFUSED:
      "模型服务拒答或触发安全拦截；请核对请求内容及服务设置。",
    MODEL_OUTPUT_TOOL_ONLY:
      "模型返回了工具调用；请使用支持直接文本回答的模型或配置。",
    MODEL_JSON_INVALID:
      "模型正文不是完整、无歧义的 JSON 对象；请检查提示词及服务是否保留任务指令后重试。",
    MODEL_SCHEMA_INVALID:
      "模型 JSON 的 dimensions 数组缺失、类型错误或条目数超限；请检查分析提示词与模型输出。",
    INVALID_MODEL_OUTPUT:
      "模型响应未通过格式与安全检查；可能是输出、凭据或传输问题，请检查模型服务后重试。",
    MODEL_REQUEST_FAILED:
      "模型请求失败，请检查服务后重试。",
    MODEL_AUTH_FAILED:
      "模型服务拒绝凭据，请检查 API 密钥。",
    CHAT_ANSWER_INVALID:
      "模型未返回有效的 answer 文本；请核对对话提示词及模型输出。",
    CHAT_ANSWER_TOO_LONG:
      "模型 answer 超过 12000 字符；请要求模型精简回答后重试。",
    CHAT_EVIDENCE_INVALID:
      "模型 evidence 格式无效；请核对对话提示词及模型输出。",
    CHAT_EVIDENCE_TOO_MANY:
      "模型 evidence 超过 16 条；请要求模型减少引文后重试。",
    CHAT_STRUCTURE_INVALID:
      "模型返回了错误的任务结构；论文对话需要 answer 与 evidence。",
  });
  function fixedTaskErrorMessage(task, safe) {
    if (Object.hasOwn(fixedTaskErrorMessages, safe.code)) {
      return fixedTaskErrorMessages[safe.code];
    }
    if (safe.code === "CANCELLED") {
      return task === "对话" ? "对话已取消。" : "分析已取消。";
    }
    return task === "对话"
      ? "对话未完成；此前保存的问答仍保留。"
      : "分析未完成；此前的阅读状态与分析仍保留。";
  }
  // Clearing is destructive, so it never forwards a backend or transport
  // message: only a fixed, user-facing sentence per known code.
  function clearChatErrorText(error) {
    const code = safeError(error).code;
    if (code === "CHAT_RUNNING") {
      return "清空对话失败 [CHAT_RUNNING]：此文献在其他标签页仍有对话请求；"
        + "请等待它结束或取消后再清空。此前保存的问答仍保留。";
    }
    if (code === "CANCELLED") {
      return "已取消清空对话；此前保存的问答仍保留。";
    }
    if (code === "ATTACHMENT_NOT_FOUND" || code === "INVALID_ITEM"
        || code === "PDF_MISSING") {
      return "清空对话失败：当前 PDF 或文献标识已改变；"
        + "请重新打开这篇论文的当前 PDF 后重试。此前保存的问答仍保留。";
    }
    return "清空对话失败；此前保存的问答仍保留。请稍后重试。";
  }
  function visibleAnalysisError(job) {
    const code = String(job && job.code || "ANALYSIS_FAILED");
    const message = code === "AI_CONFIG_REQUIRED" || code === "AI_NOT_CONFIGURED"
      ? "尚未配置 AI 模型。请点击“模型设置”，保存后可在这里直接分析。"
      : Object.hasOwn(fixedTaskErrorMessages, code)
        ? fixedTaskErrorMessages[code]
        : "分析未完成；此前的阅读状态与分析仍保留。";
    return { code, message };
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
  function nonnegativeCount(value, cap = Number.MAX_SAFE_INTEGER) {
    const number = Number(value);
    return Number.isFinite(number)
      ? Math.max(0, Math.min(cap, Math.floor(number))) : 0;
  }
  function formatCount(value) {
    return nonnegativeCount(value).toLocaleString("zh-CN");
  }
  function submittedCharacters(coverage) {
    return Math.min(
      nonnegativeCount(coverage.extractedCharacters),
      nonnegativeCount(coverage.analyzedCharacters),
    );
  }
  function submittedPercent(coverage) {
    const extracted = nonnegativeCount(coverage.extractedCharacters);
    if (extracted > 0) return Math.round(submittedCharacters(coverage) / extracted * 100);
    const ratio = coverage.ratio == null ? NaN : Number(coverage.ratio);
    return Number.isFinite(ratio) && ratio >= 0 ? percent(ratio) : null;
  }
  function extractionPagesText(coverage) {
    if (coverage.extractedPages == null && coverage.totalPages == null) return "";
    return `可提取 PDF 文本：${formatCount(coverage.extractedPages)}`
      + (coverage.totalPages == null ? " 页"
        : ` / ${formatCount(coverage.totalPages)} 页`);
  }
  function syncActionLocks() {
    if (!state) return;
    const locked = !!state.analyzing || !!state.contextSwitching;
    const bound = !!currentNativeBinding();
    const chatLocked = locked || !!state.chatLoading || !!state.chatClearing;
    const chatBound = !!state.currentItem && !!state.currentAttachmentID && bound;
    setBooleanAttribute(state.modelButton, "disabled", locked);
    setBooleanAttribute(state.promptButton, "disabled", locked);
    setBooleanAttribute(state.chatSendButton, "disabled",
      chatLocked || !chatBound);
    if (state.chatClearButton) {
      setBooleanAttribute(state.chatClearButton, "disabled",
        chatLocked || !chatBound);
    }
    setBooleanAttribute(state.aiButton, "disabled",
      locked || !state.currentItem || !state.currentAttachmentID || !bound);
    setBooleanAttribute(state.reanalyzeButton, "disabled",
      locked || !state.currentItem || !state.currentAttachmentID || !bound);
    setBooleanAttribute(state.chatCancelButton, "disabled",
      !state.chatLoading);
    setBooleanAttribute(state.chatInput, "disabled",
      chatLocked || !state.currentAttachmentID || !bound);
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
  async function loadConversation(generation = loadGeneration,
    chatSnapshot = chatGeneration) {
    if (!state || !state.currentItem) {
      renderChat(null);
      return;
    }
    const item = state.currentItem;
    const attachmentID = state.currentAttachmentID;
    if (!attachmentID || !currentNativeBinding()) {
      renderChat(null);
      setStatus(state.chatStatus,
        "当前原生标签页的 PDF 与这篇论文未匹配；对话已停用。",
        "warning");
      return;
    }
    try {
      const conversation = typeof state.service.getConversation === "function"
        ? await state.service.getConversation(item, { attachmentID })
        : null;
      if (!state || generation !== loadGeneration
          || chatSnapshot !== chatGeneration || state.currentItem !== item
          || state.currentAttachmentID !== attachmentID) return;
      renderChat(conversation);
    }
    catch (error) {
      if (!state || generation !== loadGeneration
          || chatSnapshot !== chatGeneration
          || state.currentItem !== item) return;
      renderChat(null);
      setStatus(state.chatStatus,
        taskErrorText("对话", error), "error");
    }
  }
  function cancelOwnedChat() {
    if (!state || !state.chatLoading || !chatController) return false;
    try {
      chatController.abort();
      setStatus(state.chatStatus, "正在取消此篇论文的对话…", "pending");
      return true;
    }
    catch (error) {
      setStatus(state.chatStatus, taskErrorText("对话", error), "error");
      return false;
    }
  }
  function cancelOwnedRequests() {
    try { chatController?.abort(); } catch (_) {}
    // A queued clear is owned by this view too: the backend checks the signal
    // before committing, so aborting it leaves the saved history untouched.
    try { chatClearController?.abort(); } catch (_) {}
    try { analysisController?.abort(); } catch (_) {}
    chatController = chatClearController = analysisController = null;
    // The aborted session can no longer own the chat locks.
    chatClearSession = null;
    activeJob = null;
    if (state) state.chatLoading = state.chatClearing = state.analyzing = false;
  }
  async function sendChat() {
    if (!state || !state.currentItem || state.chatLoading
        || state.chatClearing || !isEmbedded()) return;
    if (state.contextSwitching || !state.currentAttachmentID || !currentNativeBinding()) {
      setStatus(state.chatStatus,
        "当前原生标签页没有匹配这篇论文的本地 PDF；不能向模型提交原文。",
        "warning");
      return;
    }
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
    const documentGeneration = loadGeneration;
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
          if (!state || generation !== chatGeneration || documentGeneration !== loadGeneration || state.currentItem !== item) return;
          setStatus(state.chatStatus,
            String(progress && progress.detail || "正在生成回答…"),
            "pending");
        },
      });
      if (!state || generation !== chatGeneration || documentGeneration !== loadGeneration || state.currentItem !== item) return;
      renderChat(result);
      setStatus(state.chatStatus,
        result && result.reply && result.reply.grounded
          ? "回答已保存；来源已与本次提交原文逐字匹配。"
          : "回答已保存；未找到可核验来源，请谨慎判断。",
        result && result.reply && result.reply.grounded ? "success" : "warning");
    }
    catch (error) {
      if (!state || generation !== chatGeneration || documentGeneration !== loadGeneration || state.currentItem !== item) return;
      const safe = safeError(error);
      setStatus(state.chatStatus,
        safe.code === "CANCELLED"
          ? "对话已取消；此前保存的问答仍保留。"
          : taskErrorText("对话", error),
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
  function clearChatUnavailable(message, kind) {
    if (state) setStatus(state.chatStatus, message, kind || "warning");
    return null;
  }
  function requestClearChat() {
    if (!state || !state.currentItem) return null;
    const view = state;
    if (chatClearDialog) return chatClearDialog;
    if (view.chatLoading || view.chatClearing || view.analyzing
        || view.contextSwitching) {
      return null;
    }
    if (!isEmbedded() || !view.currentAttachmentID || !currentNativeBinding()) {
      return clearChatUnavailable(
        "当前原生标签页没有匹配这篇论文的本地 PDF；无法清空对话。");
    }
    if (typeof view.service.clearConversation !== "function") {
      return clearChatUnavailable("当前服务版本不提供清空对话。", "error");
    }
    // Freeze the exact paper, PDF and generations the user is confirming.
    const item = view.currentItem;
    const attachmentID = view.currentAttachmentID;
    const documentGeneration = loadGeneration;
    const chatSnapshot = chatGeneration;
    const shell = dialogShell("清空当前 PDF 对话", () => {
      if (chatClearDialog === shell) chatClearDialog = null;
    });
    chatClearDialog = shell;
    const { modal } = shell;
    const intro = make("div", "rr-callout rr-warning");
    intro.textContent =
      "清空这篇论文当前 PDF 已保存的问题与回答；插件内无法撤销。原有备份、导出文件和 Zotero 笔记不会被清理。";
    const scope = currentDocument().createElementNS(XHTML_NS, "ul");
    setClass(scope, "rr-clear-chat-list");
    for (const text of [
      "删除范围：仅这篇论文当前 PDF 的对话；同一论文的其他 PDF 与其他论文的对话不受影响。",
      "之后向模型发送新问题时，不再包含已清空的问答；此前记录不会作为模型历史继续发送。",
      "保持不变：AI 解读、阅读笔记与阅读状态都不会被修改。",
      "其他标签页正在进行的对话不会被取消；此时需要等待其结束或先取消。",
    ]) {
      const entry = currentDocument().createElementNS(XHTML_NS, "li");
      entry.textContent = text;
      scope.append(entry);
    }
    const actions = make("div", "rr-modal-actions");
    const cancel = makeApiButton("取消", "rr-secondary", () => shell.close(),
      "关闭对话框，不删除任何已保存的问答");
    const confirm = makeApiButton("确认清空", "rr-danger",
      () => submitClearChat());
    actions.append(cancel, confirm);
    modal.append(intro, scope, actions);
    const submitClearChat = () => {
      // The dialog can outlive its binding: only an unchanged paper, PDF,
      // document generation and chat generation may still clear.
      const stale = !state || state !== view
        || loadGeneration !== documentGeneration
        || chatGeneration !== chatSnapshot
        || state.currentItem !== item
        || state.currentAttachmentID !== attachmentID
        || state.chatLoading || state.chatClearing;
      shell.close();
      if (stale) {
        if (state === view) {
          setStatus(view.chatStatus,
            "当前论文或 PDF 已改变；未清空对话。", "warning");
        }
        return;
      }
      void clearChat(view, { item, attachmentID });
    };
    cancel.focus?.();
    return shell;
  }
  async function clearChat(view, binding) {
    if (!state || state !== view) return;
    const { item, attachmentID } = binding;
    const documentGeneration = loadGeneration;
    // Invalidate pending history loads and progress for this PDF so a stale
    // response cannot restore the history this clear removes.
    const clearGeneration = ++chatGeneration;
    const Controller = view.window.AbortController || scope.AbortController;
    const controller = Controller ? new Controller() : null;
    const session = { controller, generation: clearGeneration };
    chatClearSession = session;
    chatClearController = controller;
    view.chatClearing = true;
    syncActionLocks();
    setStatus(view.chatStatus, "正在清空当前 PDF 的对话…", "pending");
    try {
      const result = await view.service.clearConversation(item, {
        attachmentID,
        signal: controller && controller.signal,
      });
      if (!state || state !== view
          || chatGeneration !== session.generation
          || loadGeneration !== documentGeneration
          || state.currentItem !== item
          || state.currentAttachmentID !== attachmentID) return;
      renderChat(result);
      setValue(state.chatInput, "");
      setStatus(state.chatStatus,
        "已清空当前 PDF 的对话；AI 解读、笔记与阅读状态保持不变。",
        "success");
    }
    catch (error) {
      if (!state || state !== view
          || chatGeneration !== session.generation
          || loadGeneration !== documentGeneration
          || state.currentItem !== item) return;
      // Keep whatever is on screen and re-read the authoritative history so a
      // failed or refused clear never looks like a successful one.
      setStatus(state.chatStatus, clearChatErrorText(error), "error");
      await loadConversation(loadGeneration, chatGeneration);
    }
    finally {
      // A newer clear (or context change) owns the locks now; only the session
      // that still holds them may release them.
      if (chatClearSession !== session) return;
      chatClearSession = null;
      chatClearController = null;
      if (state === view) {
        view.chatClearing = false;
        syncActionLocks();
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
    const view = state;
    const generation = loadGeneration;
    try {
      const adapter = state.nativePDFAdapter;
      if (!adapter) throw new Error("当前原生 PDF 阅读标签页尚未就绪。");
      await adapter.navigate(entry.pageIndex);
      if (state !== view || generation !== loadGeneration) return;
      setStatus(state.aiStatus,
        entry.pageIndex == null
          ? "页码未确认；未执行跳转。"
          : `已跳到 Zotero 原生 PDF 第 ${entry.pageIndex + 1} 页。`,
        "success");
    }
    catch (error) {
      if (state !== view || generation !== loadGeneration) return;
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
  function narrativeSection(title, text, evidence, hint) {
    const section = make("section", "rr-narrative");
    section.append(make("h3", null, title));
    if (hint) section.append(make("p", "rr-muted", hint));
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
  function openImageZoom(dataURL, reference) {
    const shell = dialogShell("原文页预览", () => {});
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
    const share = submittedPercent(coverage);
    source.append(make("span", null,
      `已提交提取文字 ${share == null ? "比例未记录" : share + "%"}`
      + ` · ${formatCount(submittedCharacters(coverage))} / ${formatCount(coverage.extractedCharacters)} 字符`));
    const pages = extractionPagesText(coverage);
    if (pages) source.append(make("span", null, pages));
    target.append(source);
    const omitted = Math.max(nonnegativeCount(coverage.omittedCharacters),
      nonnegativeCount(coverage.extractedCharacters) - submittedCharacters(coverage));
    if (omitted > 0) target.append(make("p", "rr-coverage-warning",
      `有 ${formatCount(omitted)} 字符未提交；相关部分可能未被涵盖。`));
    if (analysis.overview || analysis.readingGuide) {
      const narrative = make("div", "rr-narrative-grid");
      if (analysis.overview) narrative.append(narrativeSection(
        "论文概览", analysis.overview, analysis.overviewEvidence,
      ));
      if (analysis.readingGuide) narrative.append(narrativeSection(
        "精读重点", analysis.readingGuide, analysis.readingGuideEvidence,
        "帮助你定位值得核查的问题及其原文依据。",
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
    const view = state;
    const item = view.currentItem;
    const generation = loadGeneration;
    try {
      const reading = await view.service.setState(
        item, { status },
      );
      if (state !== view || generation !== loadGeneration || state.currentItem !== item) return;
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
    }
    catch (error) {
      if (state !== view || generation !== loadGeneration) return;
      setStatus(state.globalStatus, safeError(error).message, "error");
    }
    finally {
      if (state === view && generation === loadGeneration) state.saving = false;
    }
  }
  function scheduleNotesSave() {
    if (!state || !state.currentItem) return;
    notesDirty = true;
    setStatus(state.notesStatus, "正在等待自动保存…", "pending");
    if (noteTimer) clearTimeout(noteTimer);
    const item = state.currentItem;
    const generation = loadGeneration;
    const text = getValue(state.notesInput);
    noteTimer = setTimeout(async () => {
      noteTimer = null;
      if (!state || generation !== loadGeneration || state.currentItem !== item) return;
      try {
        const reading = await state.service.setState(item, { notes: text });
        if (!state || generation !== loadGeneration || state.currentItem !== item) return;
        if (getValue(state.notesInput) === text) notesDirty = false;
        state.description.state = reading;
        state.updated.textContent =
          `本地保存于 ${formatDate(reading.updatedAt)}`;
        setStatus(state.notesStatus,
          "笔记已保存到本地插件存储。", "success");
      }
      catch (error) {
        if (!state || generation !== loadGeneration || state.currentItem !== item) return;
        setStatus(state.notesStatus, safeError(error).message, "error");
      }
    }, 700);
  }
  async function flushPendingEdits() {
    if (!state) return;
    const view = state;
    const item = view.currentItem;
    const patch = {};
    if (item && view.description) {
      if (notesDirty || noteTimer) patch.notes = getValue(view.notesInput);
    }
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = null;
    // Capture edits before the first await, including during the unload event.
    // The dirty flag survives a failed write so a second switch retries the save.
    if (item && Object.keys(patch).length) {
      const reading = await view.service.setState(item, patch);
      if (state === view && view.currentItem === item) {
        if (Object.hasOwn(patch, "notes") && getValue(view.notesInput) === patch.notes) notesDirty = false;
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
      const { code, message } = visibleAnalysisError(current);
      setStatus(state.aiStatus,
        `分析失败 [${code}]：${message}`, "error");
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
    return openAIConfig(state && state.currentItem);
  }
  async function runAnalysis({ force = false } = {}) {
    if (!state || !state.currentItem || state.analyzing) return;
    if (state.contextSwitching || !state.currentAttachmentID || !currentNativeBinding()) {
      showJob({
        status: "error",
        detail: "当前原生标签页没有匹配这篇论文的本地 PDF；不能启动分析。",
      });
      return;
    }
    const targetItem = state.currentItem;
    const attachmentID = state.currentAttachmentID;
    const generation = loadGeneration;
    const Controller = state.window.AbortController || scope.AbortController;
    const controller = Controller ? new Controller() : null;
    analysisController = controller;
    activeJob = {
      status: "preparing",
      detail: force
        ? "正在准备重新分析…" : "正在检查已保存的 AI 解读…",
    };
    showJob(activeJob);
    try {
      const result = await state.service.analyze(targetItem, {
        attachmentID,
        signal: controller && controller.signal,
        force: force === true,
        onProgress(job) {
          if (!state || generation !== loadGeneration
              || state.currentItem !== targetItem
              || state.currentAttachmentID !== attachmentID) return;
          activeJob = job;
          showJob(job);
        },
      });
      if (!state || generation !== loadGeneration
          || state.currentItem !== targetItem
          || state.currentAttachmentID !== attachmentID) return;
      state.description.state.analysis = result;
      renderAnalysis(result);
      setBusy(false);
      showJob({
        status: "complete",
        detail: force
          ? "新的 AI 解读已保存到本地。"
          : "已载入此论文保存的 AI 解读。",
      });
    }
    catch (error) {
      if (!state || generation !== loadGeneration
          || state.currentItem !== targetItem
          || state.currentAttachmentID !== attachmentID) return;
      const safe = safeError(error);
      if (safe.code === "AI_CONFIG_REQUIRED"
          || safe.code === "AI_NOT_CONFIGURED") {
        showJob({
          status: "error",
          code: safe.code,
          detail: "尚未配置 AI 模型。请点击“模型设置”，保存后可在这里直接分析。",
        });
      }
      else {
        showJob({
          status: safe.code === "CANCELLED" ? "cancelled" : "error",
          code: safe.code,
          detail: fixedTaskErrorMessage("分析", safe),
        });
      }
    }
    finally {
      if (analysisController === controller) {
        analysisController = null;
        activeJob = null;
      }
    }
  }
  function cancelAnalysis() {
    if (!state) return;
    try {
      const cancelled = !!analysisController;
      analysisController?.abort();
      setStatus(state.aiStatus,
        cancelled ? "正在取消…" : "当前没有可取消的分析任务。",
        cancelled ? "pending" : "warning");
    }
    catch (error) {
      setStatus(state.aiStatus, taskErrorText("分析", error), "error");
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
    // The native item pane can clip a tall iframe. Use its visible intersection
    // for dialogs rather than centering them in the iframe's full viewport.
    const frame = doc.defaultView?.frameElement;
    const host = frame?.ownerDocument?.defaultView;
    const positionDialog = () => {
      if (closed || !frame?.getBoundingClientRect || !host?.getComputedStyle) return;
      const rect = frame.getBoundingClientRect();
      let top = Math.max(0, rect.top);
      let bottom = Math.min(host.innerHeight, rect.bottom);
      for (let node = frame.parentElement; node; node = node.parentElement) {
        const style = host.getComputedStyle(node);
        if (!/(auto|scroll|hidden|clip)/.test(style.overflowY || style.overflow || "")) continue;
        const clip = node.getBoundingClientRect();
        top = Math.max(top, clip.top);
        bottom = Math.min(bottom, clip.bottom);
      }
      if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom <= top) return;
      const height = bottom - top;
      overlay.style.top = `${top - rect.top}px`;
      overlay.style.bottom = "auto";
      overlay.style.height = `${height}px`;
      overlay.style.padding = "8px";
      modal.style.maxHeight = `${Math.max(0, height - 16)}px`;
    };
    if (host) {
      host.addEventListener("scroll", positionDialog, true);
      host.addEventListener("resize", positionDialog);
    }
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
      dialogClosers.delete(closeDialog);
      host?.removeEventListener("scroll", positionDialog, true);
      host?.removeEventListener("resize", positionDialog);
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
    dialogClosers.add(closeDialog);
    positionDialog();
    doc.defaultView?.requestAnimationFrame?.(positionDialog);
    return { overlay, modal, close: closeDialog };
  }
  function promptLengthLabel(textarea, limit) {
    return `${String(getValue(textarea) || "").length.toLocaleString()} / ${limit.toLocaleString()} 字符`;
  }
  function appendReadOnlyPromptPreview(container, title, text) {
    const details = make("details", "rr-prompt-protocol");
    const summary = make("summary", null, title);
    const preview = make("pre", "rr-prompt-default", text);
    preview.setAttribute("aria-label", title);
    details.append(summary, preview);
    container.append(details);
    return { details, summary, preview };
  }
  async function openPromptSettings() {
    if (!state) return null;
    const shell = dialogShell("分析与对话提示词", () => {});
    const { modal } = shell;
    const status = make("div", "rr-message");
    setHidden(status, true);
    const intro = make("div", "rr-callout");
    intro.textContent = "可编辑的学术指令 + 固定应用输出协议 = 实际发送内容。下面三项学术指令可保存或恢复；固定协议和实际完整系统提示词只读，可展开核对。保存或恢复不会调用模型；旧结果保持原样，新分析或新对话才使用当前设置。";
    const system = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    system.setAttribute("rows", "15");
    system.setAttribute("spellcheck", "false");
    system.setAttribute("aria-label", "分析学术指令（可编辑）");
    const synthesis = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    synthesis.setAttribute("rows", "5");
    synthesis.setAttribute("spellcheck", "false");
    synthesis.setAttribute("aria-label", "综合阶段指令（可编辑）");
    const chat = currentDocument().createElementNS(
      XHTML_NS, "textarea",
    );
    chat.setAttribute("rows", "8");
    chat.setAttribute("spellcheck", "false");
    chat.setAttribute("aria-label", "论文对话学术指令（可编辑）");
    const systemCounter = make("span", "rr-field-help");
    const synthesisCounter = make("span", "rr-field-help");
    const chatCounter = make("span", "rr-field-help");
    const current = make("div", "rr-prompt-state");
    current.append(make("span", null, "正在读取当前提示词…"));
    const actual = make("div", "rr-prompt-defaults");
    actual.append(
      make("h3", null, "实际发送内容（只读）"),
      make("p", "rr-field-help",
        "以下协议由应用固定追加，不能在这里编辑。有效完整提示词展示协议追加后的最终内容。"),
    );
    const analysisProtocol = appendReadOnlyPromptPreview(
      actual, "固定分析应用输出协议", "");
    const analysisEffective = appendReadOnlyPromptPreview(
      actual, "有效完整分析系统提示词", "");
    const chatProtocol = appendReadOnlyPromptPreview(
      actual, "固定对话应用输出协议", "");
    const chatEffective = appendReadOnlyPromptPreview(
      actual, "有效完整对话系统提示词", "");
    const defaults = make("div", "rr-prompt-defaults");
    defaults.append(make("h3", null, "当前版本默认学术指令（只读）"));
    const defaultSystem = make("pre", "rr-prompt-default");
    const defaultSynthesis = make("pre", "rr-prompt-default");
    const defaultChat = make("pre", "rr-prompt-default");
    defaults.append(
      make("span", "rr-field-label", "默认分析学术指令"),
      defaultSystem,
      make("span", "rr-field-label", "默认综合阶段指令"),
      defaultSynthesis,
      make("span", "rr-field-label", "默认论文对话学术指令"),
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
    const systemField = makeField("分析学术指令（可编辑）", system);
    systemField.append(systemCounter);
    const synthesisField = makeField("综合阶段指令（可编辑）", synthesis);
    synthesisField.append(synthesisCounter);
    const chatField = makeField("论文对话学术指令（可编辑）", chat);
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
      actual, defaults, status, actions,
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
      config = next || {};
      const value = name => typeof config[name] === "string" ? config[name] : "";
      const missing = "当前服务未提供此只读内容。";
      const version = config.outputContractVersion == null
        || String(config.outputContractVersion).trim() === ""
        ? "未提供" : String(config.outputContractVersion).trim();
      setValue(system, value("systemPrompt"));
      setValue(synthesis, value("synthesisInstruction"));
      setValue(chat, value("chatSystemPrompt"));
      defaultSystem.textContent = value("defaultSystemPrompt");
      defaultSynthesis.textContent = value("defaultSynthesisInstruction");
      defaultChat.textContent = value("defaultChatSystemPrompt");
      analysisProtocol.summary.textContent =
        `固定分析应用输出协议（只读 · 版本 ${version}）`;
      chatProtocol.summary.textContent =
        `固定对话应用输出协议（只读 · 版本 ${version}）`;
      analysisProtocol.preview.textContent =
        value("analysisOutputContract") || missing;
      analysisEffective.preview.textContent =
        value("effectiveAnalysisSystemPrompt") || missing;
      chatProtocol.preview.textContent =
        value("chatOutputContract") || missing;
      chatEffective.preview.textContent =
        value("effectiveChatSystemPrompt") || missing;
      const analysisCustom = config.isCustom === true;
      const chatCustom = config.isChatCustom === true;
      const customLabel = analysisCustom && chatCustom
        ? "当前使用自定义分析与对话提示词"
        : analysisCustom
          ? "当前使用自定义分析提示词"
          : chatCustom
            ? "当前使用自定义对话提示词"
            : "当前使用默认提示词";
      current.replaceChildren(
        make("strong", null, customLabel),
        make("span", null,
          `应用输出协议版本 ${version} · 保存于 ${formatDate(config.updatedAt)}`),
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
          "分析、综合与对话三项提示词已保存；新分析或新对话将使用此版本。",
          "success");
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
          "分析、综合与对话三项提示词已恢复为当前版本默认值。",
          "success");
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
    const view = state;
    const generation = loadGeneration;
    setBooleanAttribute(state.noteButton, "disabled", true);
    setStatus(state.noteStatus,
      "正在创建插件分析笔记…", "pending");
    try {
      const result = await state.service.saveAnalysisNote(
        state.currentItem,
      );
      if (state !== view || generation !== loadGeneration) return;
      setStatus(state.noteStatus,
        result.created
          ? "已显式创建新的 Zotero 分析笔记。"
          : "同一分析已有插件笔记，未重复创建。",
        "success");
    }
    catch (error) {
      if (state !== view || generation !== loadGeneration) return;
      setStatus(state.noteStatus, safeError(error).message, "error");
    }
    finally {
      if (state === view && generation === loadGeneration) {
        setBooleanAttribute(view.noteButton, "disabled",
          view.description?.state.analysis?.mode !== "model");
      }
    }
  }
  async function syncStateNote() {
    if (!state || !state.currentItem) return;
    const view = state;
    const generation = loadGeneration;
    setBooleanAttribute(state.syncButton, "disabled", true);
    setStatus(state.noteStatus,
      "正在同步阅读记录到个人库笔记…", "pending");
    try {
      const result = await state.service.syncStateNote(
        state.currentItem,
      );
      if (state !== view || generation !== loadGeneration) return;
      const text = result.changed
        ? (result.created
          ? "已显式创建阅读记录笔记。"
          : "已更新本插件创建的阅读记录笔记。")
        : "阅读记录笔记已是最新，没有重复写入。";
      setStatus(state.noteStatus, text, "success");
    }
    catch (error) {
      if (state !== view || generation !== loadGeneration) return;
      setStatus(state.noteStatus, safeError(error).message, "error");
    }
    finally {
      if (state === view && generation === loadGeneration) {
        setBooleanAttribute(view.syncButton, "disabled", !!view.analyzing);
      }
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
    ];
    if (analysis && analysis.mode === "model") {
      lines.push("", "## AI 解读（待核对）", "");
      if (analysis.overview) {
        lines.push("### 概览", "", analysis.overview, "");
      }
      if (analysis.readingGuide) {
        lines.push("### 精读重点", "", analysis.readingGuide, "");
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
      const share = submittedPercent(coverage);
      lines.push(
        "## 覆盖范围与限制", "",
        `- 已提交提取文字：${formatCount(submittedCharacters(coverage))} / ${formatCount(coverage.extractedCharacters)} 字符`
          + (share == null ? "（比例未记录）" : `（${share}%）`),
        `- 页码边界：${coverage.pageAware ? "可用" : "未确认"}`,
        "- 提交比例只说明送去多少可提取文字，不代表模型已理解全文。",
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
  function contextIdentity(context) {
    return JSON.stringify([context?.embedded === true, context?.itemID,
      context?.parentItemID, context?.attachmentID,
      context?.attachmentKey, context?.tabID]);
  }
  function currentNativeBinding(parent = state && state.currentItem, description = state && state.description) {
    const context = state && state.nativeContext;
    if (!context || context.embedded !== true || !parent
        || !Number.isSafeInteger(context.itemID) || context.itemID <= 0
        || !Number.isSafeInteger(context.parentItemID)
        || context.parentItemID !== context.itemID
        || !Number.isSafeInteger(context.attachmentID) || context.attachmentID <= 0
        || typeof context.attachmentKey !== "string" || !context.attachmentKey.trim()
        || typeof context.tabID !== "string" || !context.tabID.trim()
        || Number(parent.id) !== context.parentItemID) return null;
    try {
      const reader = Zotero.Reader?.getByTabID?.(context.tabID);
      const attachment = Zotero.Items.get(context.attachmentID);
      if (!reader || Number(reader.itemID) !== context.attachmentID
          || !attachment || Number(attachment.id) !== context.attachmentID
          || attachment.key !== context.attachmentKey || attachment.deleted
          || attachment.isAttachment?.() !== true
          || attachment.attachmentContentType !== "application/pdf"
          || Number(attachment.parentID) !== context.parentItemID
          || Number(attachment.libraryID) !== Number(parent.libraryID)) return null;
      if (description && (Number(description.item.id) !== context.parentItemID
          || Number(description.item.libraryID) !== Number(parent.libraryID)
          || description.item.key !== parent.key
          || !description.attachments.some(value => Number(value.id) === context.attachmentID
            && value.key === context.attachmentKey
            && value.contentType === "application/pdf"))) return null;
      return { reader, attachment };
    }
    catch (_) { return null; }
  }
  function nativeReaderForContext() {
    return currentNativeBinding()?.reader || null;
  }
  function updateContext(next, force = false) {
    if (!state || !next) return Promise.resolve();
    const view = state;
    const requested = { ...next };
    if (!force && !view.contextRefreshFailed && contextIdentity(requested)
        === contextIdentity(view.pendingNativeContext || view.nativeContext)) return contextUpdate;
    const revision = ++contextGeneration;
    loadGeneration++;
    chatGeneration++;
    cancelOwnedRequests();
    view.pendingNativeContext = requested;
    view.contextSwitching = true;
    syncActionLocks();
    contextUpdate = contextUpdate.catch(() => {}).then(async () => {
      if (state !== view || revision !== contextGeneration) return;
      await flushPendingEdits();
      if (state !== view || revision !== contextGeneration) return;
      view.nativeContext = requested;
      view.pendingNativeContext = null;
      view.contextRefreshFailed = false;
      const item = Number.isSafeInteger(requested.itemID)
        ? Zotero.Items.get(requested.itemID) : null;
      await selectItem(item);
    }).catch(error => {
      if (state !== view || revision !== contextGeneration) return;
      view.pendingNativeContext = null;
      view.contextRefreshFailed = true;
      setStatus(view.globalStatus, safeError(error).message, "error");
    }).finally(() => {
      if (state !== view || revision !== contextGeneration) return;
      view.contextSwitching = false;
      syncActionLocks();
    });
    return contextUpdate;
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
    if (!attachment) {
      state.nativePDFAdapter = null;
      return null;
    }
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
        if (!currentNativeBinding()
            || Number(state.currentAttachmentID) !== Number(attachment.id)) {
          throw new Error("当前原生 PDF 阅读上下文未匹配。");
        }
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
  async function selectHostItem(item) {
    if (!state || !item) return;
    const parent = state.service.normalizeItem(item);
    if (isEmbedded()) {
      // Host selection is a refresh signal; only its complete Reader context owns identity.
      if (!parent || Number(parent.id) !== state.nativeContext.parentItemID) return;
      return contextUpdate;
    }
    if (state.currentItem && parent && Number(state.currentItem.id) === Number(parent.id)) return;
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
    if (!state) return;
    const generation = ++loadGeneration;
    const nextParent = item && state.service.normalizeItem(item);
    // A clear bound to the previous paper must not commit after this switch.
    try { chatClearController?.abort(); } catch (_) {}
    chatClearController = null;
    chatClearSession = null;
    state.chatLoading = state.chatClearing = false;
    renderChat(null);
    await destroyPdf();
    if (!state || generation !== loadGeneration) return;
    state.nativePDFAdapter = null;
    state.currentItem = null;
    state.currentPaper = null;
    state.currentAttachmentID = null;
    state.description = null;
    state.saving = false;
    state.attachmentName.textContent = "当前 PDF 不可用：原生阅读上下文未匹配。";
    syncActionLocks();
    setStatus(state.globalStatus, "正在读取文献…", "pending");
    state.title.textContent = "正在加载…";
    state.subtitle.textContent = "";
    state.aiResults.replaceChildren(make(
      "div", "rr-empty", "正在读取当前文献…",
    ));
    try {
      const parent = nextParent;
      if (!parent) throw new Error("当前 Zotero PDF 的父论文上下文不可用。");
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
      notesDirty = false;
      const pdfs = description.attachments.filter(
        attachment => attachment.contentType === "application/pdf",
      );
      const binding = currentNativeBinding(parent, description);
      const available = binding && pdfs.find(attachment => attachment.available
        && Number(attachment.id) === state.nativeContext.attachmentID
        && attachment.key === state.nativeContext.attachmentKey);
      state.currentAttachmentID = available ? available.id : null;
      description.state.analysis = analysisForAttachment(description, state.currentAttachmentID);
      state.title.textContent =
        description.item.title || "未命名文献";
      state.subtitle.textContent = [
        description.item.year,
        description.item.venue,
        (description.item.creators || []).join("；"),
      ].filter(Boolean).join(" · ") || "元数据尚未完整";
      state.metadata.replaceChildren(metadataRows(description));
      state.attachmentName.textContent = available
        ? available.title || "当前 PDF"
        : "当前 PDF 不可用：原生阅读上下文或本地附件未匹配。";
      updateStatusPills(
        state.statusChoices, description.state.status,
      );
      setValue(state.notesInput, description.state.notes || "");
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
      let attachment = null;
      if (state.currentAttachmentID) {
        try {
          attachment = await state.service.getReaderAttachment(
            parent, { attachmentID: state.currentAttachmentID,
              attachmentKey: state.nativeContext.attachmentKey },
          );
        }
        catch (error) {
          logError("reader attachment", error);
        }
      }
      if (generation !== loadGeneration || !state) return;
      if (!currentNativeBinding(parent, description)
          || !attachment || attachment.id !== state.currentAttachmentID
          || attachment.key !== state.nativeContext.attachmentKey
          || Number(attachment.libraryID) !== Number(parent.libraryID)
          || attachment.contentType !== "application/pdf" || !attachment.available) {
        attachment = null;
        state.currentAttachmentID = null;
        state.attachmentName.textContent = "当前 PDF 不可用：原生阅读上下文或本地附件未匹配。";
      }
      syncActionLocks();
      setNativePDFAdapter(attachment, generation);
      state.openZoteroButton.disabled = !attachment;
      if (generation !== loadGeneration || !state) return;
      setStatus(
        state.globalStatus,
        attachment && attachment.available
          ? "Zotero 原生阅读器显示当前 PDF；切换论文不会自动调用模型。"
          : "当前原生 PDF 不可用或身份未匹配；分析与对话已停用。",
        attachment && attachment.available ? "success" : "warning",
      );
      void loadConversation(generation);
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
        ? "论文阅读室 · 当前论文助手"
        : "论文阅读室 · 原文与 AI 对照"),
    );
    const headerActions = make("div", "rr-header-actions");
    const promptButton = makeApiButton("提示词设置", "rr-secondary",
      () => void openPromptSettings(),
      "查看、编辑或恢复分析与对话提示词");
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
    const reading = make("section", "rr-reading-workspace");
    const paperHead = make("header", "rr-paper-head");
    const titleBlock = make("div", "rr-title-block");
    const title = make("h1", null, "选择一篇论文");
    const subtitle = make("p", null,
      "正在绑定 Zotero 原生阅读标签页中的当前论文。");
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
      "当前论文由 Zotero 原生阅读标签页绑定。",
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
    const chatClearButton = makeApiButton(
      "清空对话", "rr-secondary", () => void requestClearChat(),
      "删除这篇论文当前 PDF 已保存的问题与回答；AI 解读、笔记与阅读状态不受影响");
    chatActions.append(chatClearButton, chatCancelButton, chatSendButton);
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
    const attachmentField = make("div", "rr-field rr-attachment-field");
    attachmentField.append(make("span", "rr-field-label", "当前 Zotero PDF"));
    const attachmentName = make("span", "rr-current-pdf", "等待当前 PDF…");
    attachmentField.append(attachmentName);
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
    notesSection.append(
      notesHead,
      statusChoices,
      attachmentField,
      notesLabel,
      notesStatus,
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
    app.append(reading);
    body.replaceChildren(app);

    state = Object.assign(state, {
      chatMessages,
      modelButton,
      promptButton,
      splitPercent: 52,
      title,
      subtitle,
      counts,
      metadata,
      statusChoices,
      attachmentName,
      notesInput,
      notesStatus,
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
      chatClearButton,
      chatStatus,
      chatLoading: false,
      chatClearing: false,
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
      window: targetWindow,
      document: targetDocument,
    });
    renderChat(null);
    notesInput.addEventListener("input", scheduleNotesSave);
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
    setBusy(false);
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
        parentItemID: Number(search.get("parentItemID")) || null,
        attachmentID: Number(search.get("attachmentID")) || null,
        attachmentKey: search.get("attachmentKey") || null,
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
    for (const close of [...dialogClosers]) close();
    loadGeneration++;
    chatGeneration++;
    contextGeneration++;
    closeOpenChoices();
    if (chatClearDialog) {
      const dialog = chatClearDialog;
      chatClearDialog = null;
      try { dialog.close(); } catch (_) {}
    }
    disposeChoices(view.document && view.document.documentElement);
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = null;
    cancelOwnedRequests();
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
      updateContext,
    };
    void updateContext(context, true);
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
