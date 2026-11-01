import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskInput, createHarness, paper, plain } from "./fixtures/harness.mjs";

const quote = "We propose a novel calibration algorithm using a sparse graph representation.";
const answer = { answer: "论文提出稀疏图标定算法，仍需人工核对。", evidence: [{ quote, pageIndex: 0 }] };
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function response(value = answer, provider = "openai") {
  const text = JSON.stringify(value);
  return { status: 200, response: provider === "anthropic" ? { content: [{ type: "text", text }] }
    : provider === "gemini" ? { candidates: [{ content: { parts: [{ text }] } }] }
    : provider === "ollama" ? { message: { content: text } } : { choices: [{ message: { content: text } }] } };
}
function mockChat(h, provider = "openai", value = answer) {
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    return response(value, provider);
  };
}
function userPayload(call, provider = "openai") {
  const payload = JSON.parse(call.options.body);
  return parseTaskInput(provider === "gemini" ? payload.contents[0].parts[0].text
    : payload.messages.find(entry => entry.role === "user").content);
}
function addPaper(h, id, libraryID = 1, key = "PAPER" + String(id).padStart(3, "0")) {
  const parent = { ...h.parent, id, key, libraryID, fields: { ...h.parent.fields, title: "Synthetic paper " + id } };
  const attachment = { ...h.attachment, id: id + 1, key: "ATTAC" + String(id).padStart(3, "0"), libraryID,
    parentItemID: id, localPath: "/synthetic/library/paper-" + id + ".pdf" };
  h.records.set(id, parent); h.records.set(attachment.id, attachment); h.files.set(attachment.localPath, "synthetic");
  return { parent, attachment };
}
function tagAdapter(h, initial = [], parent = h.parent) {
  const state = { tags: plain(initial), stored: plain(initial), saves: 0, loads: [], reloads: 0, fail: false, dirty: false };
  h.Zotero.Items.loadDataTypes = async (items, types) => { state.loads.push({ ids: items.map(item => item.id), types: plain(types) }); };
  parent.getTags = () => plain(state.tags);
  parent.addTag = (tag, type = 0) => { state.tags.push({ tag, type }); return true; };
  parent.removeTag = tag => { state.tags = state.tags.filter(entry => entry.tag !== tag); return true; };
  parent.hasChanged = () => state.dirty;
  parent.saveTx = async () => { state.saves++; if (state.fail) throw new Error("private native failure"); state.stored = plain(state.tags); return parent.id; };
  parent.reload = async (types, force) => { assert.deepEqual(plain(types), ["tags"]); assert.equal(force, true); state.reloads++; state.tags = plain(state.stored); };
  return state;
}

test("history loads without file checks, extraction, model/configuration/key reads, HTTP, or writes", async () => {
  const h = createHarness({ configured: false });
  h.service._config = h.service._findCredential = () => { throw new Error("history must not consult model configuration"); };
  h.files.delete(h.attachment.localPath);
  const history = await h.service.getConversation(h.attachment, { attachmentID: h.attachment.id });
  assert.deepEqual(plain(history), { attachmentID: 2, attachmentKey: "ATTACH01", messages: [] });
  assert.equal(h.calls.fileChecks + h.calls.extracts + h.calls.requests.length + h.calls.writes.length, 0);
});

