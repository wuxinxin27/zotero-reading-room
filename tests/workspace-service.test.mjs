import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, plain, paper } from "./fixtures/harness.mjs";

const localConfig = { provider: "openai", endpoint: "http://localhost:8123/v1", model: "synthetic" };
const remoteConfig = { ...localConfig, endpoint: "https://api.synthetic.example/v1", consentOrigin: "https://api.synthetic.example",
  consentProvider: "openai", allowRemoteDiscovery: true, allowRemoteAnalysis: true };
const secret = "synthetic-settings-key-DO-NOT-PERSIST";

test("all accessible libraries expose only regular metadata with bounded paging, search and isolated focus", async () => {
  const h = createHarness();
  h.libraries.set(2, { libraryID: 2, name: "Synthetic group", libraryType: "group", editable: false });
  h.libraries.set(3, { libraryID: 3, name: "Hidden publications", libraryType: "publications" });
  const groupPaper = { ...h.parent, id: 9, libraryID: 2, fields: { ...h.parent.fields, title: "Group-only paper" } };
  h.records.set(9, groupPaper);
  for (let index = 0; index < 205; index++) h.records.set(1000 + index, { ...h.parent, id: 1000 + index,
    key: "PAPR" + String(index).padStart(4, "0"), fields: { ...h.parent.fields, title: "Corpus " + String(index).padStart(4, "0") } });
  await h.service.setState(h.parent, { notes: "retain notes", checklist: { problem: true } });
  await h.service.setFocused(h.attachment, true);
  const libraries = await h.service.listLibraries();
  assert.deepEqual(plain(libraries.map(value => [value.id, value.type, value.editable])), [[1, "user", true], [2, "group", false]]);
  const page = await h.service.listPapers({ libraryID: 1, offset: 80, limit: 80 });
  assert.equal(page.total, 206);
  assert.equal(page.items.length, 80);
  assert.ok(page.items.every(value => value.itemType === "journalArticle" && !Object.hasOwn(value, "path")));
  assert.equal((await h.service.listPapers({ libraryID: 1, query: "corpus 0204" })).items[0].id, 1204);
  const focused = await h.service.listPapers({ libraryID: 1, focusOnly: true });
  assert.equal(focused.total, 1);
  assert.equal(focused.items[0].key, h.parent.key);
  assert.equal((await h.service.listPapers({ libraryID: 2, focusOnly: true })).total, 0);
  assert.equal((await h.service.listPapers({ libraryID: null })).total, 207);
  assert.equal((await h.service.listPapers({ focusOnly: true })).total, 1);
  await h.service.setFocused(groupPaper, true);
  assert.equal((await h.service.listPapers({ focusOnly: true })).total, 2);
  assert.equal(h.service.getState(h.parent).notes, "retain notes");
  assert.equal(h.service.getState(h.parent).checklist.problem, true);
  assert.equal(h.parent.fields.title, "A Synthetic Calibration Study");
  const reloaded = new h.Service(h.Zotero);
  await reloaded.init();
  assert.equal(reloaded.getState(h.parent).focused, true);
  await assert.rejects(h.service.listPapers({ libraryID: 3 }), { code: "LIBRARY_UNAVAILABLE" });
  await assert.rejects(h.service.listPapers({ limit: 201 }), { code: "INVALID_QUERY" });
  await assert.rejects(h.service.setFocused(h.parent, "yes"), { code: "INVALID_FOCUS" });
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
  assert.equal(h.calls.noteSaves, 0);
});

