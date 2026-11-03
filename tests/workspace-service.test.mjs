import test from "node:test";
import assert from "node:assert/strict";
import { parseTaskInput, createHarness, plain, paper } from "./fixtures/harness.mjs";

const firstSource = input => input.excerpts[0];
const multiPacketPaper = { ...paper, text: paper.text.split("\f").map(page => page.padEnd(9000, " ")).join("\f") };

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

test("collection metadata preserves nested and empty folders across accessible read-only libraries", async () => {
  const h = createHarness();
  h.libraries.set(2, { libraryID: 2, name: "Synthetic group", libraryType: "group", editable: false });
  h.libraries.set(3, { libraryID: 3, name: "Hidden feed", libraryType: "feed" });
  for (const collection of [
    { id: 10, key: "FOLDER10", libraryID: 1, name: "Research", parentID: false },
    { id: 11, key: "FOLDER11", libraryID: 1, name: "Zulu child", parentID: 10 },
    { id: 12, key: "FOLDER12", libraryID: 1, name: "Alpha empty", parentID: 10 },
    { id: 13, key: "FOLDER13", libraryID: 1, name: "Nested empty", parentID: 12 },
    { id: 20, key: "FOLDER10", libraryID: 2, name: "Read-only folder", parentID: null },
    { id: 30, key: "FOLDER30", libraryID: 3, name: "Hidden folder", parentID: null }
  ]) h.collections.set(collection.id, collection);
  const queried = [];
  const getAllIDs = h.Zotero.Collections.getAllIDs;
  h.Zotero.Collections.getAllIDs = async id => { queried.push(id); return getAllIDs(id); };
  const collections = plain(await h.service.listCollections());
  assert.deepEqual(collections.map(row => row.id), [12, 13, 10, 11, 20]);
  assert.deepEqual(collections.find(row => row.id === 10), { id: 10, key: "FOLDER10", libraryID: 1, name: "Research", parentID: null });
  assert.equal(collections.find(row => row.id === 13).parentID, 12);
  assert.deepEqual(collections.filter(row => row.parentID === 10).map(row => row.name), ["Alpha empty", "Zulu child"]);
  assert.deepEqual(queried, [1, 2]);
  assert.deepEqual(plain(await h.service.listCollections({ libraryID: "2" })), [collections[4]]);
  assert.equal((await h.service.listPapers({ libraryID: 1, collectionID: 13 })).total, 0);
  await assert.rejects(h.service.listCollections({ libraryID: 3 }), { code: "LIBRARY_UNAVAILABLE" });
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
});

test("deleted, missing and cross-library parents never create dangling or cyclic collection hierarchies", async () => {
  const h = createHarness();
  h.libraries.set(2, { libraryID: 2, libraryType: "group", editable: false });
  for (const collection of [
    { id: 10, key: "FOLDER10", libraryID: 1, name: "Trashed", parentID: null, deleted: true },
    { id: 11, key: "FOLDER11", libraryID: 1, name: "Child of trash", parentID: 10 },
    { id: 12, key: "FOLDER12", libraryID: 1, name: "Missing parent", parentID: 999 },
    { id: 13, key: "FOLDER13", libraryID: 1, name: "Cross library", parentID: 20 },
    { id: 14, key: "FOLDER14", libraryID: 1, name: "Self cycle", parentID: 14 },
    { id: 15, key: "FOLDER15", libraryID: 1, name: "Cycle A", parentID: 16 },
    { id: 16, key: "FOLDER16", libraryID: 1, name: "Cycle B", parentID: 17 },
    { id: 17, key: "FOLDER17", libraryID: 1, name: "Cycle C", parentID: 15 },
    { id: 20, key: "FOLDER20", libraryID: 2, name: "Group root", parentID: null }
  ]) h.collections.set(collection.id, collection);
  const originals = plain([...h.collections.values()]);
  const rows = plain(await h.service.listCollections());
  const byID = new Map(rows.map(row => [row.id, row]));
  assert.equal(byID.has(10), false);
  for (const id of [11, 12, 13, 14]) assert.equal(byID.get(id).parentID, null);
  assert.equal([15, 16, 17].filter(id => byID.get(id).parentID === null).length, 1);
  for (const row of rows) {
    const seen = new Set();
    let current = row;
    while (current) {
      assert.equal(seen.has(current.id), false);
      seen.add(current.id);
      const parent = byID.get(current.parentID);
      if (parent) assert.equal(parent.libraryID, row.libraryID);
      current = parent;
    }
  }
  assert.deepEqual(plain([...h.collections.values()]), originals);
  assert.deepEqual(plain(await h.service.listCollections()), rows);
});

