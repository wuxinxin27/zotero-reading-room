import test from "node:test";
import assert from "node:assert/strict";
import { loadCore, plain } from "./fixtures/harness.mjs";

const Core = loadCore();
const excerptsOf = plan => plan.packets.flatMap(packet => packet.excerpts);
const pageDocument = pages => Core.documentFromFullText({ text: pages.join("\f"), extractedPages: pages.length, totalPages: pages.length });
const page = (heading, marker, length = 3800) => (heading + "\n" + marker + "\n").padEnd(length, "x");

function verifyPlan(plan, document, { maxCharacters = 120000, packetCharacters = 16000, maxPackets = 12 } = {}) {
  const excerpts = excerptsOf(plan);
  const total = document.segments.reduce((sum, segment) => sum + segment.text.length, 0);
  assert.equal(plan.totalCharacters, total);
  assert.equal(plan.analyzedCharacters, Math.min(total, maxCharacters, packetCharacters * maxPackets));
  assert.equal(plan.omittedCharacters, total - plan.analyzedCharacters);
  assert.equal(plan.completeSelection, total === plan.analyzedCharacters);
  assert.equal(plan.analyzedCharacters, excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0));
  assert.ok(plan.packets.length <= maxPackets);
  const ends = new Map();
  const selectedByHint = new Map();
  const ids = new Set();
  for (const packet of plan.packets) {
    assert.ok(packet.excerpts.length > 0);
    assert.ok(packet.excerpts.reduce((sum, excerpt) => sum + excerpt.text.length, 0) <= packetCharacters);
    for (const excerpt of packet.excerpts) {
      const segment = document.segments[excerpt.segmentIndex];
      assert.ok(Number.isInteger(excerpt.start) && Number.isInteger(excerpt.end));
      assert.ok(excerpt.start >= 0 && excerpt.end > excerpt.start && excerpt.end <= segment.text.length);
      assert.equal(excerpt.text, segment.text.slice(excerpt.start, excerpt.end));
      assert.equal(excerpt.pageIndex, segment.pageIndex);
      assert.equal(excerpt.id, "s" + excerpt.segmentIndex + ":" + excerpt.start);
      assert.ok(!ids.has(excerpt.id), "excerpt IDs are unique");
      ids.add(excerpt.id);
      const previousEnd = ends.get(excerpt.segmentIndex) || 0;
      assert.ok(excerpt.start >= previousEnd, "source intervals never overlap");
      if (plan.completeSelection) assert.equal(excerpt.start, previousEnd, "complete selection has no gaps");
      ends.set(excerpt.segmentIndex, excerpt.end);
      selectedByHint.set(excerpt.sectionHint, (selectedByHint.get(excerpt.sectionHint) || 0) + excerpt.text.length);
    }
  }
  if (plan.completeSelection) {
    document.segments.forEach((segment, index) => assert.equal(ends.get(index) || 0, segment.text.length));
  }
  assert.equal(plan.sections.reduce((sum, section) => sum + section.totalCharacters, 0), total);
  assert.equal(plan.sections.reduce((sum, section) => sum + section.selectedCharacters, 0), plan.analyzedCharacters);
  for (const section of plan.sections) {
    assert.equal(section.selectedCharacters, selectedByHint.get(section.hint) || 0);
    assert.ok(section.selectedCharacters >= 0 && section.selectedCharacters <= section.totalCharacters);
  }
}

test("packs all 20 pages / 76000 source characters, including late experiments and final limitations", () => {
  const pages = Array.from({ length: 20 }, (_, index) => page(index === 16 ? "5 Experiments" : index === 19 ? "6 Limitations" : "", "synthetic page " + index));
  pages[16] = page("5 Experiments", "LATE_EXPERIMENT: the benchmark reports a measured latency under its stated conditions.");
  pages[19] = page("6 Limitations", "FINAL_LIMITATION: the evaluation omits larger deployments.");
  const document = pageDocument(pages);
  const plan = Core.planAnalysis(document);
  verifyPlan(plan, document);
  assert.equal(plan.totalCharacters, 76000);
  assert.equal(plan.packets.length, 5);
  assert.equal(plan.selectionStrategy, "complete-source");
  assert.ok(excerptsOf(plan).some(excerpt => excerpt.pageIndex === 16 && excerpt.text.includes("LATE_EXPERIMENT")));
  assert.ok(excerptsOf(plan).some(excerpt => excerpt.pageIndex === 19 && excerpt.text.includes("FINAL_LIMITATION")));
  assert.ok(plan.packets.some(packet => new Set(packet.excerpts.map(excerpt => excerpt.pageIndex)).size > 1));
});