test("pre-existing schema v1 notes, checklist and legacy extractive results survive focus migration", async () => {
  const h = createHarness({ configured: false });
  const legacy = { schemaVersion: 1, status: "reading", notes: "legacy notes", checklist: { theory: true },
    analysis: { mode: "extractive", id: "rr-legacy" }, lastPage: 2 };
  h.files.set(h.statePath, JSON.stringify({ schemaVersion: 1, items: { "1:PAPER001": legacy } }));
  await h.service.init();
  assert.equal(h.service.getState(h.parent).focused, false);
  await h.service.setFocused(h.parent, true);
  assert.equal(h.service.getState(h.parent).analysis.id, "rr-legacy");
  assert.equal(h.service.getState(h.parent).notes, "legacy notes");
  assert.equal(h.service.getState(h.parent).checklist.theory, true);
  await assert.rejects(h.service.analyze(h.parent, { mode: "extractive" }), { code: "EXTRACTIVE_REMOVED" });
  await assert.rejects(h.service.analyze(h.parent), { code: "MODEL_REQUIRED" });
  assert.equal(h.calls.extracts, 0);
  assert.equal((await h.service.listPapers()).items[0].hasAnalysis, false);
});

test("saved configuration reloads without network and OS-encrypted credentials stay out of every sidecar", async () => {
  const h = createHarness({ configured: false });
  assert.equal((await h.service.getAIConfig()).configured, false);
  const saved = await h.service.saveAIConfig(localConfig, { apiKey: secret });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.rememberKey, true);
  assert.equal(saved.configured, true);
  assert.equal(Object.hasOwn(saved, "apiKey"), false);
  assert.equal(h.logins.length, 1);
  assert.ok(h.logins[0].password.startsWith("oskv1:"));
  assert.equal(h.logins[0].password.includes(secret), false);
  assert.ok([...h.files.values()].every(value => !value.includes(secret)));
  assert.ok(h.calls.writes.every(call => !call.content.includes(secret) && call.options.tmpPath && call.options.flush));
  const reloaded = new h.Service(h.Zotero);
  await reloaded.init();
  assert.equal((await reloaded.getAIConfig()).hasApiKey, true);
  assert.equal(h.calls.requests.length, 0);
  await reloaded.analyze(h.parent);
  assert.ok(h.calls.requests.every(call => call.options.headers.Authorization === "Bearer " + secret));
  assert.ok([...h.files.values()].every(value => !value.includes(secret)));
});

test("session-only keys are usable, not reloaded, and cannot silently fall back from unavailable OS protection", async () => {
  const h = createHarness({ configured: false, secureStorage: false });
  await assert.rejects(h.service.saveAIConfig(localConfig, { apiKey: secret }), { code: "SECURE_STORAGE_UNAVAILABLE" });
  assert.equal(h.calls.writes.length, 0);
  const saved = await h.service.saveAIConfig(localConfig, { apiKey: secret, rememberKey: false });
  assert.equal(saved.hasApiKey, true);
  assert.equal(saved.rememberKey, false);
  assert.equal(saved.keyStorageAvailable, false);
  await h.service.analyze(h.parent);
  assert.equal(h.calls.requests[0].options.headers.Authorization, "Bearer " + secret);
  const reloaded = new h.Service(h.Zotero);
  await reloaded.init();
  assert.equal((await reloaded.getAIConfig()).hasApiKey, false);
  assert.equal(h.logins.length, 0);
  assert.ok([...h.files.values()].every(value => !value.includes(secret)));
  await h.service.shutdown();
  assert.equal(h.service._sessionCredential, null);
});

test("anonymous local models work without credentials or a secure-store adapter", async () => {
  const h = createHarness({ configured: false, secureStorage: false });
  const saved = await h.service.saveAIConfig(localConfig);
  assert.equal(saved.hasApiKey, false);
  assert.equal(saved.rememberKey, false);
  await h.service.analyze(h.parent);
  assert.equal(Object.hasOwn(h.calls.requests[0].options.headers, "Authorization"), false);
});

