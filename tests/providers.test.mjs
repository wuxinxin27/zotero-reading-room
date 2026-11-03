import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskInput, createHarness, loadCore, plain, paper } from "./fixtures/harness.mjs";

const firstSource = input => input.excerpts[0];
const multiPacketPaper = { ...paper, text: paper.text.split("\f").map(page => page.padEnd(9000, " ")).join("\f") };

const Core = loadCore();
const providers = ["openai", "anthropic", "gemini", "ollama"];
const secret = "synthetic-memory-only-credential";
const endpointFor = provider => "http://localhost:8123/proxy" + ({ openai: "/v1/chat/completions", anthropic: "/v1/messages", gemini: "/v1beta/models/old:generateContent", ollama: "/api/chat" })[provider];
const listReply = provider => provider === "gemini"
  ? { models: [{ name: "models/demo", displayName: "Demo model", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }
  : provider === "ollama" ? { models: [{ model: "demo", name: "Demo model" }] }
    : { data: [{ id: "demo", display_name: "Demo model" }] };

const outputWrappers = [
  ["BOM", text => "\uFEFF \n" + text + "\n"],
  ["complete fence", text => "```json\n" + text + "\n```"],
  ["leading thinking and fence", text => "<think>Private reasoning { incomplete lure, never source evidence.</think>\n```json\n" + text + "\n```"],
  ["fenced thinking", text => "```\n<think>Private reasoning.</think>\n" + text + "\n```"],
  ["single double encoding", text => JSON.stringify(text)],
  ["one object surrounded by prose", text => '说明 "quoted {decoy}"：\n' + text + "\n以上为返回结果。"],
  ["complete unlabelled fence", text => "```\n" + text + "\n```"],
  ["fence with leading prose", text => '说明 "quoted {decoy}"：\n```json\n' + text + "\n```"],
  ["fence with trailing prose", text => "```json\n" + text + "\n```\n以上为返回结果。"],
  ["unlabelled fence surrounded by prose", text => "返回结果：\n```\n" + text + "\n```\n以上为返回结果。"],
  ["single encoding inside fence", text => "```json\n" + JSON.stringify(text) + "\n```"],
  ["single encoding around fence", text => JSON.stringify("```json\n" + text + "\n```")]
];
const prose = '候选解释含括号 {literal}、数组 [literal] 和引号 "quoted"；代码 `inline` 与 ```json\n{"literal":true}\n``` 仍需核对。';
function modelReply(provider, content) {
  if (provider === "anthropic") return { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "hidden reasoning" }, { type: "text", text: content }] };
  if (provider === "gemini") return { candidates: [{ finishReason: "STOP", content: { parts: [{ thought: true, text: "hidden reasoning" }, { text: content }] } }] };
  if (provider === "ollama") return { done: true, done_reason: "stop", message: { content } };
  return { choices: [{ finish_reason: "stop", message: { reasoning_content: "hidden reasoning", content } }] };
}
function submittedChunk(options, provider) {
  const payload = JSON.parse(options.body);
  return parseTaskInput(provider === "gemini" ? payload.contents[0].parts[0].text : payload.messages.find(entry => entry.role === "user").content);
}
function outputFor(task, chunk) {
  const excerpt = firstSource(chunk);
  const evidence = excerpt ? [{ quote: (excerpt.text || excerpt.quote).slice(0, 80), pageIndex: excerpt.pageIndex }] : [];
  return task === "chat" ? { answer: prose, evidence } : {
    dimensions: ["problem", "novelty", "contributions", "prior-work", "superiority", "technical-uniqueness"]
      .map(id => ({ id, summary: prose, evidence: id === "problem" ? evidence : [] })),
    overview: prose, overviewEvidence: evidence, readingGuide: "", readingGuideEvidence: [], figureTableReferences: []
  };
}
async function configureProvider(h, provider, apiKey) {
  await h.service.saveAIConfig({ provider, endpoint: endpointFor(provider), model: "demo" }, { apiKey, rememberKey: false });
}
const invokeTask = (h, task) => task === "chat" ? h.service.askPaper(h.parent, "论文的方法是什么？") : h.service.analyze(h.parent, { force: true });

