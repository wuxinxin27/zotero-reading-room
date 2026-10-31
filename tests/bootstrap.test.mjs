import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const source = await fs.readFile(new URL("../addon/bootstrap.js", import.meta.url), "utf8");

function fixture(initializationPromise = Promise.resolve(), failScript = false) {
  const calls = { registered: 0, destroyed: 0, removed: 0 };
  const windows = [0, 1].map(() => ({ document: {
    querySelectorAll: () => [{ remove() { calls.removed++; } }],
  } }));
  const context = vm.createContext({
    Zotero: { initializationPromise, debug() {}, getMainWindows: () => windows,
      getMainWindow: () => windows[0] },
    Components: { classes: { "@mozilla.org/addons/addon-manager-startup;1": {
      getService: () => ({ registerChrome() { calls.registered++;
        return { destruct() { calls.destroyed++; } }; } }),
    } }, interfaces: {} },
    Services: { io: { newURI: value => value }, scriptloader: {
      loadSubScriptWithOptions() { if (failScript) throw new Error("synthetic load failure"); },
    } },
    ChromeUtils: { importESModule: () => ({}) },
  });
  vm.runInContext(source, context);
  return { context, calls, lifecycle: context.ReadingRoomBootstrap };
}

test("disabling during host initialization does not register chrome later", async () => {
  let resume;
  const { lifecycle, calls } = fixture(new Promise(resolve => { resume = resolve; }));
  const starting = lifecycle.startup({ id: "test", version: "0.1.0", rootURI: "file:///test/" });
  await lifecycle.shutdown();
  resume();
  await starting;
  assert.equal(calls.registered, 0);
  assert.equal(lifecycle.sharedScope, null);
});

test("startup failure releases chrome and publishes an error state", async () => {
  const { lifecycle, context, calls } = fixture(Promise.resolve(), true);
  await lifecycle.startup({ id: "test", version: "0.1.0", rootURI: "file:///test/" });
  assert.equal(calls.registered, 1);
  assert.equal(calls.destroyed, 1);
  assert.equal(lifecycle.chromeHandle, null);
  assert.equal(lifecycle.sharedScope, null);
  assert.equal(context.Zotero.ReadingRoom.status, "error");
});

test("shutdown removes locale links from every main window and is repeatable", async () => {
  const { lifecycle, calls } = fixture();
  await lifecycle.shutdown();
  assert.equal(calls.removed, 2);
  await lifecycle.shutdown();
  assert.equal(lifecycle.chromeHandle, null);
});
