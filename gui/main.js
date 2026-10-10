// main.js – hlavný proces. Neobsahuje vlastnú logiku Batch API: spúšťa overené Python skripty
// (prepare.py, submit.py, collect.py, export_xlsx.py) a ich výstup posiela do okna.
const { app, BrowserWindow, ipcMain, dialog, shell, protocol, net } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const IS_WIN = process.platform === "win32";
const SCRIPTS = new Set(["prepare.py", "sample.py", "submit.py", "collect.py", "export_xlsx.py"]);
const crypto = require("node:crypto");
const EDITABLE = new Set(["prompt.md", "schema.json"]);
const SETTINGS_FILE = () => path.join(app.getPath("userData"), "settings.json");

// API kľúč je LEN v pamäti tohto procesu (alebo z premennej prostredia). Nikdy sa neukladá na disk
// a do okna sa posiela iba informácia, či je nastavený.
let apiKey = process.env.ANTHROPIC_API_KEY || "";
let workspaceId = process.env.ANTHROPIC_WORKSPACE_ID || "";

let win = null;
let current = null;            // { child, script, args, cancellable }

// ---------- nastavenia ----------
function defaults() {
  return {
    toolkitDir: path.resolve(__dirname, ".."),
    workDir: "",
    python: IS_WIN ? "py" : "python3",
  };
}
function loadSettings() {
  try {
    return { ...defaults(), ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), "utf-8")) };
  } catch {
    return defaults();
  }
}
let settings = null;
function saveSettings(patch) {
  const allowed = ["toolkitDir", "workDir", "python"];
  for (const k of allowed) if (typeof patch[k] === "string") settings[k] = patch[k].trim();
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 1), "utf-8");
  return status();
}
function status() {
  const tk = settings.toolkitDir;
  const missing = [...SCRIPTS, "common.py"].filter((f) => !fs.existsSync(path.join(tk, f)));
  return {
    ...settings,
    toolkitOk: missing.length === 0,
    toolkitMissing: missing,
    workOk: !!settings.workDir && fs.existsSync(settings.workDir),
    keySet: !!apiKey,
    keyFromEnv: !!process.env.ANTHROPIC_API_KEY && apiKey === process.env.ANTHROPIC_API_KEY,
    workspaceSet: !!workspaceId,
    platform: process.platform,
  };
}

// cesta vnútri pracovnej zložky (ochrana pred ../)
function inWork(rel) {
  if (!settings.workDir) throw new Error("Nie je zvolená pracovná zložka.");
  const base = path.resolve(settings.workDir);
  const p = path.resolve(base, rel);
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error("Cesta mimo pracovnej zložky.");
  return p;
}

// ---------- spúšťanie skriptov ----------
function send(ch, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, payload);
}

function runScript(script, args) {
  if (!SCRIPTS.has(script)) throw new Error("Neznámy skript.");
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) throw new Error("Zlé argumenty.");
  if (current) throw new Error("Už beží iný príkaz – počkaj, kým skončí.");
  const st = status();
  if (!st.toolkitOk) throw new Error("V zložke toolkitu chýbajú: " + st.toolkitMissing.join(", "));
  if (!st.workOk) throw new Error("Zvoľ existujúcu pracovnú zložku.");

  const env = { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" };
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey; else delete env.ANTHROPIC_API_KEY;
  if (workspaceId) env.ANTHROPIC_WORKSPACE_ID = workspaceId; else delete env.ANTHROPIC_WORKSPACE_ID;

  const full = ["-u", path.join(settings.toolkitDir, script), ...args];
  const child = spawn(settings.python, full, { cwd: settings.workDir, env, windowsHide: true });
  // Odosielanie batchu sa nesmie prerušiť: batch už mohol vzniknúť a opätovné spustenie = dvojitá platba.
  const sending = script === "submit.py" && !args.includes("--dry-run") && !args.includes("--probe-only")
    && !args.includes("--list-models");
  current = { child, script, args, cancellable: !sending };
  const shown = [settings.python, script, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
  send("proc:start", { cmd: shown, cancellable: !sending });

  const dec = (s) => (b) => send("proc:out", { stream: s, text: b.toString("utf-8") });
  child.stdout.on("data", dec("out"));
  child.stderr.on("data", dec("err"));
  child.on("error", (e) => {
    send("proc:out", { stream: "err", text: `Nepodarilo sa spustiť „${settings.python}“: ${e.message}\n` +
      (IS_WIN ? "Je nainštalovaný Python (príkaz py)? Skontroluj v Nastaveniach.\n" : "") });
  });
  child.on("close", (code, signal) => {
    current = null;
    send("proc:exit", { code, signal, script, args });
  });
  return true;
}

function cancelRun() {
  if (!current) return false;
  if (!current.cancellable) throw new Error("Odosielanie batchu sa neprerušuje (hrozí dvojitá platba). Počkaj na koniec.");
  const pid = current.child.pid;
  if (IS_WIN) execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {});
  else current.child.kill("SIGTERM");
  return true;
}