for (const provider of providers) {
  test(`${provider}: a single format regeneration retains frozen source and task for reading, synthesis and chat`, async () => {
    for (const stage of ["reading", "synthesis", "chat"]) {
      const h = createHarness({ extracted: stage === "synthesis" ? multiPacketPaper : paper });
      await configureProvider(h, provider, secret);
      const prompts = await h.service.getPromptConfig();
      const task = stage === "chat" ? "chat" : "analysis";
      const sends = [];
      const progress = [];
      let failed = false;
      fakeHTTP(h, async ({ options }) => {
        const payload = JSON.parse(options.body);
        const user = provider === "gemini" ? payload.contents[0].parts[0].text
          : payload.messages.find(entry => entry.role === "user").content;
        const input = submittedChunk(options, provider);
        const currentStage = task === "chat" ? "chat" : input.stage;
        sends.push({ user, input, stage: currentStage });
        if (!failed && currentStage === stage) {
          failed = true;
          // A configuration edit between sends must not alter this task's prompt.
          await h.service.savePromptConfig({ ...prompts, systemPrompt: "changed after the original request" });
          return modelReply(provider, "private-malformed-output { unfinished");
        }
        return modelReply(provider, JSON.stringify(outputFor(task, input)));
      });
      const options = { onProgress: entry => progress.push(entry.detail) };
      const result = task === "chat" ? await h.service.askPaper(h.parent, "论文的方法是什么？", options)
        : await h.service.analyze(h.parent, { force: true, ...options });
      const matching = sends.filter(entry => entry.stage === stage);
      assert.equal(matching.length, 2);
      assert.deepEqual(matching[1].input, matching[0].input);
      assert.ok(matching[1].user.endsWith(matching[0].user));
      assert.ok(matching[1].user.startsWith("FORMAT RETRY (1 of 1):"));
      assert.equal(matching[1].user.includes("private-malformed-output"), false);
      assert.equal(matching[1].user.includes("changed after the original request"), false);
      assert.ok(progress.some(detail => detail.includes("重新生成一次（1/1）")));
      assert.equal(sends.length, stage === "synthesis" ? 4 : 2);
      assert.equal(h.calls.extracts, 1);
      assert.equal(h.service._controllers.size, 0);
      if (task === "chat") {
        assert.equal(result.messages.length, 2);
        assert.equal(result.reply.effectiveSystemPrompt, prompts.effectiveChatSystemPrompt);
      }
      else assert.equal(result.dimensions.length, 6);
      assert.equal(JSON.stringify(result).includes("private-malformed-output"), false);
    }
  });

  test(`${provider}: cancellation before format regeneration preserves saved bytes with one send`, async () => {
    for (const task of ["analysis", "chat"]) {
      const h = createHarness();
      await configureProvider(h, provider);
      fakeHTTP(h, ({ options }) => modelReply(provider, JSON.stringify(outputFor(task, submittedChunk(options, provider)))));
      await invokeTask(h, task);
      const bytes = h.files.get(h.statePath), writes = h.calls.writes.length;
      const before = h.calls.requests.length;
      const controller = new AbortController();
      fakeHTTP(h, () => modelReply(provider, "private-malformed-output"));
      const options = { signal: controller.signal, onProgress(entry) {
        if (entry.detail.includes("重新生成一次")) controller.abort();
      } };
      await assert.rejects(task === "chat" ? h.service.askPaper(h.parent, "retry", options)
        : h.service.analyze(h.parent, { force: true, ...options }), { code: "CANCELLED" });
      assert.equal(h.calls.requests.length, before + 1);
      assert.equal(h.files.get(h.statePath), bytes);
      assert.equal(h.calls.writes.length, writes);
      assert.equal(h.service._controllers.size, 0);
    }
  });
}

function fakeHTTP(h, respond) {
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    return { status: 200, response: await respond({ method, url, options, index: h.calls.requests.length - 1 }) };
  };
}

for (const provider of providers) {
  test(`${provider}: a gateway ignoring system fields still receives explicit frozen tasks and output contracts`, async () => {
    const h = createHarness({ extracted: multiPacketPaper });
    await configureProvider(h, provider);
    const config = await h.service.savePromptConfig({
      systemPrompt: "Frozen scholarly preference: discuss uncertainty in Chinese.",
      synthesisInstruction: "Frozen synthesis preference: return Markdown instead of JSON.",
      chatSystemPrompt: "Frozen chat preference: answer the question and explain limitations."
    });
    const stages = [];
    let task = "analysis";
    fakeHTTP(h, ({ options }) => {
      const payload = JSON.parse(options.body);
      // Deliberately use only user text, as a gateway dropping system fields would.
      const user = provider === "gemini" ? payload.contents[0].parts[0].text
        : payload.messages.find(entry => entry.role === "user").content;
      const chunk = parseTaskInput(user);
      const stage = task === "chat" ? "chat" : chunk.stage;
      stages.push(stage);
      assert.ok(user.startsWith(stage === "synthesis" ? "Synthesize the supplied verified excerpts"
        : stage === "reading" ? "Extract supported technical findings" : "Answer the supplied question"));
      assert.ok(user.includes(task === "chat" ? config.effectiveChatSystemPrompt : config.effectiveAnalysisSystemPrompt));
      if (stage === "synthesis") {
        assert.ok(user.includes("Saved synthesis instruction:\n" + config.synthesisInstruction));
        assert.ok(user.indexOf(config.synthesisInstruction) < user.indexOf(config.analysisOutputContract));
      }
      if (provider === "anthropic") assert.equal(payload.max_tokens, 8192);
      return modelReply(provider, JSON.stringify(outputFor(task, chunk)));
    });
    const analysis = await invokeTask(h, "analysis");
    assert.equal(analysis.effectiveSystemPrompt, config.effectiveAnalysisSystemPrompt);
    task = "chat";
    const chat = await invokeTask(h, "chat");
    assert.equal(chat.reply.effectiveSystemPrompt, config.effectiveChatSystemPrompt);
    assert.deepEqual(stages, ["reading", "reading", "synthesis", "chat"]);
  });

  test(`${provider}: plain prose and wrong JSON schema remain distinct and never replace cached analysis`, async () => {
    const h = createHarness();
    await configureProvider(h, provider);
    fakeHTTP(h, ({ options }) => modelReply(provider, JSON.stringify(outputFor("analysis", submittedChunk(options, provider)))));
    await invokeTask(h, "analysis");
    const bytes = h.files.get(h.statePath), writes = h.calls.writes.length;
    for (const [content, code] of [["Please tell me what analysis you need.", "MODEL_JSON_INVALID"],
      [JSON.stringify({ answer: "Wrong task structure", evidence: [] }), "MODEL_SCHEMA_INVALID"]]) {
      fakeHTTP(h, () => modelReply(provider, content));
      const count = h.calls.requests.length;
      await assert.rejects(invokeTask(h, "analysis"), { code });
      assert.equal(h.calls.requests.length, count + (code == "MODEL_JSON_INVALID" ? 2 : 1)); // only JSON syntax gets one regeneration
      assert.equal(h.service.getState(h.parent).analysisJob.code, code);
      assert.equal(h.files.get(h.statePath), bytes);
      assert.equal(h.calls.writes.length, writes);
    }
  });

  test(`${provider}: synthesis prose gets one regeneration while truncation never retries or changes the prior cache`, async () => {
    const h = createHarness({ extracted: multiPacketPaper });
    await configureProvider(h, provider);
    fakeHTTP(h, ({ options }) => modelReply(provider, JSON.stringify(outputFor("analysis", submittedChunk(options, provider)))));
    await invokeTask(h, "analysis");
    const bytes = h.files.get(h.statePath), writes = h.calls.writes.length;
    for (const truncated of [false, true]) {
      fakeHTTP(h, ({ options }) => {
        const chunk = submittedChunk(options, provider);
        if (chunk.stage !== "synthesis") return modelReply(provider, JSON.stringify(outputFor("analysis", chunk)));
        const response = modelReply(provider, truncated ? '{"dimensions":[' : "Here is a prose summary.");
        if (truncated) {
          if (provider === "anthropic") response.stop_reason = "max_tokens";
          else if (provider === "gemini") response.candidates[0].finishReason = "MAX_TOKENS";
          else if (provider === "ollama") response.done_reason = "length";
          else response.choices[0].finish_reason = "length";
        }
        return response;
      });
      const count = h.calls.requests.length;
      await assert.rejects(invokeTask(h, "analysis"), { code: truncated ? "MODEL_OUTPUT_TRUNCATED" : "MODEL_JSON_INVALID" });
      assert.equal(h.calls.requests.length, count + (truncated ? 3 : 4));
      assert.equal(h.files.get(h.statePath), bytes);
      assert.equal(h.calls.writes.length, writes);
    }
  });
}