test("collection paper filters use direct membership before search, focus and paging without duplicate cards", async () => {
  const h = createHarness();
  h.libraries.set(2, { libraryID: 2, name: "Read-only group", libraryType: "group", editable: false });
  for (const collection of [
    { id: 10, key: "FOLDER10", libraryID: 1, name: "Parent", parentID: null },
    { id: 11, key: "FOLDER11", libraryID: 1, name: "Child", parentID: 10 },
    { id: 20, key: "FOLDER20", libraryID: 2, name: "Group", parentID: null }
  ]) h.collections.set(collection.id, collection);
  h.parent.collections = [10, 11];
  for (const [id, title, collections, libraryID, deleted] of [
    [3, "Alpha direct paper", [10], 1, false],
    [4, "Beta descendant paper", [11], 1, false],
    [5, "Deleted direct paper", [10], 1, true],
    [9, "Group paper", [20], 2, false]
  ]) h.records.set(id, { ...h.parent, id, key: id === 9 ? h.parent.key : "PAPER00" + id, libraryID, deleted, collections,
    fields: { ...h.parent.fields, title } });
  await h.service.setFocused(h.parent, true);
  await h.service.setFocused(h.records.get(4), true);
  h.service._document.items["1:PAPER001"].analysis = { id: "cached-analysis", mode: "model" };
  const getAll = h.Zotero.Items.getAll;
  h.Zotero.Items.getAll = async id => [...await getAll(id), h.parent, h.records.get(9)];
  const direct = await h.service.listPapers({ libraryID: "1", collectionID: "10" });
  assert.deepEqual(plain(direct.items.map(item => item.id)), [1, 3]);
  assert.equal(direct.total, 2);
  assert.equal(direct.items[0].hasAnalysis, true);
  const page = await h.service.listPapers({ collectionID: 10, query: "direct", offset: 1, limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.items.length, 0);
  const second = await h.service.listPapers({ collectionID: 10, offset: 1, limit: 1 });
  assert.equal(second.total, 2);
  assert.deepEqual(plain(second.items.map(item => item.id)), [3]);
  assert.deepEqual(plain((await h.service.listPapers({ collectionID: 11, query: "descendant" })).items.map(item => item.id)), [4]);
  assert.deepEqual(plain((await h.service.listPapers({ collectionID: 10, focusOnly: true })).items.map(item => item.id)), [1]);
  assert.deepEqual(plain((await h.service.listPapers({ collectionID: 20 })).items.map(item => item.id)), [9]);
  assert.equal((await h.service.listPapers({ libraryID: 2, collectionID: 20, focusOnly: true })).total, 0);
  assert.equal((await h.service.listPapers({ libraryID: 1, collectionID: null })).total, 3);
  assert.equal((await h.service.listPapers()).total, 4);
  assert.equal(h.service.getState(h.parent).analysis.id, "cached-analysis");
  assert.equal(h.calls.extracts, 0);
  assert.equal(h.calls.requests.length, 0);
});

test("invalid or inaccessible collection IDs fail closed within the selected accessible library", async () => {
  const h = createHarness();
  h.libraries.set(2, { libraryID: 2, libraryType: "group", editable: false });
  h.libraries.set(3, { libraryID: 3, libraryType: "feed" });
  for (const collection of [
    { id: 10, key: "FOLDER10", libraryID: 1, name: "Personal", parentID: null },
    { id: 11, key: "FOLDER11", libraryID: 1, name: "Deleted", parentID: null, deleted: true },
    { id: 20, key: "FOLDER20", libraryID: 2, name: "Group", parentID: null },
    { id: 30, key: "FOLDER30", libraryID: 3, name: "Hidden", parentID: null },
    { id: 40, key: "FOLDER40", libraryID: 4, name: "Unregistered", parentID: null }
  ]) h.collections.set(collection.id, collection);
  const queried = [];
  const getAllIDs = h.Zotero.Collections.getAllIDs;
  h.Zotero.Collections.getAllIDs = async id => { queried.push(id); return getAllIDs(id); };
  h.Zotero.Items.getAll = async () => { throw new Error("invalid scope must not read any items"); };
  for (const collectionID of [0, -1, "bad", 1.5, true, [], [10], {}, 11, 20, 30, 40, 999]) {
    await assert.rejects(h.service.listPapers({ libraryID: 1, collectionID }), { code: "COLLECTION_UNAVAILABLE" });
  }
  for (const collectionID of [11, 30, 40, 999]) {
    await assert.rejects(h.service.listPapers({ collectionID }), { code: "COLLECTION_UNAVAILABLE" });
  }
  assert.ok(queried.every(id => [1, 2].includes(id)));
  await assert.rejects(h.service.listPapers({ libraryID: 3, collectionID: 30 }), { code: "LIBRARY_UNAVAILABLE" });
  assert.equal(h.calls.writes.length, 0);
});

test("collection membership loads its item datatype through bulk and individual adapters", async () => {
  for (const bulk of [true, false]) {
    const h = createHarness();
    h.collections.set(10, { id: 10, key: "FOLDER10", libraryID: 1, name: "Synthetic", parentID: null });
    h.parent.collections = [10];
    const loaded = [];
    h.parent.inCollection = function (id) {
      assert.ok(loaded.includes("collections"), "collections must load before direct membership");
      return this.collections.includes(id);
    };
    if (bulk) {
      h.Zotero.Items.loadDataTypes = async (items, types) => {
        assert.deepEqual(plain(items.map(item => item.id)), [1]);
        loaded.push(...types);
      };
      h.parent.loadDataType = () => { throw new Error("must use skip-loaded bulk adapter"); };
    }
    else h.parent.loadDataType = async type => { loaded.push(type); };
    const result = await h.service.listPapers({ collectionID: 10 });
    assert.equal(result.items[0].id, 1);
    assert.deepEqual(plain(loaded), ["itemData", "creators", "collections"]);
    assert.equal(h.parent.fields.title, "A Synthetic Calibration Study");
    assert.equal(h.calls.writes.length, 0);
  }
});

test("missing collection APIs report a scoped error while all-paper listing stays available", async () => {
  const h = createHarness();
  delete h.Zotero.Collections;
  assert.equal((await h.service.listPapers()).total, 1);
  await assert.rejects(h.service.listCollections(), { code: "COLLECTIONS_UNAVAILABLE" });
  await assert.rejects(h.service.listPapers({ collectionID: 10 }), { code: "COLLECTIONS_UNAVAILABLE" });
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
  const h = createHarness({ extracted: multiPacketPaper });
  let stages = [];
  h.Zotero.HTTP.request = async (method, url, options) => {
    h.calls.requests.push({ method, url, options });
    const chunk = parseTaskInput(JSON.parse(options.body).messages[1].content);
    stages.push(chunk.stage);
    const candidates = chunk.stage === "synthesis" ? chunk.excerpts : chunk.excerpts.flatMap(entry =>
      entry.text.split("\n").filter(line => /Figure 1|Table 2/.test(line)).map(quote => ({ quote, pageIndex: entry.pageIndex })));
    if (chunk.stage === "synthesis") {
      assert.ok(JSON.stringify(chunk).length < 48000);
      assert.ok(chunk.excerpts.every(entry => multiPacketPaper.text.includes(entry.quote)));
      assert.equal(Object.hasOwn(chunk, "text"), false);
    }
    const evidence = candidates.map(({ quote, pageIndex }) => ({ quote, pageIndex }));
    const response = { dimensions: [{ id: "problem", summary: chunk.stage === "synthesis" ? "从动机到技术的连贯学术解释。" : "逐段发现", evidence }],
      overview: "论文围绕校准问题展开，并需要结合实验条件理解其结论。", overviewEvidence: evidence,
      readingGuide: "结合原文的图表引用，先理解表示方法，再核对比较条件。", readingGuideEvidence: evidence,
      figureTableReferences: chunk.stage === "synthesis" ? [] : evidence.map(entry => ({ reference: entry.pageIndex === 0 ? "Figure 1" : "Table 2",
        kind: entry.pageIndex === 0 ? "figure" : "table", explanation: "与方法或比较条件相关的图表文字候选。", ...entry })) };
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
  const unsubmitted = "This distinct middle-window sentence was not admitted to the final synthesis.";
  const pages = multiPacketPaper.text.split("\f");
  pages[1] = pages[1].slice(0, 6500) + unsubmitted + pages[1].slice(6500 + unsubmitted.length);
  const h = createHarness({ extracted: { ...multiPacketPaper, text: pages.join("\f") } });
  const saved = await h.service.analyze(h.parent);
  const writes = h.calls.writes.length;
  for (const echoCredential of [false, true]) {
    h.Zotero.HTTP.request = async (_method, _url, options) => {
      const chunk = parseTaskInput(JSON.parse(options.body).messages[1].content);
      if (chunk.stage === "synthesis") assert.ok(!chunk.excerpts.some(entry => entry.quote.includes(unsubmitted)));
      const evidence = chunk.stage === "synthesis"
        ? [{ quote: unsubmitted, pageIndex: 1 }]
        : [{ quote: firstSource(chunk).text.slice(0, 50), pageIndex: firstSource(chunk).pageIndex }];
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

test("a 20-page 76000-character source submits late experiments and end failures, then saves their verified evidence", async () => {
  const experiment = "The experiment on page sixteen reports error 0.14 against baseline 0.28 at equal compute.";
  const failure = "The end-of-paper failure case is unstable calibration under complete target occlusion.";
  const pages = Array.from({ length: 20 }, (_, index) =>
    ((index === 0 ? "Abstract\n" : index === 3 ? "Methods\n" : index === 16 ? "Experiments\n" : index === 19 ? "Limitations\n" : "")
      + "Physical page " + index + ". " + (index === 16 ? experiment : index === 19 ? failure : "Synthetic source description.")
      + "\n" + "Ordinary source context. ".repeat(180)).slice(0, 3800).padEnd(3800, " "));
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 20, totalPages: 20 } });
  const submitted = [];
  const stages = [];
  let finalInput;
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    const input = parseTaskInput(JSON.parse(options.body).messages[1].content);
    stages.push(input.stage);
    if (input.stage === "reading") submitted.push(...input.excerpts);
    else finalInput = input;
    const evidenceFor = quote => input.excerpts.filter(entry => (entry.text || entry.quote).includes(quote))
      .map(entry => ({ quote, pageIndex: entry.pageIndex }));
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [
      { id: "superiority", summary: "在明确的同等计算条件下，给出了实验误差比较。", evidence: evidenceFor(experiment) },
      { id: "technical-uniqueness", summary: "该方法在目标完全遮挡时仍有失稳的适用限制。", evidence: evidenceFor(failure) }
    ] }) } }] } };
  };
  const result = await h.service.analyze(h.parent);
  assert.equal(submitted.reduce((sum, entry) => sum + entry.text.length, 0), 76000);
  assert.ok(submitted.some(entry => entry.pageIndex === 16 && entry.text.includes(experiment)));
  assert.ok(submitted.some(entry => entry.pageIndex === 19 && entry.text.includes(failure)));
  assert.equal(result.coverage.packetsAnalyzed, 5);
  assert.deepEqual(stages, [...Array(5).fill("reading"), "synthesis"]);
  assert.equal(result.coverage.analyzedCharacters, 76000);
  assert.equal(result.coverage.omittedCharacters, 0);
  assert.equal(result.coverage.completeDocument, true);
  assert.equal(result.coverage.selectionStrategy, "complete-source");
  assert.equal(result.coverage.analysisPlanVersion, 1);
  assert.equal(result.coverage.sourceExcerpts, submitted.length);
  assert.ok(result.coverage.sections.some(entry => entry.hint === "experiments" && entry.selectedCharacters > 0));
  assert.ok(finalInput.excerpts.some(entry => entry.quote === experiment && entry.pageIndex === 16));
  assert.ok(finalInput.excerpts.some(entry => entry.quote === failure && entry.pageIndex === 19));
  const persisted = JSON.parse(h.files.get(h.statePath)).items["1:PAPER001"].analysis;
  assert.ok(persisted.dimensions[4].evidence.some(entry => entry.verified && entry.pageIndex === 16));
  assert.ok(persisted.dimensions[5].evidence.some(entry => entry.verified && entry.pageIndex === 19));
});