// ---------- súbory pracovnej zložky ----------
function readManifest() {
  const p = inWork(path.join("pages", "manifest.csv"));
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf-8").split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(";");
  return lines.map((l) => {
    const c = l.split(";");
    const r = Object.fromEntries(head.map((h, i) => [h, c[i] ?? ""]));
    r.hires = fs.existsSync(inWork(path.join("pages", `${r.id}_q4.jpg`)));
    return r;
  });
}

function listBatches() {
  if (!status().workOk) return [];
  return fs.readdirSync(settings.workDir)
    .filter((f) => /^batch_.+\.json$/.test(f))
    .map((f) => {
      try {
        const m = JSON.parse(fs.readFileSync(inWork(f), "utf-8"));
        const res = `results_${m.id}.jsonl`, sum = `summary_${m.id}.txt`;
        return {
          id: m.id, model: m.model, created: m.created, hires: !!m.hires, pages: m.pages || [],
          results: fs.existsSync(inWork(res)) ? res : "",
          summary: fs.existsSync(inWork(sum)) ? fs.readFileSync(inWork(sum), "utf-8") : "",
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// výsledky batchu (results_<id>.jsonl) alebo skúšky (sample_<čas>.jsonl)
function readResults(file) {
  if (!/^(results|sample)_[A-Za-z0-9_-]+\.jsonl$/.test(file)) throw new Error("Zlý názov súboru výsledkov.");
  const p = inWork(file);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, "utf-8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
    .sort((a, b) => a.custom_id.localeCompare(b.custom_id));
}

// posledná skúška + či ešte platí (rovnaký prompt a schéma ako teraz)
function fileSha(name) {
  let p = status().workOk ? inWork(name) : "";
  if (!p || !fs.existsSync(p)) p = path.join(settings.toolkitDir, name);
  return fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") : "";
}
function lastSample() {
  if (!status().workOk) return null;
  const f = fs.readdirSync(settings.workDir).filter((x) => /^sample_\d{8}_\d{6}\.json$/.test(x)).sort().pop();
  if (!f) return null;
  try {
    const m = JSON.parse(fs.readFileSync(inWork(f), "utf-8"));
    m.meta = f;
    m.promptChanged = m.prompt_sha !== fileSha("prompt.md");
    m.schemaChanged = m.schema_sha !== fileSha("schema.json");
    return m;
  } catch {
    return null;
  }
}

// cenník berieme priamo z common.py, aby bol na jednom mieste
function readPrices() {
  try {
    const src = fs.readFileSync(path.join(settings.toolkitDir, "common.py"), "utf-8");
    const block = src.slice(src.indexOf("PRICES"), src.indexOf("}", src.indexOf("PRICES")));
    const out = {};
    for (const m of block.matchAll(/"([^"]+)"\s*:\s*\(\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/g)) out[m[1]] = [+m[2], +m[3]];
    const bf = src.match(/BATCH_FACTOR\s*=\s*([\d.]+)/);
    return { prices: out, batchFactor: bf ? +bf[1] : 0.5 };
  } catch {
    return { prices: {}, batchFactor: 0.5 };
  }
}

function readEditable(name) {
  if (!EDITABLE.has(name)) throw new Error("Tento súbor sa tu neupravuje.");
  if (status().workOk && fs.existsSync(inWork(name))) return { text: fs.readFileSync(inWork(name), "utf-8"), from: "work" };
  const t = path.join(settings.toolkitDir, name);
  if (fs.existsSync(t)) return { text: fs.readFileSync(t, "utf-8"), from: "toolkit" };
  return { text: "", from: "none" };
}

function writeEditable(name, text) {
  if (!EDITABLE.has(name)) throw new Error("Tento súbor sa tu neupravuje.");
  if (typeof text !== "string") throw new Error("Zlý obsah.");
  if (name === "schema.json") {
    let j;
    try { j = JSON.parse(text); } catch (e) { throw new Error("schema.json nie je platný JSON: " + e.message); }
    if (j.type !== "object" || typeof j.properties !== "object") throw new Error("Schéma musí mať \"type\": \"object\" a \"properties\".");
  }
  fs.writeFileSync(inWork(name), text, "utf-8");
  return true;
}

// ---------- IPC ----------
function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...a) => {
    try { return { ok: true, value: await fn(...a) }; }
    catch (e) { return { ok: false, error: e.message }; }
  });
}

handle("status", () => status());
handle("settings:save", (patch) => saveSettings(patch || {}));
handle("dialog:dir", async (title) => {
  const r = await dialog.showOpenDialog(win, { title: String(title || "Vyber zložku"), properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? "" : r.filePaths[0];
});
handle("key:set", (key, ws) => {
  if (typeof key === "string") apiKey = key.trim();
  if (typeof ws === "string") workspaceId = ws.trim();
  return status();
});
handle("run", (script, args) => runScript(script, args));
handle("cancel", () => cancelRun());
handle("manifest", () => readManifest());
handle("batches", () => listBatches());
handle("results", (file) => readResults(file));
handle("sample:last", () => lastSample());
handle("prices", () => readPrices());
handle("file:read", (name) => readEditable(name));
handle("file:write", (name, text) => writeEditable(name, text));
handle("pilot:read", () => {
  const p = inWork("pilot.txt");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf-8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : [];
});
handle("pilot:write", (ids) => {
  if (!Array.isArray(ids) || !ids.every((i) => /^[A-Za-z0-9_-]+$/.test(i))) throw new Error("Zlé id strán.");
  fs.writeFileSync(inWork("pilot.txt"), ids.join("\n") + "\n", "utf-8");
  return ids.length;
});
handle("exists", (rel) => fs.existsSync(inWork(rel)));
handle("open", async (rel) => {
  const err = await shell.openPath(inWork(rel || "."));
  if (err) throw new Error(err);
  return true;
});

// ---------- okno ----------
protocol.registerSchemesAsPrivileged([{ scheme: "pages", privileges: { standard: true, secure: true } }]);

app.whenReady().then(() => {
  settings = loadSettings();

  // obrázky strán z <pracovná zložka>/pages – len súbory .jpg, nič iné
  protocol.handle("pages", (req) => {
    const name = decodeURIComponent(new URL(req.url).pathname).replace(/^\/+/, "");
    if (!/^[A-Za-z0-9_-]+\.jpg$/.test(name) || !settings.workDir) return new Response("", { status: 404 });
    return net.fetch(pathToFileURL(path.join(settings.workDir, "pages", name)).toString());
  });

  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    title: "Batch API – dotazníky",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.on("close", (e) => {
    if (current && !current.cancellable) {
      e.preventDefault();
      dialog.showMessageBox(win, { type: "warning", message: "Práve sa odosiela batch. Zavri aplikáciu až po jeho dokončení." });
    }
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
});

app.on("window-all-closed", () => {
  if (current) cancelRun();
  app.quit();
});