for (const provider of ["openai", "anthropic", "gemini", "ollama"]) {
  test(provider + ": saved protocol, exact custom chat prompt, permissions and structured wire fields are used", async () => {
    const h = createHarness();
    await h.service.saveAIConfig({ provider, endpoint: "http://127.0.0.1:11434", model: "chat-test" }, { apiKey: "synthetic-chat-key", rememberKey: false });
    const defaults = await h.service.getPromptConfig();
    const custom = "  完整对话提示词\n用自然段解释论文。  ";
    const config = await h.service.savePromptConfig({ systemPrompt: defaults.systemPrompt, synthesisInstruction: defaults.synthesisInstruction, chatSystemPrompt: custom });
    mockChat(h, provider);
    const result = await h.service.askPaper(h.attachment, "方法是什么？", { attachmentID: h.attachment.id });
    assert.equal(h.calls.requests.length, 1);
    const call = h.calls.requests[0], payload = JSON.parse(call.options.body);
    const system = provider === "anthropic" ? payload.system : provider === "gemini" ? payload.systemInstruction.parts[0].text : payload.messages[0].content;
    assert.equal(system, custom + "\n\n" + config.chatOutputContract);
    assert.equal(result.reply.effectiveSystemPrompt, system);
    assert.deepEqual(plain(result.reply.promptSnapshot), { systemPrompt: custom });
    assert.equal(result.reply.outputContractSnapshot, config.chatOutputContract);
    assert.equal(result.reply.outputContractVersion, config.outputContractVersion);
    assert.equal(result.reply.chatPromptHash, h.Core.hash(system));
    assert.equal(payload.model || "chat-test", "chat-test");
    const body = userPayload(call, provider);
    assert.equal(body.question, "方法是什么？"); assert.deepEqual(body.history, []);
    assert.ok(body.excerpts.some(entry => entry.pageIndex === 0 && entry.text.includes(quote)));
    assert.equal(call.method, "POST"); assert.equal(call.options.followRedirects, false); assert.equal(call.options.logBodyLength, 0);
    if (provider === "anthropic") { assert.equal(payload.max_tokens, 8192); assert.equal(call.options.headers["x-api-key"], "synthetic-chat-key"); }
    else if (provider === "gemini") { assert.ok(call.url.endsWith("/models/chat-test:generateContent")); assert.equal(payload.generationConfig.responseMimeType, "application/json"); assert.equal(call.options.headers["x-goog-api-key"], "synthetic-chat-key"); }
    else { assert.equal(payload.stream, false); assert.equal(call.options.headers.Authorization, "Bearer synthetic-chat-key"); }
    if (provider === "openai") assert.equal(payload.response_format.type, "json_object");
    if (provider === "ollama") { assert.equal(payload.format, "json"); assert.ok(call.url.endsWith("/api/chat")); }
    assert.equal(result.reply.grounded, true); assert.equal(result.reply.evidence[0].verified, true);
    assert.equal(result.messages.length, 2); assert.equal(result.reply.evidence[0].attachmentKey, h.attachment.key);
    const stored = h.files.get(h.statePath);
    assert.equal(stored.includes("synthetic-chat-key"), false); assert.equal(stored.includes("/synthetic/library"), false);
    assert.equal(h.calls.noteSaves, 0); assert.equal(h.service.getState(h.parent).status, "unread");
  });
}

test("chat prompt edits preserve exact analysis defaults/hash, omitted chat field, reload and full reset", async () => {
  const h = createHarness();
  const defaults = await h.service.getPromptConfig();
  const edited = await h.service.savePromptConfig({ ...defaults, chatSystemPrompt: "My full custom chat prompt" });
  assert.equal(edited.promptHash, defaults.promptHash); assert.notEqual(edited.chatPromptHash, defaults.chatPromptHash);
  assert.equal(edited.systemPrompt, defaults.systemPrompt); assert.equal(edited.synthesisInstruction, defaults.synthesisInstruction);
  const next = await h.service.savePromptConfig({ systemPrompt: defaults.systemPrompt, synthesisInstruction: defaults.synthesisInstruction });
  assert.equal(next.chatSystemPrompt, edited.chatSystemPrompt);
  for (const chatSystemPrompt of ["", " ", 42, "x".repeat(40001)]) {
    await assert.rejects(h.service.savePromptConfig({ ...defaults, chatSystemPrompt }), { code: "INVALID_PROMPT" });
  }
  const reload = new h.Service(h.Zotero);
  assert.equal((await reload.getPromptConfig()).chatSystemPrompt, edited.chatSystemPrompt);
  const reset = await reload.resetPromptConfig();
  assert.equal(reset.chatSystemPrompt, defaults.defaultChatSystemPrompt); assert.equal(reset.chatPromptHash, defaults.chatPromptHash);
});

