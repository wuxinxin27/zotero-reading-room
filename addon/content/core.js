/* Pure domain logic. Loaded as a privileged subscript, with no network or file access. */
(function (scope) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const STATUSES = Object.freeze(["unread", "to_read", "reading", "read", "parked"]);
  const DIMENSIONS = Object.freeze([
    { id: "problem", label: "解决的问题", cues: /\b(problem|challenge|aim|objective|address|limitation|bottleneck)\b|问题|挑战|旨在|解决|局限/i },
    { id: "novelty", label: "新颖性", cues: /\b(novel|new|first|introduce|propos\w*|unlike|innovation)\b|首次|新颖|提出|创新/i },
    { id: "contributions", label: "贡献", cues: /\b(contribut\w*|theorem|algorithm|experiment\w*|implementation|framework|release|prove)\b|贡献|定理|算法|实验|实现|开源/i },
    { id: "prior-work", label: "与前人工作的关系", cues: /\b(previous|prior|related work|existing|et al\.|baseline|literature)\b|前人|相关工作|已有|现有|文献/i },
    { id: "superiority", label: "优势与适用边界", cues: /\b(outperform\w*|improv\w*|better|accuracy|efficien\w*|speedup|trade.off|limitation|failure)\b|优于|提升|准确率|效率|局限|失败|权衡/i },
    { id: "technical-uniqueness", label: "技术独特之处", cues: /\b(architecture|mechanism|formulation|optimization|objective function|representation|module|pipeline|design)\b|架构|机制|优化|目标函数|表征|模块|流程|设计/i }
  ]);
  const CONTRIBUTION_TYPES = Object.freeze([
    { id: "theory", label: "理论", cues: /\b(theorem|proof|prove|bound|convergence|lemma|theoretical)\b|定理|证明|收敛|理论/i },
    { id: "algorithm", label: "算法", cues: /\b(algorithm|optimization|procedure|pseudocode|solver)\b|算法|优化|求解/i },
    { id: "experiment", label: "实验", cues: /\b(experiment\w*|benchmark|evaluation|ablation|dataset|empirical)\b|实验|评估|消融|数据集/i },
    { id: "engineering", label: "工程", cues: /\b(implementation|release|open.source|software|system|deployment|code)\b|工程|实现|开源|部署|代码/i }
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
    return { schemaVersion: SCHEMA_VERSION, status: "unread", notes: "", checklist: {}, lastPage: null, updatedAt: null };
  }

  function patchState(previous, patch, timestamp) {
    if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
      throw error("INVALID_STATE", "阅读状态更新必须是对象。");
    }
    const next = Object.assign(defaultState(), clone(previous || {}));
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

  function sentences(document) {
    const result = [];
    for (const segment of document.segments) {
      for (const paragraph of segment.text.split(/\n\s*\n|(?<=[.!?。！？])\s+(?=[A-Z\u4e00-\u9fff])/u)) {
        const trimmed = paragraph.trim();
        if (trimmed.length < 20) continue;
        // Preserve exact substrings, including whitespace, for independently verifiable evidence.
        for (let offset = 0; offset < trimmed.length; offset += 700) {
          const quote = trimmed.slice(offset, offset + 700).trim();
          if (quote.length >= 20) result.push({ quote, pageIndex: segment.pageIndex });
        }
      }
    }
    return result;
  }

  function candidates(parts, cues, document, attachmentKey, limit = 3) {
    const found = [];
    const seen = new Set();
    for (const part of parts) {
      if (!cues.test(part.quote)) continue;
      const key = normalizeText(part.quote);
      if (seen.has(key)) continue;
      const evidence = validateEvidence(part, document, attachmentKey);
      if (!evidence.verified) continue;
      seen.add(key);
      found.push(evidence);
      if (found.length >= limit) break;
    }
    return found;
  }

  function dimensionValue(spec, evidence) {
    return {
      id: spec.id, label: spec.label,
      summary: evidence.length ? "原文候选摘录；仅按词语线索归类，请核对上下文。" : "信息不足",
      confidence: evidence.length ? "low" : "none", evidence
    };
  }

  function extractTerms(text) {
    const stop = new Set(("about after again against also among analysis another approach based because been before being between both can cannot could data does each from further have however into itself more most must only other ours over paper results same section should show shown shows some such than that their them then there these they this those through under using used very were what when where which while will with within without work would text figure table proposed method methods study studies model models" ).split(/\s+/));
    const counts = new Map();
    for (const token of text.toLowerCase().match(/[a-z][a-z-]{3,35}/g) || []) {
      if (!stop.has(token)) counts.set(token, (counts.get(token) || 0) + 1);
    }
    return Array.from(counts, ([term, count]) => ({ term, count })).filter(entry => entry.count > 1)
      .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term)).slice(0, 24);
  }

  function extractiveAnalysis(document, source) {
    const parts = sentences(document);
    const dimensions = DIMENSIONS.map(spec => {
      const dimension = dimensionValue(spec, candidates(parts, spec.cues, document, source.attachmentKey));
      if (spec.id === "contributions") {
        dimension.subtypes = CONTRIBUTION_TYPES.map(type => dimensionValue(type, candidates(parts, type.cues, document, source.attachmentKey, 2)));
      }
      return dimension;
    });
    const sectionCues = [];
    const figureTableReferences = [];
    for (const segment of document.segments) {
      for (const line of segment.text.split(/\r?\n/)) {
        if (line.trim().length < 140 && /^(?:\d+(?:\.\d+)*\.?\s*)?(?:abstract|introduction|related work|method\w*|experiment\w*|evaluation|results|discussion|conclusion\w*|references|摘要|引言|相关工作|方法|实验|结论|参考文献)(?:\s|$|[:：])/i.test(line.trim())) {
          if (sectionCues.length < 40) sectionCues.push({ text: line.trim(), pageIndex: segment.pageIndex });
        }
      }
      const seen = new Set();
      for (const match of segment.text.matchAll(/\b(?:Figure|Fig\.?|Table)\s*\d+[A-Za-z]?|[图表]\s*\d+[A-Za-z]?/gi)) {
        if (figureTableReferences.length >= 60) break;
        const ref = match[0];
        if (seen.has(ref)) continue;
        seen.add(ref);
        const start = Math.max(0, match.index - 70);
        const quote = segment.text.slice(start, match.index + ref.length + 130).trim();
        figureTableReferences.push({ reference: ref, ...validateEvidence({ quote, pageIndex: segment.pageIndex }, document, source.attachmentKey) });
      }
    }
    const citationCandidates = candidates(parts, /\[\d+(?:\s*[,–-]\s*\d+)*\]|\bet al\.|\([A-Z][A-Za-z-]+(?:\s+et al\.)?,?\s+(?:19|20)\d{2}\)/, document, source.attachmentKey, 12)
      .map(entry => ({ ...entry, requiresVerification: true, label: "引用上下文候选，需核对参考文献" }));
    return {
      schemaVersion: SCHEMA_VERSION, mode: "extractive", dimensions,
      terms: extractTerms(document.text), sectionCues, figureTableReferences, citationCandidates,
      coverage: { extractedCharacters: document.text.length, analyzedCharacters: document.text.length, ratio: 1,
        extractedPages: document.extractedPages, totalPages: document.totalPages, pageAware: document.pageAware,
        completeDocument: document.totalPages != null && document.extractedPages === document.totalPages },
      limitations: [...document.limitations, "这是本地抽取式预读：只展示原文线索，不据此断言创新性、优越性、理论正确性或引用关系；低置信度归类需人工核对。"],
      source: clone(source)
    };
  }

  function validateEndpoint(input, allowRemote = false) {
    let endpoint;
    try { endpoint = new URL(input || "http://127.0.0.1:11434/v1/chat/completions"); }
    catch (_) { throw error("UNSAFE_ENDPOINT", "模型端点必须是有效的 HTTP(S) 地址。"); }
    if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw error("UNSAFE_ENDPOINT", "模型端点仅允许无内嵌凭据、查询参数和片段的 HTTP(S) 地址。");
    }
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname.toLowerCase());
    if (!local && (!allowRemote || endpoint.protocol !== "https:")) {
      throw error("REMOTE_CONSENT_REQUIRED", "远程模型必须使用 HTTPS，并明确允许发送本文文本。");
    }
    if (!/\/chat\/completions\/?$/.test(endpoint.pathname)) {
      endpoint.pathname = endpoint.pathname.replace(/\/$/, "") + "/chat/completions";
    }
    return { url: endpoint.href, local };
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

  function validateModelOutput(raw, document, source) {
    if (!raw || !Array.isArray(raw.dimensions) || raw.dimensions.length > 12) {
      throw error("INVALID_MODEL_OUTPUT", "模型没有返回约定的 dimensions JSON 结构。");
    }
    return DIMENSIONS.map(spec => {
      const value = raw.dimensions.find(entry => entry && entry.id === spec.id);
      const evidence = (Array.isArray(value && value.evidence) ? value.evidence : []).slice(0, 8)
        .map(entry => validateEvidence(entry, document, source.attachmentKey));
      const supported = evidence.some(entry => entry.verified);
      return {
        id: spec.id, label: spec.label,
        summary: supported && typeof value.summary === "string" ? value.summary.slice(0, 6000) : "信息不足",
        confidence: supported ? "low" : "none", evidence,
        modelInference: true
      };
    });
  }

  function analysisNoteHTML(result, marker) {
    let html = '<div data-schema-version="9"><h1>Reading Room · 论文预读</h1><p>' + escapeHTML(marker) + '</p>';
    html += "<p>生成时间：" + escapeHTML(result.createdAt) + "；模式：" + escapeHTML(result.mode) + "</p>";
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
    }
    const source = result.source || {};
    html += "<h2>来源</h2><pre>" + escapeHTML(JSON.stringify({ itemURI: source.itemURI, itemKey: source.itemKey,
      attachmentKey: source.attachmentKey, textHash: source.textHash, extraction: source.extraction }, null, 2)) + "</pre>";
    return html + "</div>";
  }

  scope.ReadingRoomCore = Object.freeze({ SCHEMA_VERSION, STATUSES, DIMENSIONS, CONTRIBUTION_TYPES, error, clone, identity,
    defaultState, patchState, escapeHTML, hash, normalizeText, documentFromFullText, validateEvidence,
    extractiveAnalysis, validateEndpoint, chunkDocument, validateModelOutput, analysisNoteHTML });
})(this);