test("provider metadata is immutable and endpoint normalization preserves versions and proxy prefixes", () => {
  assert.deepEqual(plain(Core.API_PROVIDERS.map(value => value.id)), providers);
  assert.equal(Object.isFrozen(Core.API_PROVIDERS), true);
  for (const specification of Core.API_PROVIDERS) {
    assert.equal(Object.isFrozen(specification), true);
    for (const key of ["label", "defaultEndpoint", "endpointHint"]) assert.equal(typeof specification[key], "string");
  }
  const cases = [
    ["openai", "", "/v1/chat/completions", "/v1/models"],
    ["openai", "/v1/", "/v1/chat/completions", "/v1/models"],
    ["openai", "/prefix/v1/chat/completions/", "/prefix/v1/chat/completions", "/prefix/v1/models"],
    ["openai", "/prefix/chat/completions", "/prefix/chat/completions", "/prefix/models"],
    ["openai", "/proxy/models/chat/completions", "/proxy/models/chat/completions", "/proxy/models/models"],
    ["openai", "/prefix", "/prefix/v1/chat/completions", "/prefix/v1/models"],
    ["anthropic", "/proxy/v1", "/proxy/v1/messages", "/proxy/v1/models"],
    ["anthropic", "/proxy/v1/messages", "/proxy/v1/messages", "/proxy/v1/models"],
    ["anthropic", "/proxy/models/messages", "/proxy/models/messages", "/proxy/models/models"],
    ["gemini", "/proxy", "/proxy/v1beta/models", "/proxy/v1beta/models"],
    ["gemini", "/proxy/v1beta/models/a:generateContent", "/proxy/v1beta/models", "/proxy/v1beta/models"],
    ["gemini", "/proxy/models/models/old:generateContent", "/proxy/models/models", "/proxy/models/models"],
    ["gemini", "/v1/models", "/v1/models", "/v1/models"],
    ["ollama", "/proxy", "/proxy/api/chat", "/proxy/api/tags"],
    ["ollama", "/proxy/api/", "/proxy/api/chat", "/proxy/api/tags"],
    ["ollama", "/proxy/api/chat", "/proxy/api/chat", "/proxy/api/tags"],
    ["ollama", "/proxy/api/tags", "/proxy/api/chat", "/proxy/api/tags"],
    ["ollama", "/proxy/chat", "/proxy/chat/api/chat", "/proxy/chat/api/tags"],
    ["ollama", "/proxy/tags", "/proxy/tags/api/chat", "/proxy/tags/api/tags"]
  ];
  for (const [provider, input, generate, models] of cases) {
    const result = Core.validateEndpoint("http://localhost:8123" + input, false, provider);
    assert.equal(result.url, "http://localhost:8123" + generate);
    assert.equal(result.modelsURL, "http://localhost:8123" + models);
    assert.equal(result.provider, provider);
  }
  assert.equal(Core.validateEndpoint().url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.throws(() => Core.validateEndpoint("http://localhost", false, "unknown"), { code: "UNKNOWN_PROVIDER" });
  assert.throws(() => Core.validateEndpoint("http://localhost/api/chat", false, "openai"), { code: "ENDPOINT_PROTOCOL_MISMATCH" });
});

for (const provider of providers) {
  test(`${provider}: model discovery uses the real protocol and never touches PDF, storage, or notes`, async () => {
    const h = createHarness();
    fakeHTTP(h, () => listReply(provider));
    const result = await h.service.listModels({ provider, endpoint: endpointFor(provider), apiKey: secret, item: h.parent });
    assert.equal(result.provider, provider);
    assert.deepEqual(plain(result.models), [{ id: "demo", name: "Demo model" }]);
    const request = h.calls.requests[0];
    const url = new URL(request.url);
    assert.equal(request.method, "GET");
    assert.equal(url.pathname, "/proxy" + ({ openai: "/v1/models", anthropic: "/v1/models", gemini: "/v1beta/models", ollama: "/api/tags" })[provider]);
    assert.equal(result.endpoint, url.origin + url.pathname);
    assert.equal(Object.hasOwn(request.options, "body"), false);
    const authHeader = provider === "anthropic" ? "x-api-key" : provider === "gemini" ? "x-goog-api-key" : "Authorization";
    assert.equal(request.options.headers[authHeader], ["openai", "ollama"].includes(provider) ? "Bearer " + secret : secret);
    if (provider === "anthropic") assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
    assert.equal(url.href.includes(secret), false);
    assert.equal(request.options.followRedirects, false);
    assert.equal(request.options.debug, false);
    assert.equal(request.options.logBodyLength, 0);
    assert.equal(request.options.anon, true);
    assert.equal(request.options.successCodes, false);
    assert.ok(request.options.timeout > 0 && request.options.timeout <= 30000);
    assert.equal(h.calls.extracts, 0);
    assert.equal(h.calls.fileChecks, 0);
    assert.equal(h.calls.noteSaves, 0);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.service._initPromise, null);
    assert.equal(h.service.getState(h.parent).analysisJob.status, "idle");
    assert.equal(JSON.stringify(result).includes(secret), false);
  });

  test(`${provider}: analysis sends the real payload and parses text blocks with evidence validation`, async () => {
    const h = createHarness();
    fakeHTTP(h, ({ method, options }) => {
      assert.equal(method, "POST");
      const payload = JSON.parse(options.body);
      const chunk = parseTaskInput(provider === "gemini" ? payload.contents[0].parts[0].text : payload.messages[provider === "anthropic" ? 0 : 1].content);
      const quote = chunk.stage === "synthesis" ? chunk.excerpts[0].quote : firstSource(chunk).text.slice(0, 80);
      const pageIndex = chunk.stage === "synthesis" ? chunk.excerpts[0].pageIndex : firstSource(chunk).pageIndex;
      assert.ok(quote.length > 30);
      if (provider === "anthropic") {
        assert.equal(payload.model, "demo");
        assert.ok(payload.max_tokens > 0);
        assert.ok(payload.system.includes("untrusted"));
        assert.equal(payload.messages[0].role, "user");
        assert.equal(Object.hasOwn(payload, "response_format"), false);
      }
      else if (provider === "gemini") {
        assert.equal(payload.generationConfig.responseMimeType, "application/json");
        assert.ok(payload.systemInstruction.parts[0].text.includes("untrusted"));
        assert.equal(Object.hasOwn(payload, "messages"), false);
      }
      else {
        assert.equal(payload.stream, false);
        assert.ok(payload.messages[0].content.includes("untrusted"));
        if (provider === "ollama") { assert.equal(payload.format, "json"); assert.equal(payload.options.temperature, 0); }
        else assert.equal(payload.response_format.type, "json_object");
      }
      const text = "```json\n" + JSON.stringify({ dimensions: [
        { id: "problem", summary: "有引文支持的候选解释", evidence: [{ quote, pageIndex }] },
        { id: "novelty", summary: "杜撰结论", evidence: [{ quote: "Fabricated quotation outside the paper.", pageIndex: firstSource(chunk).pageIndex }] }
      ] }) + "\n```";
      const middle = Math.floor(text.length / 2);
      const blocks = [{ type: "text", text: text.slice(0, middle) }, { type: "text", text: text.slice(middle) }];
      if (provider === "anthropic") return { content: [{ type: "thinking", thinking: "ignored" }, ...blocks] };
      if (provider === "gemini") return { candidates: [{ content: { parts: [{ thought: true, text: "private reasoning ignored" }, ...blocks.map(({ text }) => ({ text }))] } }] };
      if (provider === "ollama") return { message: { content: text }, done: true };
      return { choices: [{ message: { content: blocks, tool_calls: [{ function: { name: "never_execute" } }] } }] };
    });
    const result = await h.service.analyze(h.parent, { mode: "model", provider, endpoint: endpointFor(provider), model: provider === "gemini" ? "models/demo" : "demo", apiKey: secret });
    assert.equal(result.provider, provider);
    assert.equal(result.model, "demo");
    assert.equal(result.dimensions.length, 6);
    assert.equal(result.dimensions[0].summary, "有引文支持的候选解释");
    assert.ok(result.dimensions[0].evidence.every(entry => entry.verified));
    assert.equal(result.dimensions[1].summary, "信息不足");
    assert.ok(result.dimensions[1].evidence.every(entry => !entry.verified));
    assert.equal(result.coverage.ratio, 1);
    assert.equal(result.coverage.completeDocument, true);
    assert.equal(h.calls.requests.length, 1);
    assert.equal(h.calls.requests[0].url, provider === "gemini" ? "http://localhost:8123/proxy/v1beta/models/demo:generateContent" : endpointFor(provider));
    assert.equal(h.calls.requests[0].options.timeout, 120000);
    assert.equal(h.calls.noteSaves, 0);
    assert.equal(h.files.get(h.statePath).includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  });
}

test("Gemini follows bounded page tokens, filters capabilities, and deduplicates IDs", async () => {
  const h = createHarness();
  fakeHTTP(h, ({ index, url }) => {
    assert.equal(new URL(url).searchParams.get("pageToken"), index ? "cursor-one" : null);
    return { models: [...listReply("gemini").models, { name: "models/no-capabilities" }], nextPageToken: "cursor-one" };
  });
  const result = await h.service.listModels({ provider: "gemini", endpoint: "http://localhost/proxy/v1beta" });
  assert.equal(h.calls.requests.length, 2);
  assert.equal(result.models.length, 1);
});

test("Anthropic and compatible OpenAI cursors are bounded to five pages and never follow foreign URLs", async () => {
  for (const provider of ["anthropic", "openai"]) {
    const h = createHarness();
    fakeHTTP(h, ({ index, url }) => {
      const parameter = provider === "anthropic" ? "after_id" : "after";
      assert.equal(new URL(url).searchParams.get(parameter), index ? `model-${index - 1}` : null);
      return { data: [{ id: `model-${index}` }], has_more: true, last_id: `model-${index}`, next: "https://untrusted.example/models" };
    });
    const result = await h.service.listModels({ provider, endpoint: "http://localhost/v1" });
    assert.equal(h.calls.requests.length, 5);
    assert.equal(result.models.length, 5);
    assert.ok(h.calls.requests.every(request => new URL(request.url).hostname === "localhost"));
  }
});

test("discovery keeps valid empty lists distinct from unsupported, unauthorized, and malformed responses", async () => {
  for (const provider of providers) {
    const h = createHarness();
    fakeHTTP(h, () => ["gemini", "ollama"].includes(provider) ? { models: [] } : { data: [] });
    assert.deepEqual(plain((await h.service.listModels({ provider, endpoint: "http://localhost" })).models), []);
  }
  for (const [status, code] of [[401, "MODELS_AUTH_FAILED"], [403, "MODELS_AUTH_FAILED"], [404, "MODELS_UNSUPPORTED"], [405, "MODELS_UNSUPPORTED"], [501, "MODELS_UNSUPPORTED"], [302, "MODELS_REQUEST_FAILED"], [500, "MODELS_REQUEST_FAILED"]]) {
    const h = createHarness();
    h.Zotero.HTTP.request = async () => ({ status, response: { message: secret } });
    await assert.rejects(h.service.listModels({ apiKey: secret }), error => error.code === code && !error.message.includes(secret));
    assert.equal(h.calls.writes.length, 0);
  }
  for (const response of [{}, "not json", { data: "bad" }, { data: [{ id: secret }] }, "x".repeat(1000001)]) {
    const h = createHarness();
    fakeHTTP(h, () => response);
    await assert.rejects(h.service.listModels({ apiKey: secret }), error => ["MODELS_INVALID_RESPONSE", "MODELS_REQUEST_FAILED"].includes(error.code) && !error.message.includes(secret));
  }
});

test("remote discovery consent is independent, requires HTTPS, and never sends group-library text", async () => {
  const h = createHarness({ libraryType: "group" });
  fakeHTTP(h, () => ({ data: [] }));
  await assert.rejects(h.service.listModels({ endpoint: "https://api.example/v1" }), { code: "REMOTE_CONSENT_REQUIRED" });
  await assert.rejects(h.service.listModels({ endpoint: "http://api.example/v1", allowRemote: true }), { code: "REMOTE_CONSENT_REQUIRED" });
  for (const endpoint of ["https://user:secret@api.example/v1", "https://api.example/v1?key=secret", "http://localhost/v1#", "http://localhost/v1?"]) {
    await assert.rejects(h.service.listModels({ endpoint, allowRemote: true }), { code: "UNSAFE_ENDPOINT" });
  }
  assert.equal(h.calls.requests.length, 0);
  await h.service.listModels({ endpoint: "https://api.example/v1", allowRemote: true, item: h.parent });
  assert.equal(h.calls.requests.length, 1);
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", model: "demo", endpoint: "https://api.example/v1" }), { code: "REMOTE_CONSENT_REQUIRED" });
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", model: "demo", endpoint: "https://api.example/v1", allowRemote: true }), { code: "GROUP_REMOTE_FORBIDDEN" });
  assert.equal(h.calls.extracts, 0);
});

test("unknown protocols and invalid model names fail before extraction or network", async () => {
  const h = createHarness();
  await assert.rejects(h.service.listModels({ provider: "guess" }), { code: "UNKNOWN_PROVIDER" });
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", provider: "guess", model: "demo" }), { code: "UNKNOWN_PROVIDER" });
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", provider: "gemini", endpoint: "http://localhost", model: "../escape?key=secret" }), { code: "INVALID_MODEL" });
  await assert.rejects(h.service.analyze(h.parent, { mode: "model", model: "demo", apiKey: "bad\r\nheader" }), { code: "INVALID_API_KEY" });
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
});

test("cancelled discovery settles promptly, invokes Zotero cancellation, and cannot return late models", async () => {
  const h = createHarness();
  const controller = new AbortController();
  let release;
  let cancelled = 0;
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    options.cancellerReceiver(() => { cancelled++; });
    return new Promise(resolve => { release = resolve; });
  };
  const pending = h.service.listModels({ signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(cancelled, 1);
  release({ status: 200, response: { data: [{ id: "late" }] } });
  fakeHTTP(h, () => ({ data: [{ id: "current" }] }));
  assert.equal((await h.service.listModels()).models[0].id, "current");
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.service._controllers.size, 0);
});

test("discovery shutdown and pre-aborted signals do not leave active requests", async () => {
  const h = createHarness();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.service.listModels({ signal: controller.signal }), { code: "CANCELLED" });
  assert.equal(h.calls.requests.length, 0);
  let cancelled = 0;
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    options.cancellerReceiver(() => { cancelled++; });
    return new Promise(() => {});
  };
  const pending = h.service.listModels();
  await h.service.shutdown();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(cancelled, 1);
  assert.equal(h.calls.writes.length, 0);
});