test("successful pairs reload per parent/library/attachment without overwriting analysis, notes or reading state", async () => {
  const h = createHarness(); mockChat(h);
  await h.service.setState(h.parent, { status: "reading", notes: "Keep my notes", checklist: { own: true } });
  h.service._document.items["1:PAPER001"].analysis = { id: "existing-analysis" };
  await h.service.askPaper(h.parent, "第一个问题");
  const otherPDF = { ...h.attachment, id: 3, key: "ATTACH02", localPath: "/synthetic/library/second.pdf" };
  h.records.set(3, otherPDF); h.files.set(otherPDF.localPath, "synthetic");
  assert.equal((await h.service.getConversation(h.parent, { attachmentID: 3 })).messages.length, 0);
  await h.service.askPaper(h.parent, "第二个附件", { attachmentID: 3 });
  const second = addPaper(h, 10);
  assert.equal((await h.service.getConversation(second.parent)).messages.length, 0);
  await h.service.askPaper(second.parent, "另一篇论文的问题");
  assert.deepEqual(userPayload(h.calls.requests.at(-1)).history, []);
  h.libraries.set(2, { libraryID: 2, libraryType: "user", editable: true });
  const otherLibrary = addPaper(h, 20, 2, h.parent.key);
  assert.equal((await h.service.getConversation(otherLibrary.parent)).messages.length, 0);
  const reloaded = new h.Service(h.Zotero);
  assert.equal((await reloaded.getConversation(h.parent, { attachmentID: 2 })).messages[0].content, "第一个问题");
  assert.equal((await reloaded.getConversation(h.parent, { attachmentID: 3 })).messages[0].content, "第二个附件");
  const state = reloaded.getState(h.parent);
  assert.equal(state.notes, "Keep my notes"); assert.equal(state.status, "reading"); assert.equal(state.analysis.id, "existing-analysis"); assert.equal(state.checklist.own, true);
});

test("context is at most 24000 characters, selects late relevant pages and rejects genuine but unseen or wrong-page quotes", async () => {
  const pages = Array.from({ length: 50 }, (_, index) => "Page " + index + ". " + "Ordinary filler sentences. ".repeat(130));
  const relevant = "Quasarneedle evidence states that the proposed mechanism requires supervision.";
  const unseen = "UNSEEN UNIQUE SENTENCE is present on the final source page only.";
  pages[30] = relevant + pages[30]; pages[49] = unseen + pages[49];
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 50, totalPages: 50 } });
  mockChat(h, "openai", { answer: "<script>inert text</script>", evidence: [{ quote: relevant, pageIndex: 30 }, { quote: unseen, pageIndex: 49 }, { quote: relevant, pageIndex: 0 }] });
  const result = await h.service.askPaper(h.parent, "What is Quasarneedle?");
  const input = userPayload(h.calls.requests[0]);
  assert.ok(input.excerpts.reduce((total, entry) => total + entry.text.length, 0) <= 24000);
  assert.ok(input.excerpts.some(entry => entry.pageIndex === 0)); assert.ok(input.excerpts.some(entry => entry.pageIndex === 30));
  assert.equal(JSON.stringify(input).includes(unseen), false);
  assert.equal(result.reply.content, "<script>inert text</script>"); assert.equal(result.reply.evidence.length, 1);
  assert.equal(result.reply.evidence[0].pageIndex, 30); assert.equal(result.reply.rejectedEvidenceCount, 2);
});

test("no valid citations produce an explicit unverified notice; ambiguous pages never create false page evidence", async () => {
  const h = createHarness({ extracted: { ...paper, text: paper.text.replace("\f", "\n") } });
  mockChat(h);
  let result = await h.service.askPaper(h.parent, "问题一");
  assert.equal(result.reply.grounded, false); assert.equal(result.reply.evidence.length, 0);
  assert.match(result.reply.verificationNotice, /未核验.*信息不足/);
  mockChat(h, "openai", { ...answer, evidence: [{ quote, pageIndex: null }] });
  result = await h.service.askPaper(h.parent, "问题二");
  assert.equal(result.reply.evidence[0].pageIndex, null); assert.equal(result.reply.evidence[0].verified, true);
});

test("request history is limited to ten messages and 12000 characters without deleting saved conversation", async () => {
  const h = createHarness(); mockChat(h, "openai", { answer: "历史".repeat(2000), evidence: [] });
  for (let i = 0; i < 8; i++) await h.service.askPaper(h.parent, "历史问题" + i + "x".repeat(2000));
  const input = userPayload(h.calls.requests.at(-1));
  assert.ok(input.history.length <= 10); assert.ok(input.history.reduce((total, entry) => total + entry.content.length, 0) <= 12000);
  assert.equal((await h.service.getConversation(h.parent)).messages.length, 16);
});

