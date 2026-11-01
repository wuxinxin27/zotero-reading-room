import fs from "node:fs/promises";
import vm from "node:vm";
import path from "node:path";

const coreSource = await fs.readFile(new URL("../../addon/content/core.js", import.meta.url), "utf8");
const serviceSource = await fs.readFile(new URL("../../addon/content/service.js", import.meta.url), "utf8");
export const paper = JSON.parse(await fs.readFile(new URL("./paper.json", import.meta.url), "utf8"));
export const plain = value => JSON.parse(JSON.stringify(value));

export function parseTaskInput(message) {
  const marker = "\n\nREADING_ROOM_INPUT_JSON:\n\n";
  const start = message.lastIndexOf(marker);
  if (start < 0) throw new Error("Missing explicit task/source boundary");
  return JSON.parse(message.slice(start + marker.length));
}

export function loadCore() {
  const context = vm.createContext({ URL, AbortController, setTimeout, clearTimeout });
  vm.runInContext(coreSource, context, { filename: "core.js" });
  return context.ReadingRoomCore;
}

// All paths, Zotero objects, storage, extraction results, and HTTP replies are synthetic.
// No running Zotero, real profile, database, PDF, or network is consulted by these tests.
export function createHarness({ libraryType = "user", editable = true, files = new Map(), extracted = paper, timers = {}, configured = true, secureStorage = true } = {}) {
  const records = new Map();
  const calls = { extracts: 0, requests: [], noteSaves: 0, writes: [], opened: [], fileChecks: 0 };
  let nextID = 100;
  const library = { libraryID: 1, libraryType, editable };
  const libraries = new Map([[1, library]]);
  const collections = new Map();
  const logins = [];
  const loginStore = {
    async searchLoginsAsync({ origin, httpRealm }) { return logins.filter(login => login.origin === origin && login.httpRealm === httpRealm); },
    async addLoginAsync(login) { logins.push(login); return login; },
    removeLogin(login) { const index = logins.indexOf(login); if (index >= 0) logins.splice(index, 1); }
  };
  class LoginInfo {
    init(origin, formActionOrigin, httpRealm, username, password) { Object.assign(this, { origin, formActionOrigin, httpRealm, username, password }); }
  }
  const parent = {
    id: 1, key: "PAPER001", libraryID: 1, itemTypeID: 1, deleted: false, collections: [],
    fields: { title: "A Synthetic Calibration Study", date: "2025-04-08", DOI: "10.0000/synthetic", publicationTitle: "Synthetic Robotics" },
    isRegularItem() { return true; }, isAttachment() { return false; }, isNote() { return false; },
    isEditable() { return editable; },
    getField(name) { return this.fields[name] || ""; },
    getCreators() { return [{ firstName: "Test", lastName: "Author" }]; },
    inCollection(id) { return this.collections.includes(id); },
    getAttachments() { return Array.from(records.values()).filter(item => item.parentItemID === this.id && item.isAttachment()).map(item => item.id); },
    getNotes() { return Array.from(records.values()).filter(item => item.parentItemID === this.id && item.isNote()).map(item => item.id); }
  };
  const attachment = {
    id: 2, key: "ATTACH01", libraryID: 1, parentItemID: 1, attachmentContentType: "application/pdf", deleted: false,
    localPath: "/synthetic/library/article.pdf",
    isRegularItem() { return false; }, isAttachment() { return true; }, isNote() { return false; },
    getField(name) { return name === "title" ? "Synthetic PDF" : ""; },
    async getFilePathAsync() { calls.fileChecks++; return this.localPath; },
    getAnnotations() { return [{ key: "ANNOT001" }]; }
  };
  records.set(parent.id, parent);
  records.set(attachment.id, attachment);
  files.set(attachment.localPath, "synthetic placeholder, not a PDF");
  const io = {
    failWrite: false,
    async makeDirectory() {},
    async exists(file) { return files.has(file); },
    async readUTF8(file) { if (!files.has(file)) throw new Error("missing synthetic file"); return files.get(file); },
    async writeUTF8(file, content, options) {
      calls.writes.push({ file, content, options });
      if (io.failWrite) throw new Error("synthetic disk failure");
      if (files.has(file) && options.backupFile) files.set(options.backupFile, files.get(file));
      files.set(file, content);
    }
  };
  class Note {
    constructor(type) {
      if (type !== "note") throw new Error("test adapter permits notes only");
      this.id = nextID++;
      this.key = "NOTE" + String(this.id).padStart(4, "0");
      this.html = "";
      this.deleted = false;
    }
    set parentID(value) { this.parentItemID = value; }
    get parentID() { return this.parentItemID; }
    isRegularItem() { return false; }
    isNote() { return true; }
    isAttachment() { return false; }
    getNote() { return this.html; }
    setNote(html) { this.html = html; }
    async saveTx() { calls.noteSaves++; records.set(this.id, this); return this.id; }
  }
  const Zotero = {
    DataDirectory: { dir: "/synthetic/zotero-data" },
    Items: {
      get(id) { return records.get(id); },
      async getAsync(id) { return records.get(id); },
      async getAll(libraryID) { return Array.from(records.values()).filter(item => item.libraryID === libraryID); },
      async getByLibraryAndKeyAsync(libraryID, key) { return Array.from(records.values()).find(item => item.libraryID === libraryID && item.key === key); }
    },
    Libraries: { userLibraryID: 1, get(id) { return libraries.get(id); }, getAll() { return [...libraries.values()]; } },
    Collections: {
      async getAllIDs(libraryID) { return [...collections.values()].filter(collection => collection.libraryID === libraryID).map(collection => collection.id); },
      async getAsync(ids) { return Array.isArray(ids) ? ids.map(id => collections.get(id)).filter(Boolean) : collections.get(ids); }
    },
    OSKeyStore: {
      available: secureStorage,
      isEncrypted(value) { return typeof value === "string" && value.startsWith("oskv1:"); },
      async encrypt(value) { return "oskv1:" + Buffer.from(value).toString("base64"); },
      async decrypt(value) { if (!this.isEncrypted(value)) throw new Error("not encrypted"); return Buffer.from(value.slice(6), "base64").toString(); }
    },
    ItemTypes: { getName() { return "journalArticle"; } },
    Item: Note,
    URI: { getItemURI(item) { return "http://zotero.org/users/local/SYNTHETIC/items/" + item.key; } },
    PDFWorker: { async getFullText() { calls.extracts++; return plain(extracted); } },
    HTTP: {
      async request(method, url, options) {
        calls.requests.push({ method, url, options });
        return { status: 200, response: { choices: [{ message: { content: '{"dimensions":[]}' } }] } };
      }
    },
    Reader: { async open(id, location) { calls.opened.push({ id, location }); return { id, location }; } }
  };
  const context = vm.createContext({ URL, AbortController, setTimeout: timers.setTimeout || setTimeout, clearTimeout: timers.clearTimeout || clearTimeout,
    IOUtils: io, PathUtils: { join: (...parts) => path.posix.join(...parts) },
    Services: secureStorage ? { logins: loginStore } : null,
    Cc: { "@mozilla.org/login-manager/loginInfo;1": { createInstance() { return new LoginInfo(); } } }, Ci: { nsILoginInfo: {} } });
  vm.runInContext(coreSource, context, { filename: "core.js" });
  vm.runInContext(serviceSource, context, { filename: "service.js" });
  const service = new context.ReadingRoomService(Zotero);
  // An explicitly preconfigured synthetic local model keeps unrelated regressions concise.
  if (configured) service._document.aiConfig = { provider: "openai", endpoint: "http://127.0.0.1:11434/v1", model: "demo",
    allowRemoteDiscovery: false, allowRemoteAnalysis: false, consentOrigin: null, rememberKey: false, updatedAt: "2026-01-01T00:00:00Z" };
  return { service, Core: context.ReadingRoomCore, Service: context.ReadingRoomService, Zotero,
    parent, attachment, files, io, records, calls, library, libraries, collections, logins, loginStore, Note,
    statePath: "/synthetic/zotero-data/reading-room/state-v1.json" };
}