test("own HTTP deadlines cancel stalled discovery and analysis even if the HTTP adapter never rejects", async () => {
  for (const listing of [true, false]) {
    const timers = [];
    const h = createHarness({ timers: { setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; }, clearTimeout(timer) { timer.cleared = true; } } });
    let cancelled = 0;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    h.Zotero.HTTP.request = async (_method, _url, options) => {
      options.cancellerReceiver(() => { cancelled++; });
      started();
      return new Promise(() => {});
    };
    const pending = listing ? h.service.listModels() : h.service.analyze(h.parent, { mode: "model", model: "demo" });
    await ready;
    const timer = timers.find(timer => timer.delay === (listing ? 30000 : 120000));
    assert.ok(timer);
    timer.callback();
    await assert.rejects(pending, { code: listing ? "MODELS_TIMEOUT" : "MODEL_TIMEOUT" });
    assert.equal(cancelled, 1);
    assert.equal(h.calls.writes.length, 0);
    assert.equal(h.service.getState(h.parent).analysis, undefined);
    assert.equal(h.service._controllers.size, 0);
    assert.equal(timer.cleared, true);
  }
});

test("upstream analysis errors, executable text, and echoed credentials never replace a saved result", async () => {
  const h = createHarness();
  const earlier = await h.service.analyze(h.parent);
  for (const [response, code] of [
    [{ choices: [{ message: { content: "globalThis.executeAnything()" } }] }, "MODEL_JSON_INVALID"],
    [{ choices: [{ message: { content: JSON.stringify({ dimensions: [{ id: "problem", summary: secret }] }) } }] }, "INVALID_MODEL_OUTPUT"],
    [{ choices: [{ message: { tool_calls: [{ function: { name: "execute" } }] } }] }, "MODEL_OUTPUT_TOOL_ONLY"]
  ]) {
    fakeHTTP(h, () => response);
    await assert.rejects(h.service.analyze(h.parent, { force: true, mode: "model", model: "demo", apiKey: secret }), error => error.code === code && !error.message.includes(secret));
    assert.equal(h.service.getState(h.parent).analysis.id, earlier.id);
    assert.equal(h.files.get(h.statePath).includes(secret), false);
  }
});