test("over-budget sources keep upload and synthesis limits, and cannot admit an unsubmitted appendix window", async () => {
  const pages = Array.from({ length: 24 }, (_, page) => (page === 23 ? "Appendix\n" : page === 15 ? "Experiments\n" : "Methods\n")
    + Array.from({ length: 60 }, (_, line) => "Physical page " + page + " row " + line + ": "
      + "Numerical source context with escaped values \" \\ . ".repeat(5) + "\n").join(""));
  const appendixQuotes = pages[23].split("\n").filter(line => line.length > 100);
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 24, totalPages: 24 } });
  const submitted = [];
  let finalInput;
  let omitted;
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    const input = parseTaskInput(JSON.parse(options.body).messages[1].content);
    let evidence;
    if (input.stage === "reading") {
      submitted.push(...input.excerpts);
      assert.ok(input.excerpts.reduce((sum, entry) => sum + entry.text.length, 0) <= 16000);
      evidence = input.excerpts.map(entry => ({ quote: entry.text.slice(0, 320), pageIndex: entry.pageIndex }));
    }
    else {
      finalInput = input;
      omitted = appendixQuotes.find(quote => !submitted.some(entry => entry.text.includes(quote)));
      assert.ok(omitted, "the fixture contains an appendix window absent from actual requests");
      evidence = [{ quote: omitted, pageIndex: 23 }];
    }
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [
      { id: "problem", summary: "candidate appendix finding", evidence }
    ] }) } }] } };
  };
  const result = await h.service.analyze(h.parent);
  assert.ok(result.coverage.packetsAnalyzed <= 12);
  assert.equal(submitted.reduce((sum, entry) => sum + entry.text.length, 0), 120000);
  assert.ok(JSON.stringify(finalInput).length <= 48000);
  assert.ok(finalInput.excerpts.length <= 48);
  assert.ok(finalInput.excerpts.reduce((sum, entry) => sum + entry.quote.length, 0) <= 28000);
  assert.equal(result.coverage.completeDocument, false);
  assert.ok(result.coverage.omittedCharacters > 0);
  assert.equal(result.coverage.selectionStrategy, "section-position-heuristic");
  assert.ok(result.limitations.some(value => value.includes("仅分析了部分原文")));
  assert.equal(result.dimensions[0].summary, "信息不足");
  assert.equal(result.dimensions[0].evidence.length, 0);
  assert.ok(!JSON.stringify(result).includes(omitted));
});

