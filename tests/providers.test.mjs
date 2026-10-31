import test from "node:test";
import assert from "node:assert/strict";
import { createHarness, loadCore, plain } from "./fixtures/harness.mjs";

const Core = loadCore();
const providers = ["openai", "anthropic", "gemini", "ollama"];
const secret = "synthetic-memory-only-credential";
const endpointFor = provider => "http://localhost:8123/proxy" + ({ openai: "/v1/chat/completions", anthropic: "/v1/messages", gemini: "/v1beta/models/old:generateContent", ollama: "/api/chat" })[provider];
const listReply = provider => provider === "gemini"
  ? { models: [{ name: "models/demo", displayName: "Demo model", supportedGenerationMethods: ["generateContent"] }, { name: "models/embed", supportedGenerationMethods: ["embedContent"] }] }
  : provider === "ollama" ? { models: [{ model: "demo", name: "Demo model" }] }
    : { data: [{ id: "demo", display_name: "Demo model" }] };

function fakeHTTP(h, respond) {
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    return { status: 200, response: await respond({ method, url, options, index: h.calls.requests.length - 1 }) };
  };
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
      const chunk = JSON.parse(provider === "gemini" ? payload.contents[0].parts[0].text : payload.messages[provider === "anthropic" ? 0 : 1].content);
      assert.ok(chunk.text.length > 30);
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
        { id: "problem", summary: "有引文支持的候选解释", evidence: [{ quote: chunk.text.slice(0, 80), pageIndex: chunk.pageIndex }] },
        { id: "novelty", summary: "杜撰结论", evidence: [{ quote: "Fabricated quotation outside the paper.", pageIndex: chunk.pageIndex }] }
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
    assert.equal(h.calls.requests.length, 2);
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
  for (const response of [
    { choices: [{ message: { content: "globalThis.executeAnything()" } }] },
    { choices: [{ message: { content: JSON.stringify({ dimensions: [{ id: "problem", summary: secret }] }) } }] },
    { choices: [{ message: { tool_calls: [{ function: { name: "execute" } }] } }] }
  ]) {
    fakeHTTP(h, () => response);
    await assert.rejects(h.service.analyze(h.parent, { mode: "model", model: "demo", apiKey: secret }), error => error.code === "INVALID_MODEL_OUTPUT" && !error.message.includes(secret));
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
      const chunk = JSON.parse(provider === "gemini" ? payload.contents[0].parts[0].text
        : payload.messages[provider === "anthropic" ? 0 : 1].content);
      const content = JSON.stringify({ dimensions: [{ id: "problem", summary: secret,
        evidence: [{ quote: chunk.text.slice(0, 80), pageIndex: chunk.pageIndex }] }] })
        .replace(secret, "\\u0073" + secret.slice(1));
      const response = provider === "anthropic" ? { content: [{ type: "text", text: content }] }
        : provider === "gemini" ? { candidates: [{ content: { parts: [{ text: content }] } }] }
          : provider === "ollama" ? { message: { content } }
            : { choices: [{ message: { content } }] };
      assert.equal(JSON.stringify(response).includes(secret), false);
      return response;
    });
    await assert.rejects(h.service.analyze(h.parent, {
      mode: "model", provider, endpoint: endpointFor(provider), model: "demo", apiKey: secret,
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

test("cancelling an active model upload preserves previous analysis and ignores a late response", async () => {
  const h = createHarness();
  const earlier = await h.service.analyze(h.parent);
  let release;
  let cancelled = 0;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    options.cancellerReceiver(() => { cancelled++; });
    started();
    return new Promise(resolve => { release = resolve; });
  };
  const pending = h.service.analyze(h.parent, { mode: "model", provider: "ollama", model: "demo", endpoint: "http://localhost" });
  await ready;
  assert.equal(h.service.cancelAnalysis(h.parent), true);
  await assert.rejects(pending, { code: "CANCELLED" });
  release({ status: 200, response: { message: { content: '{"dimensions":[]}' } } });
  assert.equal(cancelled, 1);
  assert.equal(h.service.getState(h.parent).analysis.id, earlier.id);
  assert.equal(h.service.getState(h.parent).analysisJob.status, "cancelled");
  assert.equal(h.service._controllers.size, 0);
});

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