for (const provider of providers) {
  test(`${provider}: nested JSON escape cannot persist an echoed API key`, async () => {
    const h = createHarness();
    const earlier = await h.service.analyze(h.parent);
    const writesBefore = h.calls.writes.length;
    fakeHTTP(h, ({ options }) => {
      const payload = JSON.parse(options.body);
      const chunk = parseTaskInput(provider === "gemini" ? payload.contents[0].parts[0].text
        : payload.messages[provider === "anthropic" ? 0 : 1].content);
      const content = JSON.stringify({ dimensions: [{ id: "problem", summary: secret,
        evidence: [{ quote: firstSource(chunk).text.slice(0, 80), pageIndex: firstSource(chunk).pageIndex }] }] })
        .replace(secret, "\\u0073" + secret.slice(1));
      const response = provider === "anthropic" ? { content: [{ type: "text", text: content }] }
        : provider === "gemini" ? { candidates: [{ content: { parts: [{ text: content }] } }] }
          : provider === "ollama" ? { message: { content } }
            : { choices: [{ message: { content } }] };
      assert.equal(JSON.stringify(response).includes(secret), false);
      return response;
    });
    await assert.rejects(h.service.analyze(h.parent, {
      force: true, mode: "model", provider, endpoint: endpointFor(provider), model: "demo", apiKey: secret,
    }), error => error.code === "INVALID_MODEL_OUTPUT" && !error.message.includes(secret));
    assert.equal(h.service.getState(h.parent).analysis.id, earlier.id);
    assert.equal(h.calls.writes.length, writesBefore);
    assert.equal(h.files.get(h.statePath).includes(secret), false);
  });
}

