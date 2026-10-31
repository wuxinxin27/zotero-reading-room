import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, paper, plain } from "./fixtures/harness.mjs";

test("initialization and description do not extract, index, upload, or create notes", async () => {
  const h = createHarness();
  await h.service.init();
  const description = await h.service.describe(h.attachment);
  assert.equal(description.item.title, "A Synthetic Calibration Study");
  assert.equal(description.item.year, "2025");
  assert.deepEqual(plain(description.item.creators), ["Test Author"]);
  assert.equal(description.attachments[0].available, true);
  assert.equal(description.counts.annotations, 1);
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.noteSaves, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(JSON.stringify(description).includes("/synthetic/library"), false);
});

test("attachment/note normalization and library-qualified identity preserve separate records", async () => {
  const h = createHarness();
  const note = new h.Note("note");
  note.parentID = h.parent.id;
  assert.equal(h.service.normalizeItem(note), h.parent);
  assert.equal(h.service.normalizeItem({ isRegularItem: () => false }), null);
  await h.service.setState(h.attachment, { notes: "对子附件输入的阅读笔记", status: "reading" });
  const second = { ...h.parent, id: 9, libraryID: 2 };
  await h.service.setState(second, { status: "parked" });
  assert.equal(h.service.getState(h.parent).notes, "对子附件输入的阅读笔记");
  assert.equal(h.service.getState(h.parent).status, "reading");
  assert.equal(h.service.getState(second).status, "parked");
  assert.equal(h.service.getState(second).notes, "");
});

test("concurrent partial updates serialize and reload without losing free notes or checklist", async () => {
  const h = createHarness();
  await h.service.init();
  await Promise.all([
    h.service.setState(h.parent, { notes: "不可丢失\n第二行" }),
    h.service.setState(h.parent, { status: "reading" }),
    h.service.setState(h.parent, { checklist: { problem: true, theory: false }, lastPage: 3 })
  ]);
  const state = h.service.getState(h.parent);
  assert.equal(state.notes, "不可丢失\n第二行");
  assert.equal(state.status, "reading");
  assert.equal(state.checklist.problem, true);
  assert.equal(state.lastPage, 3);
  assert.ok(h.calls.writes.every(call => call.options.tmpPath === h.statePath + ".tmp" && call.options.backupFile === h.statePath + ".bak" && call.options.flush));
  const reloaded = new h.Service(h.Zotero);
  await reloaded.init();
  assert.equal(reloaded.getState(h.parent).notes, "不可丢失\n第二行");
  assert.equal(reloaded.getState(h.parent).status, "reading");
});

test("disk failures retain last saved memory and do not poison subsequent queued writes", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { notes: "已保存" });
  const before = h.files.get(h.statePath);
  h.io.failWrite = true;
  await assert.rejects(h.service.setState(h.parent, { notes: "未保存" }), { code: "STATE_WRITE_FAILED" });
  assert.equal(h.service.getState(h.parent).notes, "已保存");
  assert.equal(h.files.get(h.statePath), before);
  h.io.failWrite = false;
  await h.service.setState(h.parent, { status: "read" });
  assert.equal(h.service.getState(h.parent).notes, "已保存");
  assert.equal(h.service.getState(h.parent).status, "read");
});

test("corrupt or future schema files fail closed without overwriting bytes", async () => {
  for (const content of ["{broken", '{"schemaVersion":99,"items":{}}']) {
    const h = createHarness();
    h.files.set(h.statePath, content);
    await assert.rejects(h.service.init(), error => ["STATE_CORRUPT", "STATE_SCHEMA_UNSUPPORTED"].includes(error.code));
    assert.equal(h.files.get(h.statePath), content);
    assert.equal(h.calls.writes.length, 0);
    await assert.rejects(h.service.setState(h.parent, { notes: "new" }));
  }
});