test("invalid questions, missing configuration/PDF/text and malformed output are actionable and preserve history", async () => {
  const h = createHarness(); mockChat(h); await h.service.askPaper(h.parent, "成功问题");
  const before = plain(await h.service.getConversation(h.parent));
  for (const question of [null, "", "   ", "x".repeat(6001)]) await assert.rejects(h.service.askPaper(h.parent, question), { code: "INVALID_QUESTION" });
  await assert.rejects(h.service.askPaper(h.parent, "bad attachment", { attachmentID: 999 }), { code: "ATTACHMENT_NOT_FOUND" });
  h.files.delete(h.attachment.localPath);
  await assert.rejects(h.service.askPaper(h.parent, "missing"), { code: "PDF_MISSING" });
  h.files.set(h.attachment.localPath, "synthetic");
  for (const [value, code, message] of [
    [{ answer: "", evidence: [] }, "CHAT_ANSWER_INVALID", /非空/],
    [{ answer: 42, evidence: [] }, "CHAT_ANSWER_INVALID", /answer/],
    [{ answer: "x".repeat(12001), evidence: [] }, "CHAT_ANSWER_TOO_LONG", /12000/],
    [{ answer: "x", evidence: {} }, "CHAT_EVIDENCE_INVALID", /数组/],
    [{ answer: "x", evidence: Array(17).fill({}) }, "CHAT_EVIDENCE_TOO_MANY", /16/],
    [{ dimensions: [] }, "CHAT_STRUCTURE_INVALID", /分析任务结构/]
  ]) {
    mockChat(h, "openai", value); await assert.rejects(h.service.askPaper(h.parent, "invalid output"), error => error.code === code && message.test(error.message));
  }
  assert.deepEqual(plain(await h.service.getConversation(h.parent)), before);
  const noConfig = createHarness({ configured: false });
  await assert.rejects(noConfig.service.askPaper(noConfig.parent, "need model"), { code: "MODEL_REQUIRED" }); assert.equal(noConfig.calls.extracts, 0);
  const empty = createHarness({ extracted: { text: "", extractedPages: 1, totalPages: 1 } });
  await assert.rejects(empty.service.askPaper(empty.parent, "scan"), { code: "PDF_TEXT_EMPTY" }); assert.equal(empty.calls.requests.length, 0);
});

test("missing or null evidence yields an explicitly unverified answer without fabricated citations", async () => {
  const h = createHarness();
  for (const value of [{ answer: "信息不足" }, { answer: "无引用的回答", evidence: null }]) {
    mockChat(h, "openai", value);
    const result = await h.service.askPaper(h.parent, "无引用问题");
    assert.equal(result.reply.content, value.answer);
    assert.equal(result.reply.grounded, false);
    assert.deepEqual(plain(result.reply.evidence), []);
    assert.equal(result.reply.rejectedEvidenceCount, 0);
    assert.match(result.reply.verificationNotice, /未核验.*信息不足/);
  }
});