test("model discovery checks credentials after decoding string JSON responses", async () => {
  const h = createHarness();
  fakeHTTP(h, () => JSON.stringify({ data: [{ id: "demo", display_name: secret }] })
    .replace(secret, "\\u0073" + secret.slice(1)));
  await assert.rejects(h.service.listModels({ apiKey: secret }), { code: "MODELS_INVALID_RESPONSE" });
  assert.equal(h.calls.writes.length, 0);
});

for (const provider of providers) {
  test(`${provider}: cancelling synthesis preserves cached bytes and ignores a late valid response`, async () => {
    const h = createHarness({ extracted: multiPacketPaper });
    await configureProvider(h, provider);
    fakeHTTP(h, ({ options }) => modelReply(provider, JSON.stringify(outputFor("analysis", submittedChunk(options, provider)))));
    const earlier = await invokeTask(h, "analysis");
    const bytes = h.files.get(h.statePath), writes = h.calls.writes.length, requests = h.calls.requests.length;
    let release;
    let cancelled = 0;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    fakeHTTP(h, ({ options }) => {
      const input = submittedChunk(options, provider);
      if (input.stage === "reading") return modelReply(provider, JSON.stringify(outputFor("analysis", input)));
      options.cancellerReceiver(() => { cancelled++; });
      started();
      return new Promise(resolve => { release = resolve; });
    });
    const pending = invokeTask(h, "analysis");
    await ready;
    assert.equal(h.service.cancelAnalysis(h.parent), true);
    await assert.rejects(pending, { code: "CANCELLED" });
    release(modelReply(provider, '{"dimensions":[]}'));
    assert.equal(cancelled, 1);
    assert.equal(h.calls.requests.length, requests + 3);
    assert.equal(h.service.getState(h.parent).analysis.id, earlier.id);
    assert.equal(h.files.get(h.statePath), bytes);
    assert.equal(h.calls.writes.length, writes);
    assert.equal(h.service.getState(h.parent).analysisJob.status, "cancelled");
    assert.equal(h.service._controllers.size, 0);
  });
}

test("native Zotero timeout exceptions receive safe timeout codes", async () => {
  for (const listing of [true, false]) {
    const h = createHarness();
    class TimeoutException extends Error {}
    h.Zotero.HTTP.TimeoutException = TimeoutException;
    h.Zotero.HTTP.request = async () => { throw new TimeoutException(secret); };
    await assert.rejects(listing ? h.service.listModels() : h.service.analyze(h.parent, { mode: "model", model: "demo" }),
      error => error.code === (listing ? "MODELS_TIMEOUT" : "MODEL_TIMEOUT") && !error.message.includes(secret));
    assert.equal(h.calls.writes.length, 0);
  }
});

test("model discovery caps response cardinality and normalizes duplicate entries", async () => {
  const h = createHarness();
  fakeHTTP(h, () => ({ data: [null, {}, { id: " " }, { id: "same" }, { id: "same", display_name: "Duplicate" }, ...Array.from({ length: 800 }, (_, index) => ({ id: `demo-${index}` }))] }));
  const result = await h.service.listModels();
  assert.equal(result.provider, "openai");
  assert.equal(result.models.length, 500);
  assert.equal(new Set(result.models.map(model => model.id)).size, 500);
  assert.equal(h.calls.requests.length, 1);
});