test("samples beyond 120000 characters across source positions and retains appendices after references", () => {
  const headings = new Map([[0, "Abstract"], [1, "1 Introduction"], [2, "2 Methods"], [3, "3 Related Work"],
    [29, "4 Methods"], [34, "5 Experiments"], [37, "6 Evaluation"], [39, "7 Results"],
    [40, "8 Limitations"], [41, "9 Conclusion"], [42, "References"], [46, "Appendix A Additional Experiments"]]);
  const pages = Array.from({ length: 48 }, (_, index) => page(headings.get(index) || "", "synthetic section page " + index, 6000));
  const document = pageDocument(pages);
  const plan = Core.planAnalysis(document);
  verifyPlan(plan, document);
  const excerpts = excerptsOf(plan);
  assert.equal(plan.analyzedCharacters, 120000);
  assert.equal(plan.completeSelection, false);
  assert.match(plan.selectionStrategy, /heuristic/);
  assert.ok(excerpts.some(excerpt => excerpt.pageIndex === 0 && excerpt.start === 0));
  assert.ok(excerpts.some(excerpt => excerpt.pageIndex === 47 && excerpt.end === pages[47].length));
  for (let quarter = 0; quarter < 4; quarter++) {
    assert.ok(excerpts.some(excerpt => Math.floor(excerpt.pageIndex / 12) === quarter), "selected source in quarter " + quarter);
  }
  for (const hint of ["methods", "experiments", "evaluation", "results", "limitations", "conclusion", "references", "appendix"]) {
    assert.ok(excerpts.some(excerpt => excerpt.sectionHint === hint), "selected source for " + hint);
  }
  assert.ok(excerpts.some(excerpt => excerpt.sectionHint === "methods" && excerpt.pageIndex >= 29));
  assert.ok(excerpts.some(excerpt => excerpt.sectionHint === "appendix" && excerpt.pageIndex >= 46));
});

test("a huge single page has contiguous exact windows when complete and distributed windows when sampled", () => {
  for (const length of [99001, 350003]) {
    const document = pageDocument(["BEGIN" + "a".repeat(length - 8) + "END"]);
    const plan = Core.planAnalysis(document);
    verifyPlan(plan, document);
    const excerpts = excerptsOf(plan);
    assert.ok(excerpts.every(excerpt => excerpt.pageIndex === 0));
    assert.ok(excerpts.every(excerpt => excerpt.text.length <= 4000));
    assert.equal(excerpts[0].start, 0);
    assert.equal(excerpts.at(-1).end, length);
    if (length > 120000) assert.ok(excerpts.some(excerpt => excerpt.start > length * 0.4 && excerpt.start < length * 0.6));
  }
});

test("unknown page boundaries stay null and original whitespace and segment offsets remain exact", () => {
  const document = {
    pageAware: false,
    text: "untrusted combined text",
    segments: [{ pageIndex: null, text: " \r\nαβ  \n" }, { pageIndex: null, text: "" },
      { pageIndex: null, text: "3. Methods\r\n\t工程 implementation 🧪\n" },
      { pageIndex: null, text: "References\nsynthetic reference\nAppendix B\nadditional measurement\n" }]
  };
  const plan = Core.planAnalysis(document, { packetCharacters: 17, maxPackets: 20 });
  verifyPlan(plan, document, { packetCharacters: 17, maxPackets: 20 });
  assert.ok(excerptsOf(plan).every(excerpt => excerpt.pageIndex === null));
  assert.ok(excerptsOf(plan).some(excerpt => excerpt.segmentIndex === 3 && excerpt.sectionHint === "appendix"));
  assert.ok(plan.sections.some(section => section.hint === "unknown"));
  assert.ok(!excerptsOf(plan).some(excerpt => excerpt.text.includes("untrusted combined text")));
});

test("separate page excerpts never manufacture a cross-page quotation", () => {
  const document = pageDocument(["Alpha source ends here.", "Beta source starts here."]);
  const plan = Core.planAnalysis(document);
  const excerpts = excerptsOf(plan);
  assert.equal(plan.packets.length, 1);
  assert.equal(excerpts.length, 2);
  for (const excerpt of excerpts) {
    const validated = Core.validateEvidence({ quote: "ends here. Beta source", pageIndex: null },
      { text: excerpt.text, segments: [excerpt], pageAware: true }, "SYNTHETIC");
    assert.equal(validated.verified, false);
  }
});