test("one active request per paper, frozen question/attachment/config/prompt and cancellation preserve earlier pairs", async () => {
  const h = createHarness(); mockChat(h); await h.service.askPaper(h.parent, "saved question");
  const before = plain(await h.service.getConversation(h.parent));
  const gate = deferred(), started = deferred();
  h.Zotero.HTTP.request = async (method, url, options) => { h.calls.requests.push({ method, url, options }); started.resolve(); return gate.promise; };
  const pending = h.service.askPaper(h.parent, "cancel question", { attachmentID: 2 });
  await started.promise;
  await assert.rejects(h.service.askPaper(h.parent, "second"), { code: "CHAT_RUNNING" });
  assert.equal(h.service.cancelChat(h.attachment), true);
  await assert.rejects(pending, { code: "CANCELLED" }); gate.resolve(response());
  assert.deepEqual(plain(await h.service.getConversation(h.parent)), before); assert.equal(h.service.cancelChat(h.parent), false);
  const extraction = deferred(), extracting = deferred();
  h.Zotero.PDFWorker.getFullText = () => { extracting.resolve(); return extraction.promise; };
  mockChat(h);
  const options = { attachmentID: 2 }, controller = new AbortController();
  options.signal = controller.signal;
  const send = h.service.askPaper(h.parent, "frozen question", options); await extracting.promise;
  options.attachmentID = 999;
  await h.service.saveAIConfig({ provider: "openai", endpoint: "http://127.0.0.1:5555", model: "later-model" });
  const defaults = await h.service.getPromptConfig();
  await h.service.savePromptConfig({ ...defaults, chatSystemPrompt: "LATER PROMPT" });
  extraction.resolve(plain(paper)); const result = await send;
  assert.equal(result.attachmentID, 2); assert.equal(result.messages.at(-2).content, "frozen question");
  assert.equal(JSON.parse(h.calls.requests.at(-1).options.body).model, "demo");
  assert.equal(h.calls.requests.at(-1).url.includes(":5555"), false);
  assert.notEqual(JSON.parse(h.calls.requests.at(-1).options.body).messages[0].content, "LATER PROMPT");
});

test("external abort, extraction failure, identity changes and disk failure never append a partial pair", async () => {
  for (const kind of ["abort", "extract", "identity", "disk"]) {
    const h = createHarness(); mockChat(h); await h.service.askPaper(h.parent, "saved");
    const bytes = h.files.get(h.statePath);
    const controller = new AbortController();
    if (kind === "abort") controller.abort();
    if (kind === "extract") h.Zotero.PDFWorker.getFullText = async () => { throw new Error("private path"); };
    if (kind === "identity") h.Zotero.PDFWorker.getFullText = async () => { h.attachment.key = "CHANGED1"; return plain(paper); };
    if (kind === "disk") h.io.failWrite = true;
    await assert.rejects(h.service.askPaper(h.parent, "failure", { signal: controller.signal }), error => ({ abort: "CANCELLED", extract: "PDF_EXTRACTION_FAILED", identity: "ATTACHMENT_NOT_FOUND", disk: "STATE_WRITE_FAILED" })[kind] === error.code);
    assert.equal(h.files.get(h.statePath), bytes);
  }
});

test("progress-boundary cancellation and shutdown preserve history; transport errors are redacted", async () => {
  for (const boundary of ["extracting", "saving"]) {
    const h = createHarness(); mockChat(h);
    await assert.rejects(h.service.askPaper(h.parent, "cancel", { onProgress(job) { if (job.status === boundary) h.service.cancelChat(h.parent); } }), { code: "CANCELLED" });
    assert.equal((await h.service.getConversation(h.parent)).messages.length, 0);
    if (boundary === "extracting") assert.equal(h.calls.extracts, 0);
    assert.equal(h.calls.writes.length, 0);
  }
  const h = createHarness(); mockChat(h); await h.service.askPaper(h.parent, "saved");
  const before = plain(await h.service.getConversation(h.parent));
  h.Zotero.HTTP.request = async () => { throw new Error("private upstream response and credentials"); };
  await assert.rejects(h.service.askPaper(h.parent, "failure"), error => error.code === "MODEL_REQUEST_FAILED" && !error.message.includes("private"));
  assert.deepEqual(plain(await h.service.getConversation(h.parent)), before);
  const started = deferred(), gate = deferred();
  h.Zotero.HTTP.request = async () => { started.resolve(); return gate.promise; };
  const pending = h.service.askPaper(h.parent, "shutdown"); await started.promise;
  await h.service.shutdown(); await assert.rejects(pending, { code: "CANCELLED" }); gate.resolve(response());
  assert.equal(h.service.getState(h.parent).conversations.ATTACH01.messages.length, 2);
});