test("explicit extractive analysis quotes real text, preserves reading state, and writes no Zotero note", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { status: "reading", notes: "我自己的判断", checklist: { novelty: true } });
  const progress = [];
  const result = await h.service.analyze(h.attachment, { onProgress: job => progress.push(job.status) });
  assert.equal(h.calls.extracts, 1);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.noteSaves, 0);
  assert.equal(result.dimensions.length, 6);
  assert.equal(result.source.attachmentKey, h.attachment.key);
  assert.equal(result.coverage.pageAware, true);
  assert.equal(result.coverage.completeDocument, true);
  assert.ok(result.dimensions.flatMap(entry => entry.evidence).every(entry => paper.text.includes(entry.quote) && entry.verified));
  assert.equal(h.service.getState(h.parent).status, "reading");
  assert.equal(h.service.getState(h.parent).notes, "我自己的判断");
  assert.equal(h.service.getState(h.parent).checklist.novelty, true);
  assert.equal(h.service.getState(h.parent).analysis.id, result.id);
  assert.deepEqual(progress, ["extracting", "analyzing", "saving", "complete"]);
  assert.equal(h.service.getState(h.parent).analysisJob.status, "complete");
  assert.equal(JSON.stringify(result).includes("/synthetic/library"), false);
});

test("missing PDFs, wrong attachment selection, empty scans, and extraction errors are explicit", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { notes: "保留" });
  h.files.delete(h.attachment.localPath);
  await assert.rejects(h.service.analyze(h.parent), { code: "PDF_MISSING" });
  assert.equal(h.calls.extracts, 0);
  await assert.rejects(h.service.analyze(h.parent, { attachmentID: 999 }), { code: "ATTACHMENT_NOT_FOUND" });
  assert.equal(h.service.getState(h.parent).notes, "保留");
  const scanned = createHarness({ extracted: { text: "", extractedPages: 2, totalPages: 2 } });
  await assert.rejects(scanned.service.analyze(scanned.parent), { code: "PDF_TEXT_EMPTY" });
  const failed = createHarness();
  failed.Zotero.PDFWorker.getFullText = async () => { throw new Error("private/path/or/content"); };
  await assert.rejects(failed.service.analyze(failed.parent), error => error.code === "PDF_EXTRACTION_FAILED" && !error.message.includes("private"));
});

test("ambiguous PDF text never invents page links", async () => {
  const h = createHarness({ extracted: { ...paper, text: paper.text.replace("\f", "\n") } });
  const result = await h.service.analyze(h.parent);
  assert.equal(result.coverage.pageAware, false);
  assert.ok(result.dimensions.flatMap(entry => entry.evidence).every(entry => entry.pageIndex === null));
  assert.ok(result.limitations.some(value => value.includes("不标页码")));
});

test("group and read-only libraries reject every Zotero note write but allow local reading state", async () => {
  for (const config of [{ libraryType: "group" }, { editable: false }]) {
    const h = createHarness(config);
    await h.service.setState(h.parent, { notes: "本地侧文件", status: "reading" });
    await assert.rejects(h.service.syncStateNote(h.parent), { code: "NOTE_WRITE_FORBIDDEN" });
    const result = await h.service.analyze(h.parent);
    await assert.rejects(h.service.saveAnalysisNote(h.parent, result), { code: "NOTE_WRITE_FORBIDDEN" });
    assert.equal(h.calls.noteSaves, 0);
    assert.equal(h.service.getState(h.parent).notes, "本地侧文件");
  }
});

test("analysis note writes are explicit, idempotent per result, append new versions, and leave handwritten notes", async () => {
  const h = createHarness();
  const handwritten = new h.Note("note");
  handwritten.libraryID = 1;
  handwritten.parentID = 1;
  handwritten.setNote("<p>自己的原始笔记</p>");
  await handwritten.saveTx();
  const first = await h.service.analyze(h.parent);
  const saved = await h.service.saveAnalysisNote(h.parent);
  assert.equal(saved.created, true);
  assert.equal(h.calls.noteSaves, 2);
  const repeated = await h.service.saveAnalysisNote(h.parent, first);
  assert.equal(repeated.id, saved.id);
  assert.equal(repeated.created, false);
  assert.equal(h.calls.noteSaves, 2);
  h.records.get(saved.id).setNote(h.records.get(saved.id).getNote() + "<p>我的补充</p>");
  await h.service.saveAnalysisNote(h.parent, first);
  assert.match(h.records.get(saved.id).getNote(), /我的补充/);
  const second = await h.service.analyze(h.parent);
  const next = await h.service.saveAnalysisNote(h.parent, second);
  assert.notEqual(next.id, saved.id);
  assert.equal(handwritten.getNote(), "<p>自己的原始笔记</p>");
  assert.equal(h.calls.noteSaves, 3);
});

