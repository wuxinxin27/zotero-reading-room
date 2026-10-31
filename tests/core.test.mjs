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

test("extractive analysis returns six cautious dimensions, actual terms and citation candidates", () => {
  const result = Core.extractiveAnalysis(Core.documentFromFullText(paper), { attachmentKey: "ATTACH01" });
  assert.equal(result.dimensions.length, 6);
  assert.equal(result.dimensions[2].subtypes.length, 4);
  const theory = result.dimensions[2].subtypes.find(type => type.id === "theory");
  assert.equal(theory.summary, "信息不足");
  for (const dimension of result.dimensions) {
    assert.equal(dimension.confidence, "low");
    for (const entry of dimension.evidence) {
      assert.equal(entry.verified, true);
      assert.ok(paper.text.includes(entry.quote));
    }
  }
  assert.ok(result.terms.some(entry => entry.term === "calibration"));
  assert.ok(result.figureTableReferences.some(entry => entry.reference === "Table 2" && entry.pageIndex === 1));
  assert.ok(result.sectionCues.some(entry => entry.text === "2 Experiments"));
  assert.ok(result.citationCandidates.length > 0);
  assert.ok(result.citationCandidates.every(entry => entry.requiresVerification));
});

test("unrelated text yields information insufficient rather than invented scientific claims", () => {
  const doc = Core.documentFromFullText("A quiet green orchard stands beside the river. The birds sing in the morning.");
  const result = Core.extractiveAnalysis(doc, { attachmentKey: "ATTACH01" });
  assert.ok(result.dimensions.every(dimension => dimension.summary === "信息不足" && dimension.evidence.length === 0));
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