test("remote analysis permission remains distinct from discovery; group remote chat is prohibited before extraction", async () => {
  for (const libraryType of ["user", "group"]) {
    const h = createHarness({ libraryType }); mockChat(h);
    await h.service.saveAIConfig({ provider: "openai", endpoint: "https://synthetic.example/v1", model: "demo", consentProvider: "openai", consentOrigin: "https://synthetic.example", allowRemoteDiscovery: true, allowRemoteAnalysis: false });
    await assert.rejects(h.service.askPaper(h.parent, "permission"), { code: "REMOTE_CONSENT_REQUIRED" });
    await h.service.saveAIConfig({ provider: "openai", endpoint: "https://synthetic.example/v1", model: "demo", consentProvider: "openai", consentOrigin: "https://synthetic.example", allowRemoteDiscovery: false, allowRemoteAnalysis: true });
    if (libraryType === "group") { await assert.rejects(h.service.askPaper(h.parent, "group"), { code: "GROUP_REMOTE_FORBIDDEN" }); assert.equal(h.calls.extracts, 0); }
    else { await h.service.askPaper(h.parent, "authorized"); assert.equal(h.calls.requests.length, 1); }
  }
});

test("exact and escaped credential echoes and credential-containing questions are never saved", async () => {
  for (const mode of ["exact", "escaped", "question"]) {
    const h = createHarness();
    await h.service.saveAIConfig({ provider: "openai", endpoint: "http://127.0.0.1:11434", model: "demo" }, { apiKey: "synthetic-secret", rememberKey: false });
    const bytes = h.files.get(h.statePath);
    mockChat(h, "openai", { answer: mode === "escaped" ? "\\u0073ynthetic-secret" : "synthetic-secret", evidence: [] });
    await assert.rejects(h.service.askPaper(h.parent, mode === "question" ? "synthetic-secret" : "question"), { code: mode === "question" ? "INVALID_QUESTION" : "INVALID_MODEL_OUTPUT" });
    assert.equal(h.files.get(h.statePath), bytes); assert.equal((await h.service.getConversation(h.parent)).messages.length, 0);
  }
});

test("manual statuses manage exactly five reserved tags, preserve user/automatic tags, repair and are idempotent", async () => {
  const h = createHarness();
  const native = tagAdapter(h, [{ tag: "已读", type: 0 }, { tag: "user-tag", type: 1 }, { tag: "阅读室/搁置", type: 0 }, { tag: "阅读室/custom", type: 0 }]);
  let state = await h.service.setState(h.parent, { status: "read", notes: "local" });
  assert.equal(state.tagSync.status, "synced"); assert.equal(state.tagSync.tag, "阅读室/已读");
  assert.deepEqual(native.tags, [{ tag: "已读", type: 0 }, { tag: "user-tag", type: 1 }, { tag: "阅读室/custom", type: 0 }, { tag: "阅读室/已读", type: 0 }]);
  assert.ok(native.loads.some(call => call.types.includes("tags")));
  await h.service.setState(h.parent, { status: "read" }); assert.equal(native.saves, 1);
  native.tags = native.tags.filter(entry => entry.tag !== "阅读室/已读"); native.stored = plain(native.tags);
  await h.service.setState(h.parent, { status: "read" }); assert.equal(native.saves, 2);
  for (const [status, tag] of [["unread", "未读"], ["to_read", "待读"], ["reading", "在读"], ["parked", "搁置"]]) {
    state = await h.service.setState(h.parent, { status }); assert.equal(state.tagSync.tag, "阅读室/" + tag);
    assert.equal(native.tags.filter(entry => /^阅读室\/(未读|待读|在读|已读|搁置)$/.test(entry.tag)).length, 1);
  }
  assert.equal(h.service.getState(h.parent).notes, "local");
});

test("only explicit manual status patches write tags; init, notes, focus, chat and analysis never mark as read", async () => {
  const h = createHarness(); const native = tagAdapter(h);
  await h.service.init(); await h.service.setState(h.parent, { notes: "notes", lastPage: 10 }); await h.service.setFocused(h.parent, true);
  await h.service.analyze(h.parent); mockChat(h); await h.service.askPaper(h.parent, "question");
  assert.equal(native.saves, 0); assert.deepEqual(native.tags, []); assert.equal(h.service.getState(h.parent).status, "unread");
  const patch = Object.create({ status: "read" }); patch.notes = "own notes";
  await h.service.setState(h.parent, patch); assert.equal(native.saves, 0);
  await assert.rejects(h.service.setState(h.parent, { status: "bogus" }), { code: "INVALID_STATUS" }); assert.equal(native.saves, 0);
});