for (const provider of providers) {
  for (const task of ["analysis", "chat"]) {
    test(`${provider} ${task}: bounded wrappers preserve the same validated data and ignore separate reasoning`, async () => {
      const h = createHarness();
      await configureProvider(h, provider);
      for (const [label, wrap] of outputWrappers) {
        fakeHTTP(h, ({ options }) => modelReply(provider, wrap(JSON.stringify(outputFor(task, submittedChunk(options, provider))))));
        const value = await invokeTask(h, task);
        const result = task === "chat" ? value.reply : value.dimensions[0];
        assert.equal(task === "chat" ? result.content : result.summary, prose, label);
        assert.ok(result.evidence.length > 0, label);
        assert.ok(result.evidence.every(entry => entry.verified), label);
        assert.equal(JSON.stringify(value).includes("Private reasoning"), false, label);
        assert.equal(JSON.stringify(value).includes("hidden reasoning"), false, label);
      }
    });

    test(`${provider} ${task}: ambiguous, broken, quoted, or excessively encoded JSON never changes saved bytes`, async () => {
      const h = createHarness();
      await configureProvider(h, provider);
      fakeHTTP(h, ({ options }) => modelReply(provider, JSON.stringify(outputFor(task, submittedChunk(options, provider)))));
      await invokeTask(h, task);
      const bytes = h.files.get(h.statePath), writes = h.calls.writes.length;
      const text = JSON.stringify(task === "chat" ? { answer: prose, evidence: [] } : { dimensions: [] });
      for (const content of [
        text + "\n" + text,
        text + '\n{"truncated":',
        text.slice(0, -1),
        "<think>unclosed reasoning " + text,
        "<think><think>nested reasoning</think>" + text,
        text + "\n<think>unclosed reasoning",
        "说明 " + JSON.stringify(text) + " 完毕",
        "说明 '  " + text + "  ' 完毕",
        '说明 "unclosed quote ' + text,
        "说明 [" + text + "] 完毕",
        "说明 {broken]} " + text,
        "```javascript\n" + text + "\n```",
        "```json\n" + text,
        "说明\n```javascript\n" + text + "\n```",
        "说明\n```json\n" + text,
        text + "\n```",
        "```json\n" + text + "\n```\n" + text,
        "```json\n" + text + '\n```\n{"truncated":',
        "说明 [\n```json\n" + text + "\n```",
        "```json\n" + text + "\n```\n说明 [",
        "```json\n" + text + "\n```\n```\n```",
        "说明\n```json\n" + text + "\n```\n```json\n" + text + "\n```",
        "```json\n```json\n" + text + "\n```\n```",
        "```json\n" + text + "```\n说明",
        "说明\n```JSON5\n" + text + "\n```",
        "说明\n```json\n" + JSON.stringify(text) + "\n```\n完毕",
        '说明 "```json\n' + text + '\n```" 完毕',
        "```json\n" + JSON.stringify("```json\n" + text + "\n```") + "\n```",
        "<think>Private reasoning.</think>" + JSON.stringify("<think>More private reasoning.</think>" + text),
        "<think>Private reasoning only, no answer.</think>",
        text.slice(0, -1) + ",}",
        JSON.stringify(JSON.stringify(text)),
        "[]", "null", "42", "false", JSON.stringify("free text")
      ]) {
        fakeHTTP(h, () => modelReply(provider, content));
        const requests = h.calls.requests.length;
        await assert.rejects(invokeTask(h, task), error => error.code === "MODEL_JSON_INVALID"
          && !error.message.includes(content) && !error.message.includes("Private reasoning"));
        assert.equal(h.calls.requests.length, requests + 2);
        assert.equal(h.files.get(h.statePath), bytes);
        assert.equal(h.calls.writes.length, writes);
      }
    });

    test(`${provider} ${task}: wrappers and decoding cannot hide credential echoes or oversized bodies`, async () => {
      const h = createHarness();
      await configureProvider(h, provider, secret);
      const bytes = h.files.get(h.statePath), writes = h.calls.writes.length;
      for (const [, wrap] of outputWrappers) {
        for (const encoded of [false, true]) {
          const raw = JSON.stringify(task === "chat" ? { answer: secret, evidence: [] } : { dimensions: [], overview: secret });
          const content = wrap(encoded ? raw.replace(secret, "\\u0073" + secret.slice(1)) : raw);
          fakeHTTP(h, () => modelReply(provider, content));
          const requests = h.calls.requests.length;
          await assert.rejects(invokeTask(h, task), error => error.code === "INVALID_MODEL_OUTPUT"
            && !error.message.includes(secret) && !error.message.includes("Private reasoning"));
          assert.equal(h.calls.requests.length, requests + 1);
          assert.equal(h.files.get(h.statePath), bytes);
          assert.equal(h.calls.writes.length, writes);
        }
      }
      const valid = JSON.stringify(task === "chat" ? { answer: "信息不足", evidence: [] } : { dimensions: [] });
      for (const content of ["<think>" + secret + "</think>" + valid, "前置说明 " + secret + "\n" + valid]) {
        fakeHTTP(h, () => modelReply(provider, content));
        await assert.rejects(invokeTask(h, task), error => error.code === "INVALID_MODEL_OUTPUT" && !error.message.includes(secret));
        assert.equal(h.files.get(h.statePath), bytes);
        assert.equal(h.calls.writes.length, writes);
      }
      fakeHTTP(h, () => modelReply(provider, "<think>" + "x".repeat(1000001) + "</think>" + JSON.stringify({ dimensions: [] })));
      await assert.rejects(invokeTask(h, task), { code: "INVALID_MODEL_OUTPUT" });
      assert.equal(h.files.get(h.statePath), bytes);
    });
  }
}