test("synthesis rechecks reporting and table context omitted by reading summaries without extra model calls", async () => {
  const seeds = "We use random seeds 2 through 18 and exclude seeds 6 and 12 in both control conditions.";
  const cost = "The complete study used 12M input tokens and about 3 USD on one CPU server.";
  const table = "Table 9\nSystem | Solved | 95% CI | Run 2 | Subgroup\nController | 84/100 | [0.76,0.90] | 83/100 | 0.97";
  const pages = Array.from({ length: 20 }, (_, i) => ((i === 0
    ? "Contribution 1: definition.\n" : i === 5 ? "Contribution 2: mechanism.\n" : i === 7 ? "Contribution 3: evaluation.\n"
    : i === 16 ? seeds + "\n" + table + "\n" : i === 18 ? cost + "\n" : "")
    + "Physical page " + i + ": independently supplied engineering source.\n").padEnd(3800, " "));
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 20, totalPages: 20 } });
  let synthesis;
  let sourceCheckAssertion;
  let requests = 0;
  const submitted = [];
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    try {
      requests++;
      const input = parseTaskInput(JSON.parse(options.body).messages[1].content);
      let evidence;
      if (input.stage === "reading") {
        submitted.push(...input.excerpts);
        assert.ok(input.excerpts.every(entry => entry.pageNumber === entry.pageIndex + 1));
        // A plausible incomplete reading summary never returns the reporting facts.
        const source = input.excerpts.find(entry => entry.text.includes("independently supplied"));
        evidence = [{ quote: "independently supplied engineering source.", pageIndex: source.pageIndex }];
      }
      else {
        synthesis = input;
        const checks = input.excerpts.filter(entry => entry.sourceCheckTopic);
        assert.ok(checks.length > 0 && checks.length <= 12);
        assert.ok(checks.some(entry => entry.quote.includes(seeds)));
        assert.ok(checks.some(entry => entry.quote.includes(cost)));
        assert.ok(checks.some(entry => entry.quote.includes(table)));
        assert.ok(checks.some(entry => entry.quote.includes("Contribution 3: evaluation.")));
        assert.ok(checks.some(entry => entry.quote.includes("Contribution 2: mechanism.")));
        assert.ok(checks.every(entry => entry.pageNumber === entry.pageIndex + 1
          && submitted.some(source => source.pageIndex === entry.pageIndex && source.text.includes(entry.quote))));
        assert.ok(input.excerpts.length <= 48);
        assert.ok(input.excerpts.reduce((sum, entry) => sum + entry.quote.length, 0) <= 28000);
        assert.ok(JSON.stringify(input).length <= 48000);
        evidence = [{ quote: seeds, pageIndex: 16 }, { quote: cost, pageIndex: 18 }];
      }
      return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [
        { id: "contributions", summary: "The supplied source reports seeds and total resource costs.", evidence }
      ] }) } }] } };
    } catch (error) { sourceCheckAssertion = error; throw error; }
  };
  let result;
  try { result = await h.service.analyze(h.parent); } catch (error) { throw sourceCheckAssertion || error; }
  assert.equal(requests, 6);
  assert.ok(synthesis);
  assert.equal(result.dimensions[2].summary, "The supplied source reports seeds and total resource costs.");
  assert.ok(result.dimensions[2].evidence.every(entry => entry.verified));
  assert.equal(result.coverage.ratio, 1);
});

