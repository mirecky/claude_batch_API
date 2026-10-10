// preload.js – jediný most medzi oknom a hlavným procesom; okno nemá prístup k Node.js.
const { contextBridge, ipcRenderer } = require("electron");

const call = async (ch, ...a) => {
  const r = await ipcRenderer.invoke(ch, ...a);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

contextBridge.exposeInMainWorld("api", {
  status: () => call("status"),
  saveSettings: (patch) => call("settings:save", patch),
  pickDir: (title) => call("dialog:dir", title),
  pickFile: (title) => call("dialog:file", title),
  setKey: (key, ws) => call("key:set", key, ws),
  run: (script, args) => call("run", script, args),
  cancel: () => call("cancel"),
  manifest: () => call("manifest"),
  batches: () => call("batches"),
  results: (file) => call("results", file),
  lastSample: () => call("sample:last"),
  prices: () => call("prices"),
  readFile: (name) => call("file:read", name),
  writeFile: (name, text) => call("file:write", name, text),
  readPilot: () => call("pilot:read"),
  writePilot: (ids) => call("pilot:write", ids),
  exists: (rel) => call("exists", rel),
  open: (rel) => call("open", rel),
  onStart: (fn) => ipcRenderer.on("proc:start", (_e, d) => fn(d)),
  onOut: (fn) => ipcRenderer.on("proc:out", (_e, d) => fn(d)),
  onExit: (fn) => ipcRenderer.on("proc:exit", (_e, d) => fn(d)),
});
