import test from "node:test";
import assert from "node:assert/strict";
import { loadCore, paper, plain } from "./fixtures/harness.mjs";

const Core = loadCore();

test("identity separates libraries and rejects unstable or path-shaped keys", () => {
  assert.equal(Core.identity({ libraryID: 1, key: "PAPER001" }), "1:PAPER001");
  assert.notEqual(Core.identity({ libraryID: 2, key: "PAPER001" }), "1:PAPER001");
  assert.throws(() => Core.identity({ libraryID: 1, key: "../paper" }), { code: "INVALID_ITEM" });
});

test("all five statuses are distinct from jobs; patches retain notes and analysis", () => {
  let state = { ...Core.defaultState(), notes: "作者假设需复查", checklist: { theory: true }, analysis: { id: "existing" } };
  for (const status of ["unread", "to_read", "reading", "read", "parked"]) {
    state = Core.patchState(state, { status }, "2026-01-01T00:00:00Z");
    assert.equal(state.status, status);
    assert.equal(state.notes, "作者假设需复查");
    assert.equal(state.checklist.theory, true);
    assert.equal(state.analysis.id, "existing");
  }
  assert.throws(() => Core.patchState(state, { status: "analyzing" }), { code: "INVALID_STATUS" });
  assert.throws(() => Core.patchState(state, { notes: null }), { code: "INVALID_NOTES" });
  assert.throws(() => Core.patchState(state, { lastPage: -1 }), { code: "INVALID_PAGE" });
});

test("only independently checkable PDF boundaries produce page numbers", () => {
  const document = Core.documentFromFullText(paper);
  assert.equal(document.pageAware, true);
  assert.equal(document.segments[1].pageIndex, 1);
  for (const raw of [paper.text.replace("\f", "\n"), { ...paper, extractedPages: 3 }]) {
    const fallback = Core.documentFromFullText(raw);
    assert.equal(fallback.pageAware, false);
    assert.equal(fallback.segments[0].pageIndex, null);
    assert.match(fallback.limitations[0], /不标页码/);
  }
});

test("evidence must match actual text and specified page; fabricated tails never verify", () => {
  const document = Core.documentFromFullText(paper);
  const quote = "We address the problem of unreliable sensor calibration in small robots.";
  assert.equal(Core.validateEvidence({ quote, pageIndex: 0 }, document, "ATTACH01").verified, true);
  assert.equal(Core.validateEvidence({ quote, pageIndex: 1 }, document, "ATTACH01").verified, false);
  assert.equal(Core.validateEvidence({ quote: "The method doubles accuracy on all datasets.", pageIndex: 0 }, document, "ATTACH01").verified, false);
  const longDocument = Core.documentFromFullText({ text: "a".repeat(4100), extractedPages: 1, totalPages: 1 });
  assert.equal(Core.validateEvidence({ quote: "a".repeat(4000) + "fabricated" }, longDocument, "ATTACH01").verified, false);
  const noPages = Core.documentFromFullText(paper.text);
  assert.equal(Core.validateEvidence({ quote, pageIndex: 0 }, noPages, "ATTACH01").verified, false);
  assert.equal(Core.validateEvidence({ quote, pageIndex: null }, noPages, "ATTACH01").verified, true);
});

test("removed extractive classifier cannot manufacture claims from cue words", () => {
  assert.equal(Core.extractiveAnalysis, undefined);
  const doc = Core.documentFromFullText("A quiet green orchard stands beside the river. The birds sing in the morning.");
  const result = Core.validateModelOutput({ dimensions: [] }, doc, { attachmentKey: "ATTACH01" });
  assert.ok(result.every(dimension => dimension.summary === "信息不足" && dimension.evidence.length === 0));
  assert.ok(result[2].subtypes.every(value => value.summary === "信息不足"));
});

test("model contribution categories and narrative require literal source evidence", () => {
  const doc = Core.documentFromFullText(paper);
  const evidence = [{ quote: "We propose a novel calibration algorithm using a sparse graph representation.", pageIndex: 0 }];
  const dimensions = Core.validateModelOutput({ dimensions: [{ id: "contributions", summary: "算法贡献", evidence,
    subtypes: [{ id: "algorithm", summary: "稀疏校准", evidence }, { id: "theory", summary: "证明最优", evidence: [] }] }] }, doc, { attachmentKey: "ATTACH01" });
  assert.equal(dimensions[2].subtypes[1].summary, "稀疏校准");
  assert.equal(dimensions[2].subtypes[0].summary, "信息不足");
  const narrative = Core.validateModelNarrative({ overview: "有证据的自然概述", overviewEvidence: evidence,
    readingGuide: "未经证据支持的判断", figureTableReferences: [
      { reference: "Table 2", explanation: "比较条件的候选表格", quote: "Table 2 reports better accuracy under the stated noise conditions.", pageIndex: 1 },
      { reference: "Fig. 99", explanation: "伪造", quote: evidence[0].quote, pageIndex: 0 }
    ] }, doc, { attachmentKey: "ATTACH01" });
  assert.equal(narrative.overview, "有证据的自然概述");
  assert.equal(narrative.readingGuide, "");
  assert.equal(narrative.figureTableReferences.length, 1);
  assert.equal(narrative.figureTableReferences[0].kind, "table");
  assert.equal(narrative.figureTableReferences[0].verified, true);
  assert.equal(narrative.figureTableReferences[0].visualVerified, false);
  assert.equal(narrative.figureTableReferences[0].candidate, true);
});