test("advertised OS storage failure or plaintext output cannot reach LoginManager or sidecars", async () => {
  for (const failure of ["throw", "plaintext"]) {
    const h = createHarness({ configured: false });
    h.Zotero.OSKeyStore.encrypt = async value => { if (failure === "throw") throw new Error(secret); return value; };
    await assert.rejects(h.service.saveAIConfig(localConfig, { apiKey: secret }), error => error.code === "SECURE_STORAGE_UNAVAILABLE" && !error.message.includes(secret));
    assert.equal(h.logins.length, 0);
    assert.equal(h.calls.writes.length, 0);
    assert.equal((await h.service.getAIConfig()).configured, false);
  }
});

test("configuration write failures restore previous encrypted keys and keep the old config", async () => {
  const h = createHarness({ configured: false });
  await h.service.saveAIConfig(localConfig, { apiKey: secret });
  const original = h.files.get(h.statePath);
  const encrypted = h.logins[0].password;
  h.io.failWrite = true;
  await assert.rejects(h.service.saveAIConfig({ ...localConfig, model: "replacement" }, { apiKey: "replacement-test-key" }), { code: "STATE_WRITE_FAILED" });
  assert.equal(h.files.get(h.statePath), original);
  assert.equal(h.logins.length, 1);
  assert.equal(h.logins[0].password, encrypted);
  assert.equal((await h.service.getAIConfig()).model, "synthetic");
  h.io.failWrite = false;
  await h.service.saveAIConfig(localConfig, { clearKey: true });
  assert.equal(h.logins.length, 0);
  assert.equal((await h.service.getAIConfig()).hasApiKey, false);
});

test("old consent cannot move origins; explicit new-origin consent works on the first save without copying credentials", async () => {
  const h = createHarness({ configured: false });
  const first = await h.service.saveAIConfig(remoteConfig, { apiKey: secret });
  assert.equal(first.allowRemoteAnalysis, true);
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    return { status: 200, response: { data: [{ id: "synthetic" }] } };
  };
  await h.service.listConfiguredModels();
  assert.equal(h.calls.requests[0].options.headers.Authorization, "Bearer " + secret);
  const changed = { ...remoteConfig, endpoint: "https://other.synthetic.example/v1", consentOrigin: "https://other.synthetic.example" };
  const revoked = await h.service.saveAIConfig({ ...changed, consentOrigin: remoteConfig.consentOrigin });
  assert.equal(revoked.allowRemoteDiscovery, false);
  assert.equal(revoked.allowRemoteAnalysis, false);
  assert.equal(revoked.consentOrigin, null);
  assert.equal(revoked.consentProvider, null);
  assert.equal(revoked.hasApiKey, false);
  assert.equal(h.logins.length, 1);
  await assert.rejects(h.service.listConfiguredModels(), { code: "REMOTE_CONSENT_REQUIRED" });
  assert.equal(h.calls.requests.length, 1);
  const renewed = await h.service.saveAIConfig(changed);
  assert.equal(renewed.allowRemoteAnalysis, true);
  const providerChanged = await h.service.saveAIConfig({ ...changed, provider: "anthropic", consentOrigin: null });
  assert.equal(providerChanged.allowRemoteAnalysis, false);
  assert.equal(providerChanged.allowRemoteDiscovery, false);
  const providerRenewed = await h.service.saveAIConfig({ ...changed, provider: "anthropic", consentProvider: "anthropic" });
  assert.equal(providerRenewed.allowRemoteAnalysis, true);
  assert.equal(providerRenewed.consentProvider, "anthropic");
  assert.equal(providerRenewed.hasApiKey, false);
  const backToOriginal = await h.service.saveAIConfig(remoteConfig, { apiKey: "" });
  assert.equal(backToOriginal.hasApiKey, true);
  assert.equal(h.logins.length, 1);
  assert.equal(h.logins[0].httpRealm.includes(remoteConfig.endpoint), true);
});