test("state-note synchronization escapes text, updates only its own snapshot, and detects manual edits across reload", async () => {
  const h = createHarness();
  const hostile = '<script>throw "oops"</script>';
  await h.service.setState(h.parent, { notes: hostile, status: "reading" });
  const first = await h.service.syncStateNote(h.parent);
  assert.equal(first.created, true);
  const note = h.records.get(first.id);
  assert.equal(note.getNote().includes("<script>"), false);
  assert.ok(note.getNote().includes("&lt;script&gt;"));
  const repeated = await h.service.syncStateNote(h.parent);
  assert.equal(repeated.changed, false);
  assert.equal(h.calls.noteSaves, 1);
  await h.service.setState(h.parent, { status: "read" });
  const updated = await h.service.syncStateNote(h.parent);
  assert.equal(updated.id, first.id);
  assert.equal(updated.changed, true);
  assert.equal(h.calls.noteSaves, 2);
  note.setNote(note.getNote() + "<p>用户手工增补，不能覆盖</p>");
  const reloaded = new h.Service(h.Zotero);
  await reloaded.init();
  await reloaded.setState(h.parent, { status: "parked" });
  await assert.rejects(reloaded.syncStateNote(h.parent), { code: "NOTE_EDIT_CONFLICT" });
  assert.match(note.getNote(), /用户手工增补/);
  assert.equal(reloaded.getState(h.parent).status, "parked");
  assert.equal(h.calls.noteSaves, 2);
});

test("unsafe model endpoints and missing models fail before PDF extraction or upload", async () => {
  const h = createHarness();
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", model: "demo", endpoint: "https://example.org/v1" }), { code: "REMOTE_CONSENT_REQUIRED" });
  await assert.rejects(h.service.analyze(h.parent, { mode: "model" }), { code: "MODEL_REQUIRED" });
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
  const group = createHarness({ libraryType: "group" });
  await assert.rejects(group.service.analyze(group.parent, { mode: "model", model: "demo", endpoint: "https://example.org/v1", allowRemote: true }), { code: "GROUP_REMOTE_FORBIDDEN" });
});

test("genuine model HTTP requests are bounded and validated; API keys are never persisted", async () => {
  const h = createHarness();
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    const sent = JSON.parse(options.body);
    const chunk = JSON.parse(sent.messages[1].content);
    const validQuote = chunk.text.slice(0, 80);
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [
      { id: "problem", summary: "模型候选解释", evidence: [{ quote: validQuote, pageIndex: chunk.pageIndex }] },
      { id: "novelty", summary: "不能凭空确认的创新", evidence: [{ quote: "A fabricated quotation not in this paper.", pageIndex: chunk.pageIndex }] }
    ] }) } }] } };
  };
  const secret = "unit-test-memory-key-ONLY";
  const result = await h.service.analyze(h.parent, { mode: "model", model: "synthetic-model", apiKey: secret });
  assert.equal(h.calls.requests.length, 2);
  assert.equal(result.mode, "model");
  assert.equal(result.dimensions[0].summary, "模型候选解释");
  assert.equal(result.dimensions[1].summary, "信息不足");
  assert.equal(result.dimensions[1].evidence[0].verified, false);
  assert.equal(result.coverage.ratio, 1);
  assert.equal(result.coverage.completeDocument, true);
  const request = h.calls.requests[0];
  assert.equal(request.options.headers.Authorization, "Bearer " + secret);
  assert.equal(request.options.followRedirects, false);
  assert.equal(request.options.logBodyLength, 0);
  assert.equal(request.options.timeout, 120000);
  assert.ok(JSON.parse(request.options.body).messages[0].content.includes("untrusted"));
  assert.equal(h.files.get(h.statePath).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(h.calls.noteSaves, 0);
});

test("model errors redact response content and preserve previous analysis", async () => {
  const h = createHarness();
  const earlier = await h.service.analyze(h.parent);
  h.Zotero.HTTP.request = async () => { throw new Error("secret key and private PDF text"); };
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", model: "demo" }), error => error.code === "MODEL_REQUEST_FAILED" && !error.message.includes("private PDF"));
  assert.equal(h.service.getState(h.parent).analysis.id, earlier.id);
});