test("endpoint validation defaults to loopback and requires explicit HTTPS remote consent", () => {
  assert.equal(Core.validateEndpoint().url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(Core.validateEndpoint("http://localhost:8080/v1").local, true);
  assert.equal(Core.validateEndpoint("http://[::1]:8080/v1").local, true);
  for (const endpoint of ["file:///tmp/model", "http://user:secret@localhost/v1", "http://localhost/v1?api_key=secret", "javascript:alert(1)"]) {
    assert.throws(() => Core.validateEndpoint(endpoint), { code: "UNSAFE_ENDPOINT" });
  }
  assert.throws(() => Core.validateEndpoint("https://example.org/v1"), { code: "REMOTE_CONSENT_REQUIRED" });
  assert.throws(() => Core.validateEndpoint("http://example.org/v1", true), { code: "REMOTE_CONSENT_REQUIRED" });
  assert.throws(() => Core.validateEndpoint("http://localhost.evil.test/v1"), { code: "REMOTE_CONSENT_REQUIRED" });
  assert.equal(Core.validateEndpoint("https://example.org/v1", true).local, false);
});

test("figure and table references match complete identifiers with supported aliases and whitespace", () => {
  const cases = [
    ["Figure 1", "Figure 10", false], ["Table 2", "Table 20", false],
    ["图1", "图10", false], ["表2", "表20", false],
    ["Figure 10", "Figure10附录A", false], ["Table 20", "Table20附录A", false],
    ["Figure 10", "Figure10A", false], ["Table 20", "Table20a", false],
    ["Figure 10", "PrefixedFigure10", false], ["Table 20", "myTable20", false],
    ["Figure 10", "Figure10", true], ["Figure 10", "Fig.\n10", true],
    ["Fig.10", "Figure 10", true], ["图 10", "图10", true],
    ["图10", "FIG. 10", true], ["Table20", "表 20", true],
    ["表20", "TABLE 20", true], ["Figure10A", "Fig.\t10a", true],
    ["Table 20", "Table   20", true]
  ];
  for (const [reference, mention, accepted] of cases) {
    const quote = mention + " presents the synthetic result.";
    const doc = Core.documentFromFullText({ text: quote, extractedPages: 1, totalPages: 1 });
    const narrative = Core.validateModelNarrative({ figureTableReferences: [
      { reference, explanation: "文字引用候选", quote, pageIndex: 0 }
    ] }, doc, { attachmentKey: "ATTACH01" });
    assert.equal(narrative.figureTableReferences.length, accepted ? 1 : 0, reference + " in " + mention);
    if (accepted) {
      assert.equal(narrative.figureTableReferences[0].verified, true);
      assert.equal(narrative.figureTableReferences[0].candidate, true);
      assert.equal(narrative.figureTableReferences[0].visualVerified, false);
    }
  }
});

test("model claims without literal evidence are suppressed and invalid evidence is visibly unverified", () => {
  const document = Core.documentFromFullText(paper);
  const validated = Core.validateModelOutput({ dimensions: [{ id: "novelty", summary: "A world-first invention!", evidence: [{ quote: "A fabricated statement", pageIndex: 0 }] }] }, document, { attachmentKey: "ATTACH01" });
  assert.equal(validated[1].summary, "信息不足");
  assert.equal(validated[1].evidence[0].verified, false);
  assert.equal(validated[0].summary, "信息不足");
  assert.throws(() => Core.validateModelOutput({ actions: ["execute"] }, document, {}), { code: "INVALID_MODEL_OUTPUT" });
});

test("chunk coverage counts actual content and respects limits", () => {
  const doc = Core.documentFromFullText({ text: "a".repeat(20) + "\f" + "b".repeat(30), extractedPages: 2, totalPages: 2 });
  const plan = Core.chunkDocument(doc, { chunkSize: 12, maxCharacters: 37 });
  assert.equal(plan.totalCharacters, 50);
  assert.equal(plan.analyzedCharacters, 37);
  assert.equal(plan.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), 37);
  assert.deepEqual(plain(plan.chunks.map(chunk => chunk.pageIndex)), [0, 0, 1, 1]);
});

test("notes render hostile model and document strings as inert text", () => {
  const hostile = '<img src=x onerror="alert(1)"><script>alert(1)</script>&';
  const html = Core.analysisNoteHTML({ mode: "model", dimensions: [{ label: hostile, summary: hostile, confidence: "low", evidence: [{ quote: hostile, verified: false }] }], limitations: [hostile] }, hostile);
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&amp;"));
});