test("editable groups can receive managed tags; readonly/dirty/missing native APIs retain explicit local state and notes", async () => {
  for (const kind of ["group", "readonly-library", "readonly-item", "dirty", "missing-api"]) {
    const h = createHarness({ libraryType: kind === "group" ? "group" : "user" });
    const native = tagAdapter(h);
    if (kind === "readonly-library") h.library.editable = false;
    if (kind === "readonly-item") h.parent.isEditable = () => false;
    if (kind === "dirty") native.dirty = true;
    if (kind === "missing-api") delete h.parent.saveTx;
    const state = await h.service.setState(h.parent, { status: "reading", notes: "preserve" });
    assert.equal(state.status, "reading"); assert.equal(state.notes, "preserve");
    assert.equal(state.tagSync.status, kind === "group" ? "synced" : "skipped"); assert.equal(native.saves, kind === "group" ? 1 : 0);
    const reloaded = new h.Service(h.Zotero); await reloaded.init(); assert.deepEqual(plain(reloaded.getState(h.parent).tagSync), plain(state.tagSync));
  }
});

test("native tag failures rollback cached tags, persist explicit error and allow retry without losing old analysis", async () => {
  const h = createHarness(); const native = tagAdapter(h, [{ tag: "user", type: 1 }, { tag: "阅读室/待读", type: 0 }]);
  await h.service.setState(h.parent, { notes: "old notes" });
  h.service._document.items["1:PAPER001"].analysis = { id: "keep-analysis" };
  native.fail = true;
  const state = await h.service.setState(h.parent, { status: "read" });
  assert.equal(state.tagSync.status, "error"); assert.equal(state.tagSync.code, "TAG_SYNC_FAILED"); assert.equal(native.reloads, 1);
  assert.deepEqual(native.tags, native.stored); assert.equal(state.notes, "old notes"); assert.equal(state.analysis.id, "keep-analysis");
  assert.equal(JSON.stringify(state.tagSync).includes("private"), false);
  native.fail = false; const retry = await h.service.setState(h.parent, { status: "read" }); assert.equal(retry.tagSync.status, "synced");
});

test("rapid manual statuses serialize both native saves and tagSync so an older result cannot win", async () => {
  const h = createHarness(); const native = tagAdapter(h);
  const gate = deferred(), started = deferred();
  h.parent.saveTx = async () => { native.saves++; if (native.saves === 1) { started.resolve(); await gate.promise; } native.stored = plain(native.tags); };
  const first = h.service.setState(h.parent, { status: "reading" }); await started.promise;
  const second = h.service.setState(h.parent, { status: "read" }); const notes = h.service.setState(h.parent, { notes: "parallel notes" });
  await tick(); assert.equal(native.saves, 1); gate.resolve(); await Promise.all([first, second, notes]);
  const state = h.service.getState(h.parent);
  assert.equal(state.status, "read"); assert.equal(state.tagSync.tag, "阅读室/已读"); assert.equal(state.tagSync.status, "synced"); assert.equal(state.notes, "parallel notes");
  assert.deepEqual(native.tags, [{ tag: "阅读室/已读", type: 0 }]);
});

test("local persistence fails before tag mutation, and a failed outcome write never falsely reports saved sync", async () => {
  const h = createHarness(); const native = tagAdapter(h); h.io.failWrite = true;
  await assert.rejects(h.service.setState(h.parent, { status: "read" }), { code: "STATE_WRITE_FAILED" }); assert.equal(native.saves, 0);
  h.io.failWrite = false;
  h.parent.saveTx = async () => { native.saves++; native.stored = plain(native.tags); h.io.failWrite = true; };
  const result = await h.service.setState(h.parent, { status: "read" });
  assert.equal(result.status, "read"); assert.equal(result.tagSync.status, "error"); assert.equal(result.tagSync.code, "TAG_SYNC_STATE_WRITE_FAILED");
  const persisted = JSON.parse(h.files.get(h.statePath)).items["1:PAPER001"];
  assert.equal(persisted.status, "read"); assert.equal(persisted.tagSync.status, "skipped"); assert.equal(persisted.tagSync.code, "TAG_SYNC_PENDING");
});