test("English and Chinese numbered headings are heuristic hints and ordinary prose remains unknown", () => {
  const headings = ["Abstract", "1. Introduction", "II. Methods", "3 Experimental Setup", "4 Evaluation", "5 Results",
    "6 Limitations", "7 Conclusion", "References", "Appendix A", "摘要", "第三章方法", "四、实验", "评估", "结果", "局限性", "结论", "参考文献", "附录"];
  const pages = ["Methods improve the measurement, according to this synthetic prose.\n", ...headings.map(heading => heading + "\nsynthetic body.\n")];
  const document = pageDocument(pages);
  const plan = Core.planAnalysis(document);
  verifyPlan(plan, document);
  assert.equal(excerptsOf(plan)[0].sectionHint, "unknown");
  for (const hint of ["unknown", "abstract", "introduction", "methods", "experiments", "evaluation", "results", "limitations", "conclusion", "references", "appendix"]) {
    assert.ok(plan.sections.some(section => section.hint === hint && section.totalCharacters > 0), hint);
  }
  assert.equal(Core.extractiveAnalysis, undefined);
  assert.ok(!Object.hasOwn(plan, "dimensions"));
});

test("small budgets preserve both ends and obey packet capacity, even for a single short source region", () => {
  const document = pageDocument(["A" + "x".repeat(998) + "Z"]);
  for (const options of [
    { maxCharacters: 60, packetCharacters: 20, maxPackets: 3 },
    { maxCharacters: 999, packetCharacters: 11, maxPackets: 2 },
    { maxCharacters: 2, packetCharacters: 1, maxPackets: 2 },
    { maxCharacters: 1, packetCharacters: 1, maxPackets: 1 }
  ]) {
    const plan = Core.planAnalysis(document, options);
    verifyPlan(plan, document, options);
    assert.equal(excerptsOf(plan)[0].start, 0);
    if (plan.analyzedCharacters >= 2) assert.equal(excerptsOf(plan).at(-1).end, 1000);
  }
});

test("many tiny pages fill bounded packets without losing source characters to page count", () => {
  const document = pageDocument(Array.from({ length: 100 }, (_, index) => String(index).padEnd(13, "q")));
  for (const options of [
    { maxCharacters: 1300, packetCharacters: 110, maxPackets: 12 },
    { maxCharacters: 1000, packetCharacters: 31, maxPackets: 3 }
  ]) {
    const plan = Core.planAnalysis(document, options);
    verifyPlan(plan, document, options);
    assert.equal(plan.packets.length, options.maxPackets);
  }
});

test("zero capacities, empty source, and invalid numeric options yield finite totals without empty packets", () => {
  const document = pageDocument(["synthetic source with enough text"]);
  for (const options of [{ maxCharacters: 0 }, { packetCharacters: 0 }, { maxPackets: 0 }, { maxCharacters: -1 }]) {
    const plan = Core.planAnalysis(document, options);
    assert.equal(plan.analyzedCharacters, 0);
    assert.equal(plan.omittedCharacters, document.text.length);
    assert.equal(plan.packets.length, 0);
    assert.equal(plan.completeSelection, false);
    assert.equal(plan.sections[0].selectedCharacters, 0);
  }
  for (const options of [null, { maxCharacters: NaN, packetCharacters: Infinity, maxPackets: "12" }, { maxPackets: 0.9 }]) {
    const plan = Core.planAnalysis(document, options);
    assert.ok(Number.isFinite(plan.analyzedCharacters) && Number.isFinite(plan.omittedCharacters));
    assert.ok(plan.packets.every(packet => packet.excerpts.length > 0));
  }
  const empty = Core.planAnalysis(Core.documentFromFullText(""));
  assert.equal(empty.totalCharacters, 0);
  assert.equal(empty.analyzedCharacters, 0);
  assert.equal(empty.completeSelection, true);
  assert.equal(empty.packets.length, 0);
  assert.equal(empty.sections.length, 0);
});

test("selection is deterministic, leaves its inputs untouched, and IDs use only original segment and start", () => {
  const document = pageDocument([page("Methods", "synthetic algorithm", 9000), page("Experiments", "synthetic benchmark", 9000)]);
  document.privatePath = "C:\\synthetic-private\\source.pdf";
  document.itemKey = "PRIVATEKEY";
  const before = plain(document);
  const options = Object.freeze({ maxCharacters: 7001, packetCharacters: 2000, maxPackets: 4 });
  const first = Core.planAnalysis(document, options);
  verifyPlan(first, document, options);
  assert.deepEqual(plain(Core.planAnalysis(document, options)), plain(first));
  assert.deepEqual(plain(document), before);
  const moved = { ...document, privatePath: "D:\\other\\source.pdf", itemKey: "DIFFERENT" };
  assert.deepEqual(plain(Core.planAnalysis(moved, options)), plain(first));
  assert.ok(!JSON.stringify(first).includes("PRIVATEKEY"));
  assert.ok(!JSON.stringify(first).includes("synthetic-private"));
});