test("a newly selected remote host accepts freshly bound explicit consent in one save", async () => {
  const h = createHarness();
  const saved = await h.service.saveAIConfig(remoteConfig, { apiKey: secret });
  assert.equal(saved.allowRemoteDiscovery, true);
  assert.equal(saved.allowRemoteAnalysis, true);
  assert.equal(saved.consentOrigin, remoteConfig.consentOrigin);
  assert.equal(saved.consentProvider, remoteConfig.provider);
  const sameTarget = await h.service.saveAIConfig({ ...remoteConfig, model: "second-model" }, { apiKey: "" });
  assert.equal(sameTarget.hasApiKey, true);
  assert.equal(h.logins.length, 1);
});

test("cloning consent cannot authorize a different provider, while explicit new-provider consent works on its first save", async () => {
  for (const explicit of [false, true]) {
    const h = createHarness({ configured: false });
    const first = await h.service.saveAIConfig(remoteConfig, { apiKey: secret });
    const changed = { ...first, provider: "anthropic" };
    if (explicit) changed.consentProvider = "anthropic";
    const saved = await h.service.saveAIConfig(changed, { apiKey: "" });
    assert.equal(saved.allowRemoteDiscovery, explicit);
    assert.equal(saved.allowRemoteAnalysis, explicit);
    assert.equal(saved.consentProvider, explicit ? "anthropic" : null);
    assert.equal(saved.consentOrigin, explicit ? remoteConfig.consentOrigin : null);
    assert.equal(saved.hasApiKey, false);
    assert.equal(h.logins.length, 1);
    h.Zotero.HTTP.request = async (method, url, options) => {
      h.calls.requests.push({ method, url, options });
      return { status: 200, response: { data: [{ id: "synthetic" }] } };
    };
    if (explicit) {
      await h.service.listConfiguredModels();
      assert.equal(h.calls.requests.length, 1);
      assert.equal(h.calls.requests[0].options.headers["anthropic-version"], "2023-06-01");
      assert.equal(Object.hasOwn(h.calls.requests[0].options.headers, "x-api-key"), false);
    }
    else {
      await assert.rejects(h.service.listConfiguredModels(), { code: "REMOTE_CONSENT_REQUIRED" });
      assert.equal(h.calls.requests.length, 0);
    }
  }
});

test("legacy or mismatched persisted consent is exposed and used as unapproved", async () => {
  for (const consentProvider of [undefined, "anthropic"]) {
    const h = createHarness({ configured: false });
    const aiConfig = { ...remoteConfig };
    if (consentProvider === undefined) delete aiConfig.consentProvider;
    else aiConfig.consentProvider = consentProvider;
    h.files.set(h.statePath, JSON.stringify({ schemaVersion: 1, items: {}, aiConfig }));
    const loaded = await h.service.getAIConfig();
    assert.equal(loaded.allowRemoteDiscovery, false);
    assert.equal(loaded.allowRemoteAnalysis, false);
    assert.equal(loaded.consentOrigin, null);
    assert.equal(loaded.consentProvider, null);
    await assert.rejects(h.service.listConfiguredModels(), { code: "REMOTE_CONSENT_REQUIRED" });
    assert.equal(h.calls.requests.length, 0);
  }
});

test("saved group-library remote analysis remains forbidden before extraction", async () => {
  const h = createHarness({ configured: false, libraryType: "group" });
  await h.service.saveAIConfig(remoteConfig, { rememberKey: false });
  await assert.rejects(h.service.analyze(h.parent), { code: "GROUP_REMOTE_FORBIDDEN" });
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
});