test("synthesis budget pressure retains linked late experiments and limits before abundant early figure references", async () => {
  const experiment = "The late experiment measures 0.14 error versus baseline 0.28 under the same compute budget.";
  const failure = "The final failure analysis reports unstable calibration when all targets are occluded.";
  const figures = Array.from({ length: 40 }, (_, index) => "Figure " + (index + 1) + " describes synthetic module " + index + " and its explicit input representation.");
  const pages = Array.from({ length: 20 }, (_, index) =>
    ((index === 0 ? "Abstract\n" : index === 2 ? "Methods\n" : index === 16 ? "Experiments\n" : index === 19 ? "Limitations\n" : "")
      + "Physical page " + index + ". " + (index === 0 ? figures.join("\n") : index === 16 ? experiment : index === 19 ? failure : "Synthetic technical source.")
      + "\n" + ("Source detail on page " + index + ". ").repeat(400)).slice(0, 6000).padEnd(6000, " "));
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 20, totalPages: 20 } });
  let finalInput;
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    const input = parseTaskInput(JSON.parse(options.body).messages[1].content);
    let raw;
    if (input.stage === "reading") {
      const evidence = input.excerpts.slice(0, 3).map(entry => ({ quote: entry.text.slice(0, 320), pageIndex: entry.pageIndex }));
      const evidenceFor = quote => input.excerpts.filter(entry => entry.text.includes(quote)).map(entry => ({ quote, pageIndex: entry.pageIndex }));
      raw = { dimensions: [
        ...["problem", "novelty", "contributions", "prior-work"].map(id => ({ id,
          summary: "Candidate local technical interpretation " + id + '"\\'.repeat(900), evidence })),
        { id: "superiority", summary: "Late comparison with explicit resource conditions.", evidence: evidenceFor(experiment) },
        { id: "technical-uniqueness", summary: "End failure condition limits the mechanism.", evidence: evidenceFor(failure) }
      ], figureTableReferences: figures.flatMap(quote => input.excerpts.filter(entry => entry.text.includes(quote))
        .map(entry => ({ reference: quote.match(/^Figure \d+/)[0], explanation: "Early figure candidate.", quote, pageIndex: entry.pageIndex }))) };
    }
    else {
      finalInput = input;
      raw = { dimensions: [] };
    }
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify(raw) } }] } };
  };
  await h.service.analyze(h.parent);
  assert.ok(JSON.stringify(finalInput).length <= 48000);
  assert.ok(finalInput.excerpts.length <= 48);
  assert.ok(finalInput.excerpts.reduce((sum, entry) => sum + entry.quote.length, 0) <= 28000);
  assert.ok(finalInput.findings.length < 34, "large candidate summaries create real synthesis budget pressure");
  const ids = new Set(finalInput.excerpts.map(entry => entry.id));
  assert.equal(ids.size, finalInput.excerpts.length);
  assert.equal(new Set(finalInput.excerpts.map(entry => entry.pageIndex + ":" + entry.quote)).size, ids.size);
  assert.ok(finalInput.findings.every(entry => entry.evidenceIds.length && entry.evidenceIds.every(id => ids.has(id))));
  assert.ok(finalInput.excerpts.every(entry => entry.sourceCheckTopic
    || finalInput.findings.some(finding => finding.evidenceIds.includes(entry.id))));
  for (const [quote, page, hint] of [[experiment, 16, "experiments"], [failure, 19, "limitations"]]) {
    const excerpt = finalInput.excerpts.find(entry => entry.quote === quote);
    assert.ok(excerpt);
    assert.equal(excerpt.pageIndex, page);
    assert.equal(excerpt.sectionHint, hint);
    assert.ok(excerpt.sourceExcerptId);
    assert.ok(finalInput.findings.some(entry => entry.evidenceIds.includes(excerpt.id)
      && entry.pageIndices.includes(page) && entry.sectionHints.includes(hint)));
  }
  assert.ok(new Set(finalInput.findings.map(entry => entry.packetIndex)).size >= 4);
});