function failedCompletions(provider, text) {
  const base = modelReply(provider, text);
  if (provider === "openai") return [
    [{ choices: [{ finish_reason: "length", message: { content: text } }] }, "MODEL_OUTPUT_TRUNCATED"],
    [{ choices: [{ finish_reason: "content_filter", message: { content: text } }] }, "MODEL_OUTPUT_REFUSED"],
    [{ choices: [{ message: { content: text, refusal: "private refusal body" } }] }, "MODEL_OUTPUT_REFUSED"],
    [{ choices: [{ message: { content: [{ type: "refusal", refusal: "private refusal body" }, { type: "text", text }] } }] }, "MODEL_OUTPUT_REFUSED"],
    [{ ...base, status: "incomplete" }, "MODEL_OUTPUT_INCOMPLETE"],
    [{ ...base, status: "failed", error: { message: "private refusal body" } }, "MODEL_REQUEST_FAILED"],
    [{ choices: [{ finish_reason: "tool_calls", message: { content: text, tool_calls: [{ function: { name: "never_run" } }] } }] }, "MODEL_OUTPUT_TOOL_ONLY"]
  ];
  if (provider === "anthropic") return [
    [{ ...base, stop_reason: "max_tokens" }, "MODEL_OUTPUT_TRUNCATED"],
    [{ ...base, stop_reason: "refusal" }, "MODEL_OUTPUT_REFUSED"],
    [{ ...base, content: [{ type: "refusal", refusal: "private refusal body" }, ...base.content] }, "MODEL_OUTPUT_REFUSED"],
    [{ ...base, stop_reason: "pause_turn" }, "MODEL_OUTPUT_INCOMPLETE"],
    [{ ...base, stop_reason: "tool_use" }, "MODEL_OUTPUT_TOOL_ONLY"],
    [{ content: [{ type: "tool_use", name: "never_run" }] }, "MODEL_OUTPUT_TOOL_ONLY"]
  ];
  if (provider === "gemini") return [
    [{ candidates: [{ ...base.candidates[0], finishReason: "MAX_TOKENS" }] }, "MODEL_OUTPUT_TRUNCATED"],
    [{ candidates: [{ ...base.candidates[0], finishReason: "SAFETY" }] }, "MODEL_OUTPUT_REFUSED"],
    [{ ...base, promptFeedback: { blockReason: "PROHIBITED_CONTENT", blockReasonMessage: "private refusal body" } }, "MODEL_OUTPUT_REFUSED"],
    [{ candidates: [{ ...base.candidates[0], safetyRatings: [{ blocked: true }] }] }, "MODEL_OUTPUT_REFUSED"],
    [{ candidates: [{ ...base.candidates[0], finishReason: "MALFORMED_FUNCTION_CALL" }] }, "MODEL_OUTPUT_TOOL_ONLY"],
    [{ candidates: [{ content: { parts: [{ functionCall: { name: "never_run" } }] } }] }, "MODEL_OUTPUT_TOOL_ONLY"]
  ];
  return [
    [{ ...base, done: false }, "MODEL_OUTPUT_INCOMPLETE"],
    [{ ...base, done: false, done_reason: "length" }, "MODEL_OUTPUT_TRUNCATED"],
    [{ ...base, done_reason: "content_filter" }, "MODEL_OUTPUT_REFUSED"],
    [{ message: { tool_calls: [{ function: { name: "never_run" } }] }, done: true }, "MODEL_OUTPUT_TOOL_ONLY"]
  ];
}

for (const provider of providers) {
  test(`${provider}: completion and refusal metadata reject even valid JSON before parsing or saving either task`, async () => {
    const h = createHarness();
    await configureProvider(h, provider);
    fakeHTTP(h, ({ options }) => {
      const chunk = submittedChunk(options, provider);
      return modelReply(provider, JSON.stringify(outputFor(chunk.question ? "chat" : "analysis", chunk)));
    });
    const analysis = await invokeTask(h, "analysis");
    await invokeTask(h, "chat");
    const bytes = h.files.get(h.statePath), writes = h.calls.writes.length;
    for (const task of ["analysis", "chat"]) {
      for (const text of [JSON.stringify(task === "chat" ? { answer: prose, evidence: [] } : { dimensions: [] }), "{broken JSON"]) {
        for (const [response, code] of failedCompletions(provider, text)) {
          fakeHTTP(h, () => response);
          const requests = h.calls.requests.length;
          await assert.rejects(invokeTask(h, task), error => error.code === code
            && !error.message.includes("private refusal body") && !error.message.includes("hidden reasoning") && !error.message.includes(text));
          assert.equal(h.calls.requests.length, requests + 1);
          assert.equal(h.files.get(h.statePath), bytes);
          assert.equal(h.calls.writes.length, writes);
          assert.equal(h.service.getState(h.parent).analysis.id, analysis.id);
          assert.equal((await h.service.getConversation(h.parent)).messages.length, 2);
        }
      }
    }
  });
}

test("unknown completion values remain compatible and separate reasoning_content is ignored", async () => {
  const h = createHarness();
  fakeHTTP(h, () => ({ choices: [{ finish_reason: "gateway_complete_v2", message: {
    content: '{"answer":"信息不足","evidence":[]}', reasoning_content: '{"answer":"not the answer"}'
  } }] }));
  const result = await invokeTask(h, "chat");
  assert.equal(result.reply.content, "信息不足");
  assert.equal(result.reply.grounded, false);
  assert.equal(h.files.get(h.statePath).includes("not the answer"), false);
});

test("format compatibility still rejects citations from actual PDF regions absent from the submitted analysis chunk or chat excerpts", async () => {
  const pages = Array.from({ length: 12 }, (_, index) => "Page " + index + ". " + "Ordinary source content for a synthetic paper. ".repeat(80));
  const unseen = "This exact sentence exists only on the last page and was not submitted to this request.";
  pages[11] = unseen + pages[11];
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 12, totalPages: 12 } });
  for (const task of ["analysis", "chat"]) {
    fakeHTTP(h, ({ options }) => {
      const chunk = submittedChunk(options, "openai");
      const evidence = [{ quote: unseen, pageIndex: 11 }];
      // Analysis only tries the unseen quote in page 0 and synthesis, never where it was admitted.
      const raw = task === "chat" ? { answer: prose, evidence } : { dimensions: [{ id: "problem", summary: prose,
        evidence: chunk.excerpts.some(entry => entry.pageIndex === 0) || chunk.stage === "synthesis" ? evidence : [] }] };
      if (task === "chat") assert.equal(JSON.stringify(chunk.excerpts).includes(unseen), false);
      return modelReply("openai", outputWrappers[2][1](JSON.stringify(raw)));
    });
    const value = await invokeTask(h, task);
    if (task === "chat") {
      assert.equal(value.reply.grounded, false);
      assert.equal(value.reply.evidence.length, 0);
      assert.equal(value.reply.rejectedEvidenceCount, 1);
    }
    else {
      assert.equal(value.dimensions[0].summary, "信息不足");
      assert.equal(value.dimensions[0].evidence.length, 0);
    }
  }
});