test("AI caches reload and reuse with no configuration, credentials, PDF extraction or HTTP", async () => {
  const h = createHarness();
  const result = await h.service.analyze(h.parent);
  const writes = h.calls.writes.length;
  const requests = h.calls.requests.length;
  const extracts = h.calls.extracts;
  const fileChecks = h.calls.fileChecks;
  const data = JSON.parse(h.files.get(h.statePath));
  delete data.aiConfig;
  h.files.set(h.statePath, JSON.stringify(data));
  h.Zotero.PDFWorker.getFullText = () => { throw new Error("cache must not extract"); };
  h.Zotero.HTTP.request = () => { throw new Error("cache must not call HTTP"); };
  const reloaded = new h.Service(h.Zotero);
  await reloaded.init();
  const cached = await reloaded.analyze(h.parent);
  assert.equal(cached.id, result.id);
  assert.equal(h.calls.writes.length, writes);
  assert.equal(h.calls.requests.length, requests);
  assert.equal(h.calls.extracts, extracts);
  assert.equal(h.calls.fileChecks, fileChecks);
  assert.equal((await reloaded.listPapers()).items[0].hasAnalysis, true);
  await assert.rejects(reloaded.analyze(h.parent, { force: true }), { code: "MODEL_REQUIRED" });
  assert.equal(reloaded.getState(h.parent).analysis.id, result.id);
});

test("attachment-specific caches preserve previous PDFs and force failures cannot replace either result", async () => {
  const h = createHarness();
  const second = { ...h.attachment, id: 3, key: "ATTACH02", localPath: "/synthetic/library/second.pdf" };
  h.records.set(3, second);
  h.files.set(second.localPath, "synthetic");
  const first = await h.service.analyze(h.parent, { attachmentID: 2 });
  const other = await h.service.analyze(h.parent, { attachmentID: 3 });
  assert.notEqual(other.id, first.id);
  const before = h.calls.requests.length;
  assert.equal((await h.service.analyze(h.parent, { attachmentID: 2 })).id, first.id);
  assert.equal(h.calls.requests.length, before);
  h.Zotero.HTTP.request = async () => { throw new Error("synthetic failure"); };
  await assert.rejects(h.service.analyze(h.parent, { attachmentID: 2, force: true }), { code: "MODEL_REQUEST_FAILED" });
  assert.equal((await h.service.analyze(h.parent, { attachmentID: 2 })).id, first.id);
  assert.equal((await h.service.analyze(h.parent, { attachmentID: 3 })).id, other.id);
});

test("reader attachment paths are restricted to matching local PDF children and never enter analysis", async () => {
  const h = createHarness();
  const selected = await h.service.getReaderAttachment(h.attachment, { attachmentKey: "ATTACH01" });
  assert.equal(selected.path, h.attachment.localPath);
  assert.equal(selected.id, 2);
  assert.equal(selected.available, true);
  await assert.rejects(h.service.getReaderAttachment(h.parent, { attachmentID: 99 }), { code: "ATTACHMENT_NOT_FOUND" });
  await assert.rejects(h.service.getReaderAttachment(h.parent, { attachmentID: 2, attachmentKey: "OTHER001" }), { code: "ATTACHMENT_NOT_FOUND" });
  const result = await h.service.analyze(h.parent);
  assert.equal(JSON.stringify(result).includes(h.attachment.localPath), false);
  assert.ok(h.calls.requests.every(call => !call.options.body.includes(h.attachment.localPath)));
  h.files.delete(h.attachment.localPath);
  const missing = await h.service.getReaderAttachment(h.parent);
  assert.equal(missing.available, false);
  assert.equal(missing.path, null);
});