test("reading packets reject wrong physical pages and quotes crossing source excerpt boundaries", async () => {
  const first = "Synthetic observations conclude with a crossing marker.";
  const second = "Another independent method description begins here.";
  const pages = ["Abstract\n" + first + "\nMethods\n" + second,
    "Experiments\nA separate physical page contains a different source observation."];
  const crossing = "a crossing marker.\nMethods\nAnother independent method";
  assert.ok(pages[0].includes(crossing));
  const h = createHarness({ extracted: { text: pages.join("\f"), extractedPages: 2, totalPages: 2 } });
  h.Zotero.HTTP.request = async (_method, _url, options) => {
    const input = parseTaskInput(JSON.parse(options.body).messages[1].content);
    assert.ok(input.excerpts.some(entry => entry.pageIndex === 0 && entry.text.includes(first)));
    assert.ok(!input.excerpts.some(entry => entry.text.includes(crossing)));
    return { status: 200, response: { choices: [{ message: { content: JSON.stringify({ dimensions: [
      { id: "problem", summary: "wrong-page claim", evidence: [{ quote: first, pageIndex: 1 }] },
      { id: "novelty", summary: "cross-excerpt claim", evidence: [{ quote: crossing, pageIndex: 0 }] },
      { id: "contributions", summary: "missing physical-page claim", evidence: [{ quote: first, pageIndex: null }] }
    ] }) } }] } };
  };
  const result = await h.service.analyze(h.parent);
  assert.ok(result.dimensions.slice(0, 3).every(entry => entry.summary === "信息不足" && entry.evidence.length === 0));
});