test("cancellation stops analysis persistence and simultaneous same-paper jobs are rejected", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { notes: "保留阅读笔记", status: "reading" });
  let release;
  h.Zotero.PDFWorker.getFullText = () => new Promise(resolve => { release = resolve; });
  const controller = new AbortController();
  const pending = h.service.analyze(h.parent, { signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 10));
  await assert.rejects(h.service.analyze(h.parent), { code: "ANALYSIS_RUNNING" });
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  release(paper);
  assert.equal(h.service.getState(h.parent).analysis, undefined);
  assert.equal(h.service.getState(h.parent).status, "reading");
  assert.equal(h.service.getState(h.parent).notes, "保留阅读笔记");
  assert.equal(h.service.getState(h.parent).analysisJob.status, "cancelled");
});

test("evidence opens only a matching local attachment and library stats read metadata only", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { status: "read" });
  await h.service.openEvidence(h.parent, { attachmentKey: h.attachment.key, pageIndex: 1 });
  assert.deepEqual(plain(h.calls.opened[0]), { id: 2, location: { pageIndex: 1 } });
  await assert.rejects(h.service.openEvidence(h.parent, { attachmentKey: "OTHERS01", pageIndex: 1 }), { code: "PDF_MISSING" });
  const stats = await h.service.getLibraryStats(1);
  assert.equal(stats.total, 1);
  assert.equal(stats.byStatus.read, 1);
  assert.equal(stats.byYear["2025"], 1);
  assert.equal(stats.byType.journalArticle, 1);
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
});

test("metadata hydration uses Zotero's skip-loaded bulk adapter and ignores non-file annotations", async () => {
  const h = createHarness();
  const loaded = [];
  h.Zotero.Items.loadDataTypes = async (items, types) => { loaded.push({ ids: items.map(item => item.id), types }); };
  h.parent.loadDataType = () => { throw new Error("must not reload cached item data"); };
  const linked = { ...h.attachment, id: 3, key: "LINKED01", attachmentContentType: "text/html",
    isFileAttachment: () => false,
    getAnnotations() { throw new Error("not a file attachment"); }
  };
  h.records.set(linked.id, linked);
  const described = await h.service.describe(h.parent);
  assert.equal(described.attachments.length, 2);
  assert.equal(described.counts.annotations, 1);
  await h.service.getLibraryStats(1);
  assert.ok(loaded.some(value => value.types.includes("creators")));
  assert.ok(loaded.some(value => value.ids.length === 1 && value.types.length === 1 && value.types[0] === "itemData"));
});

test("an analysis note survives a sidecar failure and retry relinks without duplicating or overwriting", async () => {
  const h = createHarness();
  const result = await h.service.analyze(h.parent);
  h.io.failWrite = true;
  await assert.rejects(h.service.saveAnalysisNote(h.parent, result), { code: "STATE_WRITE_FAILED" });
  assert.equal(h.calls.noteSaves, 1);
  const note = Array.from(h.records.values()).find(item => item.isNote());
  note.setNote(note.getNote() + "<p>用户补充</p>");
  h.io.failWrite = false;
  const retried = await h.service.saveAnalysisNote(h.parent, result);
  assert.equal(retried.created, false);
  assert.equal(retried.id, note.id);
  assert.equal(h.calls.noteSaves, 1);
  assert.match(note.getNote(), /用户补充/);
});

test("a state note without a persisted conflict baseline is retained without duplicate creation", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { notes: "safe" });
  h.io.failWrite = true;
  await assert.rejects(h.service.syncStateNote(h.parent), { code: "STATE_WRITE_FAILED" });
  assert.equal(h.calls.noteSaves, 1);
  h.io.failWrite = false;
  await assert.rejects(h.service.syncStateNote(h.parent), { code: "NOTE_OWNERSHIP_CONFLICT" });
  assert.equal(h.calls.noteSaves, 1);
});

test("cancel at the save boundary prevents persisting an analysis", async () => {
  const h = createHarness();
  await h.service.setState(h.parent, { notes: "retain" });
  await assert.rejects(h.service.analyze(h.parent, {
    onProgress(job) { if (job.status === "saving") h.service.cancelAnalysis(h.parent); }
  }), { code: "CANCELLED" });
  assert.equal(h.service.getState(h.parent).analysis, undefined);
  assert.equal(h.service.getState(h.parent).notes, "retain");
});
