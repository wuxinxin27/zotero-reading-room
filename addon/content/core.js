/* Pure domain logic. Loaded as a privileged subscript, with no network or file access. */
(function (scope) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STATUSES = Object.freeze(["unread", "to_read", "reading", "read", "parked"]);
  const API_PROVIDERS = Object.freeze([
    { id: "openai", label: "OpenAI 兼容", defaultEndpoint: "http://127.0.0.1:11434/v1", endpointHint: "基础地址或完整 /v1/chat/completions 地址" },
    { id: "anthropic", label: "Anthropic Messages", defaultEndpoint: "https://api.anthropic.com/v1", endpointHint: "基础地址或完整 /v1/messages 地址" },
    { id: "gemini", label: "Google Gemini", defaultEndpoint: "https://generativelanguage.googleapis.com/v1beta", endpointHint: "基础地址或完整 /v1beta/models/模型:generateContent 地址" },
    { id: "ollama", label: "Ollama 原生", defaultEndpoint: "http://127.0.0.1:11434", endpointHint: "基础地址或完整 /api/chat 地址" }
  ].map(Object.freeze));
  const DIMENSIONS = Object.freeze([
    { id: "problem", label: "解决的问题" },
    { id: "novelty", label: "新颖性" },
    { id: "contributions", label: "贡献" },
    { id: "prior-work", label: "与前人工作的关系" },
    { id: "superiority", label: "优势与适用边界" },
    { id: "technical-uniqueness", label: "技术独特之处" }
  ]);
  const CONTRIBUTION_TYPES = Object.freeze([
    { id: "theory", label: "理论" },
    { id: "algorithm", label: "算法" },
    { id: "experiment", label: "实验" },
    { id: "engineering", label: "工程" }
  ]);

  function error(code, message) {
    const value = new Error(message);
    value.code = code;
    return value;
  }

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }

  function identity(item) {
    if (!item || !Number.isInteger(item.libraryID) || item.libraryID < 1
        || typeof item.key !== "string" || !/^[A-Z0-9]{8}$/.test(item.key)) {
      throw error("INVALID_ITEM", "需要有稳定标识的 Zotero 文献条目。");
    }
    return String(item.libraryID) + ":" + item.key;
  }

  function defaultState() {
    return { schemaVersion: SCHEMA_VERSION, status: "unread", focused: false, notes: "", checklist: {}, lastPage: null, updatedAt: null };
  }

  function patchState(previous, patch, timestamp) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw error("INVALID_STATE", "阅读状态更新必须是对象。");
    }
    const next = Object.assign(defaultState(), clone(previous || {}));
    if (Object.hasOwn(patch, "focused")) {
      if (typeof patch.focused !== "boolean") throw error("INVALID_FOCUS", "关注标记必须为布尔值。");
      next.focused = patch.focused;
    }
    if (Object.hasOwn(patch, "status")) {
      if (!STATUSES.includes(patch.status)) throw error("INVALID_STATUS", "未知阅读状态。");
      next.status = patch.status;
    }
    if (Object.hasOwn(patch, "notes")) {
      if (typeof patch.notes !== "string" || patch.notes.length > 2000000) throw error("INVALID_NOTES", "阅读笔记必须是文本，且不超过 200 万字符。");
      next.notes = patch.notes;
    }
    if (Object.hasOwn(patch, "checklist")) {
      if (!patch.checklist || typeof patch.checklist !== "object") throw error("INVALID_CHECKLIST", "核对清单必须是对象或数组。");
      const serialized = JSON.stringify(patch.checklist);
      if (serialized.length > 200000) throw error("INVALID_CHECKLIST", "核对清单过大。");
      next.checklist = JSON.parse(serialized);
    }
    if (Object.hasOwn(patch, "lastPage")) {
      if (patch.lastPage !== null && (!Number.isInteger(patch.lastPage) || patch.lastPage < 0)) {
        throw error("INVALID_PAGE", "阅读位置必须是非负整数或空值。");
      }
      next.lastPage = patch.lastPage;
    }
    next.schemaVersion = SCHEMA_VERSION;
    next.updatedAt = timestamp || new Date().toISOString();
    return next;
  }

  function escapeHTML(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
  }

  // A change detector for note conflicts and source fingerprints, not a security primitive.
  function hash(value) {
    const text = String(value);
    let a = 2166136261;
    let b = 2246822507;
    for (let i = 0; i < text.length; i++) {
      a = Math.imul(a ^ text.charCodeAt(i), 16777619);
      b = Math.imul(b ^ text.charCodeAt(i), 3266489909);
    }
    return (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }

  function normalizeText(text) {
    return String(text || "").normalize("NFC").replace(/\s+/g, " ").trim();
  }

  function documentFromFullText(data) {
    const text = typeof data === "string" ? data : String(data && data.text || "");
    const extractedPages = Number.isInteger(data && data.extractedPages) ? data.extractedPages : null;
    const totalPages = Number.isInteger(data && data.totalPages) ? data.totalPages : null;
    const parts = text.split("\f");
    // Verified against zotero/document-worker src/pdf/index.js getFulltext():
    // pages are separated by '\f'. A mismatching count must never become page evidence.
    const pageAware = extractedPages > 0 && parts.length === extractedPages;
    const segments = pageAware
      ? parts.map((part, pageIndex) => ({ pageIndex, text: part }))
      : [{ pageIndex: null, text }];
    return {
      text, segments, pageAware, extractedPages, totalPages,
      textHash: hash(text),
      limitations: pageAware ? [] : ["全文接口未提供可校验的逐页边界；引用不标页码，请打开附件核对。"]
    };
  }

  function validateEvidence(evidence, document, attachmentKey) {
    const originalQuote = evidence && typeof evidence.quote === "string" ? evidence.quote : "";
    const quote = originalQuote.slice(0, 4000);
    const pageIndex = Number.isInteger(evidence && evidence.pageIndex) && evidence.pageIndex >= 0 ? evidence.pageIndex : null;
    const requestedPage = evidence && evidence.pageIndex != null;
    const haystack = requestedPage
      ? document.segments.filter(segment => segment.pageIndex === pageIndex).map(segment => segment.text).join("\n")
      : document.text;
    const needle = normalizeText(quote);
    const verified = originalQuote.length <= 4000 && needle.length >= 8 && (!requestedPage || (document.pageAware && pageIndex !== null))
      && normalizeText(haystack).includes(needle);
    return {
      quote, pageIndex: requestedPage ? pageIndex : null, attachmentKey,
      verified, confidence: verified ? "literal-match" : "unverified",
      ...(verified ? {} : { reason: "引文未与本次提取文本及指定页逐字匹配；不能作为已验证证据。" })
    };
  }

  function validateEndpoint(input, allowRemote = false, provider = "openai") {
    const specification = API_PROVIDERS.find(entry => entry.id === provider);
    if (!specification) throw error("UNKNOWN_PROVIDER", "未知 API 协议；请明确选择受支持的协议。");
    let endpoint;
    try { endpoint = new URL(input || specification.defaultEndpoint); }
    catch (_) { throw error("UNSAFE_ENDPOINT", "模型端点必须是有效的 HTTP(S) 地址。"); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || /[?#]/.test(String(input || ""))) {
      throw error("UNSAFE_ENDPOINT", "模型端点仅允许无内嵌凭据、查询参数和片段的 HTTP(S) 地址。");
    }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname.toLowerCase());
    if (!local && (!allowRemote || endpoint.protocol !== "https:")) {
      throw error("REMOTE_CONSENT_REQUIRED", "远程 API 必须使用 HTTPS，并明确允许本次访问。");
    }
    let path = endpoint.pathname.replace(/\/+$/, "");
    const routes = { openai: /\/chat\/completions$/, anthropic: /\/messages$/, gemini: /\/models\/[^/]+:generateContent$/, ollama: /\/api\/(?:chat|tags)$/ };
    for (const [id, route] of Object.entries(routes)) {
      if (id !== provider && route.test(path)) throw error("ENDPOINT_PROTOCOL_MISMATCH", "端点路径与所选 API 协议不一致。");
    }
    const generationRoute = routes[provider].test(path);
    const complete = generationRoute || (provider !== "ollama" && /\/models$/.test(path));
    if (provider === "ollama") {
      if (generationRoute) path = path.replace(/\/(?:chat|tags)$/, "");
      if (!/\/api$/.test(path)) path += "/api";
    }
    else {
      path = generationRoute ? path.replace(routes[provider], "") : path.replace(/\/models$/, "");
      if (!complete && !/\/v\d+(?:beta\d*|alpha\d*)?$/.test(path)) path += provider === "gemini" ? "/v1beta" : "/v1";
    }
    endpoint.pathname = path;
    const baseURL = endpoint.href.replace(/\/$/, "");
    const modelsURL = baseURL + (provider === "ollama" ? "/tags" : "/models");
    const url = baseURL + ({ openai: "/chat/completions", anthropic: "/messages", gemini: "/models", ollama: "/chat" })[provider];
    return { provider, url, modelsURL, baseURL, local };
  }

  function chunkDocument(document, options = {}) {
    const chunkSize = options.chunkSize || 16000;
    const maxCharacters = options.maxCharacters || 120000;
    const chunks = [];
    let used = 0;
    for (const segment of document.segments) {
      for (let start = 0; start < segment.text.length && used < maxCharacters; start += chunkSize) {
        const text = segment.text.slice(start, Math.min(start + chunkSize, start + maxCharacters - used));
        if (text) chunks.push({ pageIndex: segment.pageIndex, text });
        used += text.length;
      }
      if (used >= maxCharacters) break;
    }
    return { chunks, analyzedCharacters: used, totalCharacters: document.segments.reduce((sum, segment) => sum + segment.text.length, 0) };
  }

  // Heading labels are local selection hints, never classifications of a paper's claims.
  function analysisSectionHint(line) {
    const heading = line.trim().replace(/^#{1,6}\s*/, "")
      .replace(/^(?:第[一二三四五六七八九十\d]+[章节]\s*|[一二三四五六七八九十百]+、\s*|(?:\d+(?:\.\d+)*[.)]?|[IVXLCDM]+[.)]?|[A-Z][.)])\s+)/, "");
    if (!heading || heading.length > 120) return null;
    const headings = [
      ["appendix", /^(?:appendi(?:x|ces)\b|supplement(?:ary)?(?:\s+(?:material|information))?\b|附录|补充材料)/i],
      ["references", /^(?:references?\b|bibliography\b|参考文献)/i],
      ["limitations", /^(?:limitations?\b|局限(?:性)?|研究局限)/i],
      ["conclusion", /^(?:conclusions?\b|concluding remarks\b|结论|总结与展望)/i],
      ["methods", /^(?:methods?\b|methodology\b|materials? and methods\b|(?:proposed )?(?:approach|algorithm|framework)\b|system (?:design|architecture)\b|implementation\b|方法|研究方法|算法|系统设计|实现)/i],
      ["experiments", /^(?:experiments?\b|experimental (?:setup|results|evaluation)\b|实验|试验)/i],
      ["evaluation", /^(?:evaluation\b|performance evaluation\b|评估|评价|性能评测)/i],
      ["results", /^(?:results?\b|结果|研究结果)/i],
      ["discussion", /^(?:discussion\b|讨论)/i],
      ["related-work", /^(?:related work\b|background\b|相关工作|背景)/i],
      ["introduction", /^(?:introduction\b|引言|绪论)/i],
      ["abstract", /^(?:abstract\b|摘要)/i]
    ];
    // Sentence-shaped lines remain unknown even when they start with a cue word.
    if (/[。！？!?;；]|\.(?:\s|$)/.test(heading)) return null;
    const match = headings.find(([, pattern]) => pattern.test(heading));
    return match ? match[0] : null;
  }

  function planAnalysis(document, options = {}) {
    options = options && typeof options === "object" ? options : {};
    const limit = (value, fallback) => typeof value === "number" && Number.isFinite(value)
      ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : fallback;
    const maxCharacters = limit(options.maxCharacters, 120000);
    const packetCharacters = limit(options.packetCharacters, 16000);
    const maxPackets = limit(options.maxPackets, 12);
    const segments = Array.isArray(document && document.segments) ? document.segments : [];
    const sections = new Map();
    const spans = [];
    let totalCharacters = 0;
    let currentHint = "unknown";
    const addSpan = (segment, segmentIndex, start, end, hint) => {
      if (end <= start) return;
      const pageIndex = Number.isInteger(segment.pageIndex) && segment.pageIndex >= 0 ? segment.pageIndex : null;
      spans.push({ segmentIndex, pageIndex, start, end, hint, text: segment.text });
      if (!sections.has(hint)) sections.set(hint, { hint, totalCharacters: 0, selectedCharacters: 0 });
      sections.get(hint).totalCharacters += end - start;
    };
    // Inspect every segment before applying a budget. In particular, references do
    // not terminate scanning: appendices and later experiments may follow them.
    segments.forEach((segment, segmentIndex) => {
      if (!segment || typeof segment.text !== "string") return;
      const text = segment.text;
      totalCharacters += text.length;
      let spanStart = 0;
      for (let start = 0; start < text.length;) {
        const newline = text.indexOf("\n", start);
        const end = newline < 0 ? text.length : newline + 1;
        const hint = analysisSectionHint(text.slice(start, end));
        if (hint && hint !== currentHint) {
          addSpan(segment, segmentIndex, spanStart, start, currentHint);
          spanStart = start;
          currentHint = hint;
        }
        start = end;
      }
      addSpan(segment, segmentIndex, spanStart, text.length, currentHint);
    });
    const capacity = Math.min(Number.MAX_SAFE_INTEGER, packetCharacters * maxPackets);
    const budget = Math.min(totalCharacters, maxCharacters, capacity);
    const windows = [];
    if (budget > 0) {
      const windowCharacters = 4000;
      for (const span of spans) {
        for (let start = span.start; start < span.end; start += windowCharacters) {
          windows.push({ ...span, start, end: Math.min(start + windowCharacters, span.end) });
        }
      }
    }
    let selected = windows;
    if (budget > 0 && budget < totalCharacters) {
      // Even a short, single-region document needs two anchors when sampled.
      if (windows.length === 1 && windows[0].end - windows[0].start > 1) {
        const window = windows[0];
        const middle = window.start + Math.ceil((window.end - window.start) / 2);
        windows.splice(0, 1, { ...window, end: middle }, { ...window, start: middle });
      }
      const groups = new Map();
      windows.forEach((window, index) => {
        if (!groups.has(window.hint)) groups.set(window.hint, []);
        groups.get(window.hint).push(index);
      });
      // First/last/midpoint breadth-first order spreads each hint over its full
      // source range. Round-robin across hints retains small, late sections.
      const queues = Array.from(groups.values(), indices => {
        const order = [indices[0]];
        if (indices.length > 1) order.push(indices[indices.length - 1]);
        const ranges = [[1, indices.length - 2]];
        for (let cursor = 0; cursor < ranges.length; cursor++) {
          const [left, right] = ranges[cursor];
          if (left > right) continue;
          const middle = Math.floor((left + right) / 2);
          order.push(indices[middle]);
          if (left < middle) ranges.push([left, middle - 1]);
          if (middle < right) ranges.push([middle + 1, right]);
        }
        return { order, cursor: 0 };
      });
      const chosen = new Set();
      let available = 0;
      const choose = index => {
        if (available >= budget || chosen.has(index)) return;
        chosen.add(index);
        available += windows[index].end - windows[index].start;
      };
      choose(0);
      // Reserve an end anchor before spending the rest of a small budget.
      if (budget > 1 && windows.length > 1) {
        const last = windows.length - 1;
        chosen.add(last);
        available += windows[last].end - windows[last].start;
      }
      while (available < budget) {
        for (const queue of queues) {
          while (queue.cursor < queue.order.length && chosen.has(queue.order[queue.cursor])) queue.cursor++;
          if (queue.cursor < queue.order.length) choose(queue.order[queue.cursor++]);
        }
      }
      selected = Array.from(chosen).sort((a, b) => a - b).map(index => ({ ...windows[index], selected: 0 }));
      // Water-fill selected windows so both anchors survive small budgets and
      // no duplicated or overlapping source interval is needed to use the budget.
      let remaining = budget;
      let active = selected.slice();
      while (remaining > 0) {
        const share = Math.max(1, Math.floor(remaining / active.length));
        const next = [];
        for (const window of active) {
          const take = Math.min(share, remaining, window.end - window.start - window.selected);
          window.selected += take;
          remaining -= take;
          if (window.selected < window.end - window.start) next.push(window);
        }
        active = next;
      }
      selected = selected.filter(window => window.selected > 0).map(window => {
        const last = window.segmentIndex === windows[windows.length - 1].segmentIndex
          && window.end === windows[windows.length - 1].end;
        return { ...window, start: last ? window.end - window.selected : window.start,
          end: last ? window.end : window.start + window.selected };
      });
    }
    const packets = [];
    let packetUsed = 0;
    let analyzedCharacters = 0;
    for (const window of selected) {
      for (let start = window.start; start < window.end;) {
        if (!packets.length || packetUsed === packetCharacters) {
          packets.push({ excerpts: [] });
          packetUsed = 0;
        }
        const end = Math.min(window.end, start + packetCharacters - packetUsed);
        const text = window.text.slice(start, end);
        packets[packets.length - 1].excerpts.push({ id: "s" + window.segmentIndex + ":" + start,
          pageIndex: window.pageIndex, segmentIndex: window.segmentIndex, start, end, text, sectionHint: window.hint });
        packetUsed += text.length;
        analyzedCharacters += text.length;
        sections.get(window.hint).selectedCharacters += text.length;
        start = end;
      }
    }
    return { packets, totalCharacters, analyzedCharacters, omittedCharacters: totalCharacters - analyzedCharacters,
      selectionStrategy: analyzedCharacters === totalCharacters ? "complete-source" : "section-position-heuristic",
      sections: Array.from(sections.values()), completeSelection: analyzedCharacters === totalCharacters };
  }

  function validateModelOutput(raw, document, source) {
    if (!raw || !Array.isArray(raw.dimensions) || raw.dimensions.length > 12) {
      throw error("MODEL_SCHEMA_INVALID", "模型 JSON 的 dimensions 数组缺失、类型错误或条目数超限；请检查分析提示词与模型输出。");
    }
    function validateValue(spec, value) {
      const evidence = (Array.isArray(value && value.evidence) ? value.evidence : []).slice(0, 8)
        .map(entry => validateEvidence(entry, document, source.attachmentKey));
      const supported = evidence.some(entry => entry.verified);
      return {
        id: spec.id, label: spec.label,
        summary: supported && typeof value.summary === "string" ? value.summary.slice(0, 6000) : "信息不足",
        confidence: supported ? "low" : "none", evidence,
        modelInference: true
      };
    }
    return DIMENSIONS.map(spec => {
      const value = raw.dimensions.find(entry => entry && entry.id === spec.id);
      const dimension = validateValue(spec, value);
      if (spec.id === "contributions") dimension.subtypes = CONTRIBUTION_TYPES.map(type =>
        validateValue(type, (Array.isArray(value && value.subtypes) ? value.subtypes : []).find(entry => entry && entry.id === type.id)));
      return dimension;
    });
  }

  function validateModelNarrative(raw, document, source) {
    const result = {};
    for (const name of ["overview", "readingGuide"]) {
      const evidence = (Array.isArray(raw[name + "Evidence"]) ? raw[name + "Evidence"] : []).slice(0, 12)
        .map(entry => validateEvidence(entry, document, source.attachmentKey)).filter(entry => entry.verified);
      result[name] = evidence.length && typeof raw[name] === "string" ? raw[name].slice(0, 10000) : "";
      result[name + "Evidence"] = evidence;
    }
    result.figureTableReferences = (Array.isArray(raw.figureTableReferences) ? raw.figureTableReferences : []).slice(0, 40)
      .filter(entry => entry && typeof entry.reference === "string" && typeof entry.explanation === "string")
      .map(entry => {
        const evidence = validateEvidence(entry, document, source.attachmentKey);
        const reference = entry.reference.trim().slice(0, 100);
        const identifier = /^(Figure|Fig\.?|图|Table|表)\s*(\d+[A-Za-z]?)$/i.exec(reference);
        const figure = !!identifier && /^(?:Figure|Fig\.?|图)$/i.test(identifier[1]);
        const labels = figure ? "(?:Figure|Fig\\.?|图)" : "(?:Table|表)";
        // Match the entire identifier, including its suffix. Adjacent Unicode letters or
        // digits (e.g. Figure10附录A) cannot supply evidence for a shorter reference.
        const mentionsReference = !!identifier && new RegExp("(?:^|[^\\p{L}\\p{N}\\p{M}_])" + labels + "\\s*" + identifier[2]
          + "(?![\\p{L}\\p{N}\\p{M}_])", "iu").test(normalizeText(evidence.quote));
        return { reference, kind: figure ? "figure" : "table", explanation: entry.explanation.slice(0, 3000), ...evidence,
          candidate: true, requiresVerification: true, visualVerified: false,
          label: "图表文字引用候选；未解析图像或确认图注", accepted: mentionsReference && evidence.verified };
      }).filter(entry => entry.accepted).map(({ accepted, ...entry }) => entry);
    return result;
  }

  function analysisNoteHTML(result, marker) {
    let html = '<div data-schema-version="9"><h1>Reading Room · 论文预读</h1><p>' + escapeHTML(marker) + '</p>';
    html += "<p>生成时间：" + escapeHTML(result.createdAt) + "；模式：" + escapeHTML(result.mode) + "</p>";
    for (const [name, label] of [["overview", "论文概述"], ["readingGuide", "阅读建议"]]) {
      if (!result[name]) continue;
      html += "<h2>" + label + "</h2><p>" + escapeHTML(result[name]) + "</p>";
      for (const entry of result[name + "Evidence"] || []) html += "<blockquote><p>" + escapeHTML(entry.quote) + "</p></blockquote>";
    }
    for (const dimension of result.dimensions || []) {
      html += "<h2>" + escapeHTML(dimension.label) + "</h2><p>" + escapeHTML(dimension.summary) + "</p>";
      html += "<p>置信度：" + escapeHTML(dimension.confidence) + "</p>";
      const evidenceGroups = [dimension, ...(dimension.subtypes || [])];
      for (const group of evidenceGroups) {
        if (group !== dimension) html += "<h3>" + escapeHTML(group.label) + "</h3><p>" + escapeHTML(group.summary) + "</p>";
        for (const entry of group.evidence || []) {
          const location = entry.pageIndex == null ? "页码不可用" : "PDF 第 " + (entry.pageIndex + 1) + " 页";
          html += "<blockquote><p>" + escapeHTML(entry.quote) + "</p></blockquote><p>" + escapeHTML(location + "；" + (entry.verified ? "引文已逐字匹配，结论仍需核对" : "未验证引文")) + "</p>";
        }
      }
    }
    html += "<h2>覆盖范围与限制</h2><pre>" + escapeHTML(JSON.stringify(result.coverage || {}, null, 2)) + "</pre>";
    for (const limitation of result.limitations || []) html += "<p>" + escapeHTML(limitation) + "</p>";
    html += "<h2>术语线索</h2><p>" + escapeHTML((result.terms || []).map(entry => entry.term).join(", ")) + "</p>";
    html += "<h2>图表与引用上下文候选</h2>";
    for (const entry of [...(result.figureTableReferences || []), ...(result.citationCandidates || [])]) {
      html += "<p>" + escapeHTML(entry.reference || entry.label || "需人工核对") + "</p><blockquote><p>" + escapeHTML(entry.quote) + "</p></blockquote>";
      if (entry.explanation) html += "<p>" + escapeHTML(entry.explanation) + "</p>";
    }
    const source = result.source || {};
    html += "<h2>来源</h2><pre>" + escapeHTML(JSON.stringify({ itemURI: source.itemURI, itemKey: source.itemKey,
      attachmentKey: source.attachmentKey, textHash: source.textHash, extraction: source.extraction }, null, 2)) + "</pre>";
    return html + "</div>";
  }

  scope.ReadingRoomCore = Object.freeze({ SCHEMA_VERSION, STATUSES, API_PROVIDERS, DIMENSIONS, CONTRIBUTION_TYPES, error, clone, identity,
    defaultState, patchState, escapeHTML, hash, normalizeText, documentFromFullText, validateEvidence,
    validateEndpoint, chunkDocument, planAnalysis, validateModelOutput, validateModelNarrative, analysisNoteHTML });
})(this);