test("bounded final synthesis uses verified excerpts, writes natural narrative and preserves real figure references", async () => {
  const h = createHarness();
  let stages = [];
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    const chunk = JSON.parse(JSON.parse(options.body).messages[1].content);
    stages.push(chunk.stage);
    const quote = chunk.stage === "synthesis" ? chunk.excerpts[0] : { quote: chunk.text.split("\n").find(line => /Figure 1|Table 2/.test(line)), pageIndex: chunk.pageIndex };
    if (chunk.stage === "synthesis") {
      assert.ok(JSON.stringify(chunk).length < 48000);
      assert.ok(chunk.excerpts.every(entry => paper.text.includes(entry.quote)));
      assert.equal(Object.hasOwn(chunk, "text"), false);
    }
    const evidence = [{ quote: quote.quote, pageIndex: quote.pageIndex }];
    const response = { dimensions: [{ id: "problem", summary: chunk.stage === "synthesis" ? "从动机到技术的连贯学术解释。" : "逐段发现", evidence }],
      overview: "论文围绕校准问题展开，并需要结合实验条件理解其结论。", overviewEvidence: evidence,
      readingGuide: "结合原文的图表引用，先理解表示方法，再核对比较条件。", readingGuideEvidence: evidence,
      figureTableReferences: chunk.stage === "synthesis" ? [] : [{ reference: chunk.pageIndex === 0 ? "Figure 1" : "Table 2",
        kind: chunk.pageIndex === 0 ? "figure" : "table", explanation: "与方法或比较条件相关的图表文字候选。", ...evidence[0] }] };
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify(response) } }] } };
  };
  const result = await h.service.analyze(h.parent);
  assert.deepEqual(stages, ["reading", "reading", "synthesis"]);
  assert.equal(result.dimensions[0].summary, "从动机到技术的连贯学术解释。");
  assert.ok(result.overview && result.readingGuide);
  assert.equal(result.coverage.synthesized, true);
  assert.deepEqual(plain(result.figureTableReferences.map(entry => entry.reference)), ["Figure 1", "Table 2"]);
  assert.ok(result.figureTableReferences.every(entry => entry.verified && entry.candidate && !entry.visualVerified));
  assert.ok(result.limitations.some(value => value.includes("未视觉解析")));
});

test("text without figures never gains model-invented references, unsupported overview or cue-based contributions", async () => {
  const text = "The algorithm is presented as a preliminary proposal. Further studies are needed to establish its reliability.";
  const h = createHarness({ extracted: { text, extractedPages: 1, totalPages: 1 } });
  h.Zotero.HTTP.request = async () => ({ status: 200, response: { choices: [{ message: { content: JSON.stringify({
    dimensions: [], overview: "伪造优势", overviewEvidence: [{ quote: "outperforms all baselines", pageIndex: 0 }],
    figureTableReferences: [{ reference: "Figure 1", explanation: "伪造图像", quote: text, pageIndex: 0 }]
  }) } }] } });
  const result = await h.service.analyze(h.parent);
  assert.equal(result.figureTableReferences.length, 0);
  assert.equal(result.overview, "");
  assert.ok(result.dimensions[2].subtypes.every(value => value.summary === "信息不足"));
});

test("figure and table number prefixes never become verified persisted or rendered references", async () => {
  const text = "Figure 10 summarizes the synthetic comparison. Table 20 lists the synthetic measurements.";
  const h = createHarness({ extracted: { text, extractedPages: 1, totalPages: 1 } });
  h.Zotero.HTTP.request = async () => ({ status: 200, response: { choices: [{ message: { content: JSON.stringify({
    dimensions: [], figureTableReferences: [
      { reference: "Figure 1", explanation: "fabricated figure-one", quote: text, pageIndex: 0 },
      { reference: "Table 2", explanation: "fabricated table-two", quote: text, pageIndex: 0 },
      { reference: "Figure 10", explanation: "real figure-ten candidate", quote: text, pageIndex: 0 },
      { reference: "Table 20", explanation: "real table-twenty candidate", quote: text, pageIndex: 0 }
    ]
  }) } }] } });
  const result = await h.service.analyze(h.parent);
  assert.deepEqual(plain(result.figureTableReferences.map(entry => entry.reference)), ["Figure 10", "Table 20"]);
  assert.ok(result.figureTableReferences.every(entry => entry.verified && entry.candidate && !entry.visualVerified));
  const persisted = JSON.parse(h.files.get(h.statePath)).items["1:PAPER001"].analysis;
  assert.deepEqual(persisted.figureTableReferences.map(entry => entry.reference), ["Figure 10", "Table 20"]);
  const saved = await h.service.saveAnalysisNote(h.parent);
  const html = h.records.get(saved.id).getNote();
  assert.equal(html.includes("<p>Figure 1</p>"), false);
  assert.equal(html.includes("<p>Table 2</p>"), false);
  assert.equal(html.includes("fabricated figure-one"), false);
  assert.equal(html.includes("fabricated table-two"), false);
  assert.ok(html.includes("<p>Figure 10</p>") && html.includes("<p>Table 20</p>"));
});

test("nested escaped credentials are rejected in narrative, figure explanations and synthesis without losing saved results", async () => {
  const h = createHarness();
  const saved = await h.service.analyze(h.parent);
  const writes = h.calls.writes.length;
  for (const field of ["overview", "readingGuide", "figureTableReferences"]) {
    h.Zotero.HTTP.request = async () => ({ status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [],
      [field]: field === "figureTableReferences" ? [{ explanation: "\\u0073" + secret.slice(1) }] : "\\u0073" + secret.slice(1) }) } }] } });
    await assert.rejects(h.service.analyze(h.parent, { force: true, model: "demo", apiKey: secret }), { code: "INVALID_MODEL_OUTPUT" });
    assert.equal(h.service.getState(h.parent).analysis.id, saved.id);
    assert.equal(h.calls.writes.length, writes);
  }
});

test("final synthesis cannot smuggle real but unsubmitted quotes or escaped credentials into a saved analysis", async () => {
  const h = createHarness();
  const saved = await h.service.analyze(h.parent);
  const writes = h.calls.writes.length;
  for (const echoCredential of [false, true]) {
    h.Zotero.HTTP.request = async (_method, _url, options) => {
      const chunk = JSON.parse(JSON.parse(options.body).messages[1].content);
      const evidence = chunk.stage === "synthesis"
        ? [{ quote: "The main limitation is reduced accuracy when no calibration targets are visible.", pageIndex: 1 }]
        : [{ quote: chunk.text.slice(0, 50), pageIndex: chunk.pageIndex }];
      const response = { dimensions: [{ id: "problem", summary: chunk.stage === "synthesis" && echoCredential ? "\\u0073" + secret.slice(1) : "candidate", evidence }] };
      return { status: 200, response: { choices: [{ message: { content: JSON.stringify(response) } }] } };
    };
    if (echoCredential) {
      await assert.rejects(h.service.analyze(h.parent, { force: true, model: "demo", apiKey: secret }), { code: "INVALID_MODEL_OUTPUT" });
      assert.equal(h.calls.writes.length, writes + 1);
    }
    else {
      const result = await h.service.analyze(h.parent, { force: true });
      assert.equal(result.dimensions[0].summary, "信息不足");
      assert.equal(result.dimensions[0].evidence.length, 0);
      assert.notEqual(result.id, saved.id);
    }
  }
});

test("long papers cap reading uploads and final synthesis size while reporting incomplete coverage", async () => {
  const pages = Array.from({ length: 20 }, (_, index) => "Page " + index + " " + 'A"\\'.repeat(1800));
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 20, totalPages: 20 } });
  let reading = 0;
  let finalSize = 0;
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    const input = JSON.parse(JSON.parse(options.body).messages[1].content);
    const evidence = input.stage === "synthesis" ? [input.excerpts[0]] : [{ quote: input.text.slice(0, 3900), pageIndex: input.pageIndex }];
    if (input.stage === "synthesis") finalSize = JSON.stringify(input).length;
    else reading++;
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [{ id: "problem", summary: "bounded", evidence }] }) } }] } };
  };
  const result = await h.service.analyze(h.parent);
  assert.equal(reading, 12);
  assert.ok(finalSize > 0 && finalSize <= 48000);
  assert.equal(result.coverage.completeDocument, false);
  assert.equal(result.coverage.chunksAvailable, 20);
  assert.ok(result.coverage.ratio < 1);
  assert.ok(result.limitations.some(value => value.includes("仅分析了部分原文")));
});
