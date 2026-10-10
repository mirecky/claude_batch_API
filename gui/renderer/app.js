// app.js – logika okna. Všetko, čo príde z modelu alebo zo súborov, sa vkladá ako text (nikdy ako HTML).
"use strict";
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const MODELS = [
  ["claude-sonnet-5-5", "tlačené a bežne čitateľné strany – predvolený"],
  ["claude-fable-5-1", "zlý rukopis; najlepšie s --hires (drahší)"],
  ["claude-haiku-5-5", "jednoduché formuláre, zaškrtávanie"],
];
// hrubý odhad tokenov na stranu pred skúškou (z overených behov v README); presné čísla dá až skúška
const TYPICAL = { false: { in: 2800, out: 1600 }, true: { in: 11800, out: 5200 } };

const S = { st: null, manifest: [], pilot: [], prices: {}, batchFactor: 0.5, sample: null, sampleRows: [],
  batches: [], running: false, out: "", sel: new Set(), file: "prompt.md", onExit: null };

// ---------- pomocné ----------
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) e.append(k instanceof Node ? k : String(k));
  return e;
}
// 1 strana, 2–4 strany, 0 a 5+ strán
function strany(n) { return `${n} ${n === 1 ? "strana" : n >= 2 && n <= 4 ? "strany" : "strán"}`; }
function usd(x) { return x == null ? "–" : x < 0.1 ? `${x.toFixed(3)} USD` : `${x.toFixed(2)} USD`; }
function priceFor(model) {
  const hits = Object.keys(S.prices).filter((k) => model.startsWith(k));
  return hits.length ? S.prices[hits.sort((a, b) => b.length - a.length)[0]] : null;
}
function log(text, cls) {
  const box = $("#log");
  const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
  box.append(cls ? el("span", { class: cls }, text) : document.createTextNode(text));
  if (box.childNodes.length > 4000) box.firstChild.remove();
  if (atEnd) box.scrollTop = box.scrollHeight;
}
async function guard(fn) {
  try { return await fn(); }
  catch (e) { log(`\n✖ ${e.message}\n`, "err"); alert(e.message); }
}
// text so zvýraznenými značkami [?] a [...]
function marked(text) {
  const frag = document.createDocumentFragment();
  String(text ?? "").split(/(\[\?\]|\[\.\.\.\]|\[…\])/).forEach((p, i) => frag.append(i % 2 ? el("mark", {}, p) : p));
  return frag;
}

// ---------- spúšťanie ----------
function setRunning(on) {
  S.running = on;
  $$(".needs-idle").forEach((b) => (b.disabled = on || b.dataset.blocked === "1"));
}
function run(script, args) {
  return new Promise(async (resolve) => {
    S.out = "";
    S.onExit = resolve;
    try { await window.api.run(script, args); }
    catch (e) { S.onExit = null; log(`\n✖ ${e.message}\n`, "err"); alert(e.message); resolve({ code: -1, out: "" }); }
  });
}
window.api.onStart(({ cmd, cancellable }) => {
  setRunning(true);
  $("#runState").className = "state busy"; $("#runState").textContent = "beží";
  $("#runCmd").textContent = cmd;
  $("#cancelRun").disabled = !cancellable;
  $("#cancelRun").title = cancellable ? "" : "Odosielanie batchu sa neprerušuje";
  log(`\n> ${cmd}\n`, "sys");
});
window.api.onOut(({ stream, text }) => { S.out += text; log(text, stream === "err" ? "err" : null); });
window.api.onExit(({ code, signal }) => {
  setRunning(false);
  $("#cancelRun").disabled = true;
  const ok = code === 0;
  $("#runState").className = `state ${ok ? "ok" : "bad"}`;
  $("#runState").textContent = ok ? "hotovo" : signal ? "zrušené" : `chyba (${code})`;
  log(ok ? "✔ hotovo\n" : `✖ skončilo s chybou (${signal || code})\n`, ok ? "sys" : "err");
  const f = S.onExit; S.onExit = null;
  if (f) f({ code, out: S.out });
});
$("#cancelRun").onclick = () => guard(() => window.api.cancel());
$("#clearLog").onclick = () => ($("#log").textContent = "");

// ---------- navigácia ----------
$$(".side button").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));
function showTab(name) {
  $$(".side button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  $$(".tab").forEach((x) => x.classList.toggle("active", x.id === `tab-${name}`));
  if (name === "prepare") loadPages();
  if (name === "task") loadFile(S.file);
  if (name === "run") refreshRun();
  if (name === "results") loadBatches();
}

// ---------- 1 nastavenia ----------
async function refreshStatus() {
  const st = (S.st = await window.api.status());
  $("#toolkitDir").value = st.toolkitDir;
  $("#workDir").value = st.workDir;
  $("#python").value = st.python;
  $("#toolkitInfo").textContent = st.toolkitOk ? "Skripty nájdené." : `Chýba: ${st.toolkitMissing.join(", ")}`;
  $("#toolkitInfo").style.color = st.toolkitOk ? "" : "var(--err)";
  $("#keyInfo").textContent = st.keySet
    ? `Kľúč je nastavený${st.keyFromEnv ? " (z premennej prostredia)" : ""}.${st.workspaceSet ? " Workspace ID je nastavené." : ""}`
    : "Kľúč nie je nastavený – skúška ani odoslanie nepôjdu (príprava strán a export áno).";
  const chip = (id, ok, text) => { const c = $(id); c.className = `chip ${ok ? "ok" : "bad"}`; c.textContent = text; };
  chip("#chip-toolkit", st.toolkitOk, st.toolkitOk ? "toolkit ✓" : "toolkit ✗");
  chip("#chip-work", st.workOk, st.workOk ? "pracovná zložka ✓" : "pracovná zložka ✗");
  chip("#chip-key", st.keySet, st.keySet ? "API kľúč ✓" : "API kľúč ✗");
  try { const p = await window.api.prices(); S.prices = p.prices; S.batchFactor = p.batchFactor; } catch {}
  return st;
}
$("#pickToolkit").onclick = () => guard(async () => {
  const d = await window.api.pickDir("Zložka so skriptmi (submit.py, collect.py…)");
  if (d) { await window.api.saveSettings({ toolkitDir: d }); await refreshStatus(); }
});
$("#pickWork").onclick = () => guard(async () => {
  const d = await window.api.pickDir("Pracovná zložka");
  if (d) { await window.api.saveSettings({ workDir: d }); await refreshStatus(); }
});
$("#openWork").onclick = () => guard(() => window.api.open("."));
$("#savePython").onclick = () => guard(async () => { await window.api.saveSettings({ python: $("#python").value }); await refreshStatus(); });
$("#saveKey").onclick = () => guard(async () => {
  const k = $("#apiKey").value.trim();
  if (k && !k.startsWith("sk-ant-")) throw new Error("Kľúč by mal začínať „sk-ant-“.");
  await window.api.setKey(k || undefined, $("#workspaceId").value);
  $("#apiKey").value = "";
  await refreshStatus();
});
$("#clearKey").onclick = () => guard(async () => { await window.api.setKey("", ""); $("#workspaceId").value = ""; await refreshStatus(); });
$("#listModels").onclick = () => guard(async () => {
  const r = await run("submit.py", ["--list-models"]);
  if (r.code !== 0) return;
  const found = [...r.out.matchAll(/^(claude-\S+)/gm)].map((m) => m[1]);
  fillModels(found);
  log(`Do zoznamu modelov pridaných: ${found.length}\n`, "sys");
});
function fillModels(extra = []) {
  const sel = $("#model"), cur = sel.value || "claude-sonnet-5-5";
  sel.textContent = "";
  const seen = new Set();
  for (const [id, hint] of MODELS) { sel.append(el("option", { value: id }, id)); seen.add(id); }
  for (const id of extra) if (!seen.has(id)) { sel.append(el("option", { value: id }, id)); seen.add(id); }
  sel.value = seen.has(cur) ? cur : "claude-sonnet-5-5";
}

// ---------- 2 príprava strán ----------
$("#pickPdf").onclick = () => guard(async () => { const d = await window.api.pickDir("Zložka s PDF"); if (d) $("#pdfDir").value = d; });
$("#runPrepare").onclick = () => guard(async () => {
  const dir = $("#pdfDir").value;
  if (!dir) throw new Error("Najprv vyber zložku s PDF.");
  const args = [dir];
  if ($("#prepHires").checked) args.push("--hires");
  const dpi = parseInt($("#prepDpi").value, 10);
  if (dpi > 0) args.push("--dpi", String(dpi));
  const r = await run("prepare.py", args);
  if (r.code === 0) await loadPages();
});
$("#reloadPages").onclick = () => loadPages();
$("#pdfFilter").onchange = () => renderGrid();
async function loadPages() {
  if (!S.st?.workOk) { $("#grid").textContent = "Najprv zvoľ pracovnú zložku (Nastavenia)."; return; }
  S.manifest = await window.api.manifest();
  S.pilot = await window.api.readPilot();
  S.sel = new Set(S.pilot);
  const pdfs = [...new Set(S.manifest.map((r) => r.pdf))];
  const f = $("#pdfFilter"), cur = f.value;
  f.textContent = "";
  f.append(el("option", { value: "" }, `všetky PDF (${pdfs.length})`));
  for (const p of pdfs) f.append(el("option", { value: p }, p.split(/[\\/]/).pop()));
  f.value = pdfs.includes(cur) ? cur : "";
  const hires = S.manifest.filter((r) => r.hires).length;
  $("#pageCount").textContent = S.manifest.length ? `– ${strany(S.manifest.length)}, so štvrtinami (hires) ${hires}` : "";
  renderGrid();
}
function renderGrid() {
  const g = $("#grid"), only = $("#pdfFilter").value;
  g.textContent = "";
  if (!S.manifest.length) { g.textContent = "Zatiaľ nie sú pripravené žiadne strany."; return; }
  const v = Date.now();
  for (const r of S.manifest.filter((x) => !only || x.pdf === only)) {
    const t = el("div", { class: `thumb${S.sel.has(r.id) ? " sel" : ""}`, title: `${r.pdf}, strana ${r.strana}` },
      el("img", { src: `pages://img/${r.id}_full.jpg?v=${v}`, loading: "lazy", alt: r.id }),
      el("div", {}, r.id));
    t.onclick = () => { S.sel.has(r.id) ? S.sel.delete(r.id) : S.sel.add(r.id); t.classList.toggle("sel"); $("#selCount").textContent = S.sel.size; };
    t.ondblclick = () => openViewer(null, [{ custom_id: r.id }], 0);
    g.append(t);
  }
  $("#selCount").textContent = S.sel.size;
}
$("#savePilot").onclick = () => guard(async () => {
  const order = S.manifest.map((r) => r.id).filter((id) => S.sel.has(id));
  if (!order.length) throw new Error("Nie je vybraná žiadna strana.");
  const n = await window.api.writePilot(order);
  S.pilot = order;
  log(`Uložené do pilot.txt: ${strany(n)}\n`, "sys");
  document.querySelector('input[name="sampleSrc"][value="pilot"]').checked = true;
});
$("#clearSel").onclick = () => { S.sel.clear(); renderGrid(); };

// ---------- 3 zadanie ----------
$$(".subtab").forEach((b) => (b.onclick = () => loadFile(b.dataset.file)));
async function loadFile(name) {
  S.file = name;
  $$(".subtab").forEach((b) => b.classList.toggle("active", b.dataset.file === name));
  await guard(async () => {
    const r = await window.api.readFile(name);
    $("#editor").value = r.text;
    $("#fileFrom").textContent = { work: "z pracovnej zložky", toolkit: "šablóna z toolkitu – uložením sa skopíruje do pracovnej zložky", none: "súbor neexistuje" }[r.from];
  });
}
$("#saveFile").onclick = () => guard(async () => {
  await window.api.writeFile(S.file, $("#editor").value);
  $("#fileFrom").textContent = "uložené do pracovnej zložky";
  log(`Uložené: ${S.file}\n`, "sys");
});

// ---------- 4 skúška a spustenie ----------
function runCfg() {
  return { model: $("#model").value, hires: $("#runHires").checked, maxTokens: parseInt($("#maxTokens").value, 10) || 8000 };
}
function cfgArgs(c) {
  const a = ["--model", c.model, "--max-tokens", String(c.maxTokens)];
  if (c.hires) a.push("--hires");
  return a;
}
function usablePages(hires) { return S.manifest.filter((r) => !hires || r.hires).length; }

async function refreshRun() {
  if (S.st?.workOk) {
    S.manifest = await window.api.manifest();
    S.pilot = await window.api.readPilot();
    S.batches = await window.api.batches();
    S.sample = await window.api.lastSample();
    S.sampleRows = S.sample ? await window.api.results(S.sample.file).catch(() => []) : [];
  }
  $("#pilotCount").textContent = S.pilot.length;
  updateRunHints();
  renderSample();
}
["#model", "#runHires", "#maxTokens", "#sampleN"].forEach((s) => $(s).addEventListener("input", () => { updateRunHints(); renderSample(); }));
$$('input[name="sampleSrc"]').forEach((r) => r.addEventListener("change", updateRunHints));

function updateRunHints() {
  const c = runCfg();
  $("#modelHint").textContent = (MODELS.find((m) => m[0] === c.model) || [, ""])[1];
  const hiresN = S.manifest.filter((r) => r.hires).length;
  $("#hiresHint").textContent = !S.manifest.length ? "Strany ešte nie sú pripravené."
    : hiresN ? `Štvrtiny má ${hiresN} z ${S.manifest.length} strán.` : "Štvrtiny nie sú pripravené – v kroku 2 zaškrtni --hires.";
  const src = document.querySelector('input[name="sampleSrc"]:checked').value;
  const n = src === "pilot" ? S.pilot.length : Math.min(parseInt($("#sampleN").value, 10) || 0, usablePages(c.hires));
  const p = priceFor(c.model), t = TYPICAL[c.hires];
  const rough = p ? (n * (t.in * p[0] + t.out * p[1])) / 1e6 : null;
  $("#sampleHint").textContent = `Skúška ide cez okamžité API za plnú cenu (bez zľavy), výsledok je o chvíľu. `
    + `${strany(n)}, približne ${usd(rough)}. Pred ostrým behom vždy skontroluj výsledky skúšky.`;
}

$("#runSample").onclick = () => guard(async () => {
  if (!S.st?.keySet) throw new Error("Najprv zadaj API kľúč (Nastavenia).");
  if (!S.manifest.length) throw new Error("Najprv priprav strany (krok 2).");
  const c = runCfg();
  const src = document.querySelector('input[name="sampleSrc"]:checked').value;
  const args = src === "pilot" ? ["--list", "pilot.txt"] : ["--n", String(parseInt($("#sampleN").value, 10) || 5)];
  if (src === "pilot" && !S.pilot.length) throw new Error("Nie sú vybrané žiadne skúšobné strany (krok 2).");
  await run("sample.py", [...args, ...cfgArgs(c)]);
  await refreshRun();
});

function sampleProblems() {
  const s = S.sample, c = runCfg(), why = [];
  if (!s) return ["Chýba skúška."];
  if (s.model !== c.model) why.push(`skúška bola s modelom ${s.model}, teraz je zvolený ${c.model}`);
  if (!!s.hires !== c.hires) why.push(`skúška bola ${s.hires ? "s" : "bez"} --hires`);
  if (s.max_tokens !== c.maxTokens) why.push(`skúška mala max. tokenov ${s.max_tokens}`);
  if (s.promptChanged) why.push("prompt.md sa od skúšky zmenil");
  if (s.schemaChanged) why.push("schema.json sa od skúšky zmenila");
  if (s.total_pages !== usablePages(c.hires)) why.push(`počet strán sa zmenil (${s.total_pages} → ${usablePages(c.hires)})`);
  return why;
}

function renderSample() {
  const s = S.sample;
  $("#sampleEmpty").hidden = !!s;
  $("#sampleBox").hidden = !s;
  const approve = $("#approve");
  if (!s) { approve.dataset.blocked = "1"; approve.disabled = true; return; }
  const c = runCfg(), N = usablePages(c.hires);
  $("#estPages").textContent = strany(N);
  $("#estCost").textContent = s.page_cost_batch != null ? usd(s.page_cost_batch * N) : "nie je v cenníku";
  $("#estAvg").textContent = `${s.avg_in.toLocaleString("sk")} / ${s.avg_out.toLocaleString("sk")} tok.`;
  $("#estSample").textContent = usd(s.sample_cost);
  $("#sampleMeta").textContent = `Skúška ${s.created} · ${s.model} · ${s.hires ? "s hires" : "bez hires"} · max. ${s.max_tokens} tokenov · `
    + `v poriadku ${s.ok} z ${s.pages.length}. Odhad = priemer zo skúšky × počet strán × ${s.batch_factor} (batch). Presnú sumu over v konzole.`;

  const tb = $("#sampleTable tbody");
  tb.textContent = "";
  S.sampleRows.forEach((r, i) => {
    const d = r.data || {};
    const answers = Array.isArray(d.answers) ? d.answers : [];
    const unc = Array.isArray(d.uncertain) ? d.uncertain.length : 0;
    const bad = r.error || !r.data, warn = r.note || unc;
    const badge = bad ? el("span", { class: "badge bad" }, r.error ? "chyba" : "bez dát")
      : warn ? el("span", { class: "badge warn" }, r.note || `neisté: ${unc}`) : el("span", { class: "badge ok" }, "OK");
    tb.append(el("tr", { class: "click", onclick: () => openViewer(S.sample.file, S.sampleRows, i) },
      el("td", {}, r.custom_id), el("td", {}, r.usage?.in ?? "–"), el("td", {}, r.usage?.out ?? "–"),
      el("td", {}, badge), el("td", {}, d.student_name || ""),
      el("td", {}, answers.length ? `${answers.filter((a) => a.answered).length} / ${answers.length}` : "")));
  });

  const why = sampleProblems();
  const issues = S.sampleRows.filter((r) => r.error || !r.data || r.note).length;
  const w = $("#sampleWarn");
  const msgs = [];
  if (why.length) msgs.push("Skúška už nezodpovedá nastaveniu: " + why.join("; ") + ". Spusti novú skúšku.");
  if (issues) msgs.push(`Problém zo skúšky: ${strany(issues)} – pozri tabuľku. Odporúčam najprv upraviť nastavenie (napr. max. tokenov, --hires, model).`);
  w.hidden = !msgs.length;
  w.textContent = msgs.join(" ");
  approve.dataset.blocked = why.length || !s.ok ? "1" : "0";
  approve.disabled = S.running || approve.dataset.blocked === "1";
  approve.textContent = `✔ Schváliť a spustiť dávku – ${strany(N)}, ~${s.page_cost_batch != null ? usd(s.page_cost_batch * N) : "?"}`;
}

$("#approve").onclick = () => guard(async () => {
  if (!S.st?.keySet) throw new Error("Najprv zadaj API kľúč (Nastavenia).");
  const s = S.sample, c = runCfg(), N = usablePages(c.hires);
  if (sampleProblems().length) throw new Error("Skúška nezodpovedá nastaveniu – spusti novú skúšku.");
  const cost = s.page_cost_batch != null ? usd(s.page_cost_batch * N) : "neznámy";
  const today = new Date().toISOString().slice(0, 10);
  const dup = S.batches.find((b) => b.model === c.model && b.pages.length === N && String(b.created).startsWith(today));
  let msg = `Odoslať dávku?\n\nStrán: ${N}\nModel: ${c.model}${c.hires ? " + hires" : ""}\nOdhad ceny: ${cost}\n\n`
    + `Odosielanie sa nedá prerušiť. Výsledok zvyčajne do niekoľkých minút, najneskôr do 24 h.`;
  if (dup) msg += `\n\n⚠ POZOR: dnes (${dup.created}) už bola odoslaná dávka s rovnakým modelom a počtom strán (${dup.id}). `
    + `Ak ju odošleš znova, zaplatíš dvakrát.`;
  if (!confirm(msg)) return;
  const r = await run("submit.py", ["--all", "--skip-probe", ...cfgArgs(c)]);
  const ids = [...r.out.matchAll(/ODOSLANÉ \d+\/\d+\s+id=(\S+)/g)].map((m) => m[1]);
  if (!ids.length) return;
  showTab("results");
  if (confirm(`Odoslané: ${ids.join(", ")}\n\nMám počkať na dokončenie a výsledky stiahnuť automaticky?`)) {
    for (const id of ids) { const x = await run("collect.py", [id, "--wait"]); if (x.code !== 0) break; }
    await loadBatches();
  }
});

// ---------- 5 výsledky ----------
$("#reloadBatches").onclick = () => loadBatches();
$("#serverList").onclick = () => guard(() => run("collect.py", []));
async function loadBatches() {
  if (!S.st?.workOk) return;
  S.batches = await window.api.batches();
  const tb = $("#batchTable tbody");
  tb.textContent = "";
  $("#batchEmpty").hidden = S.batches.length > 0;
  for (const b of S.batches) {
    const act = el("td", {},
      el("button", { class: "needs-idle", onclick: () => guard(async () => { await run("collect.py", [b.id]); await loadBatches(); }) }, "Stav / stiahnuť"),
      " ",
      el("button", { class: "needs-idle", onclick: () => guard(async () => { await run("collect.py", [b.id, "--wait"]); await loadBatches(); }) }, "Čakať a stiahnuť"),
      " ",
      b.results ? el("button", { onclick: () => guard(async () => openViewer(b.results, await window.api.results(b.results), 0)) }, "Prezrieť") : null);
    tb.append(el("tr", { title: b.summary || "" },
      el("td", {}, b.created), el("td", {}, el("code", {}, b.id)), el("td", {}, b.model + (b.hires ? " + hires" : "")),
      el("td", {}, b.pages.length),
      el("td", {}, b.results ? el("span", { class: "badge ok" }, "stiahnuté") : el("span", { class: "badge warn" }, "nestiahnuté")),
      act));
  }
  setRunning(S.running);
}
$("#runExport").onclick = () => guard(async () => {
  const name = $("#xlsxName").value.trim() || "vysledky.xlsx";
  if (!/^[^\\/:*?"<>|]+\.xlsx$/i.test(name)) throw new Error("Názov súboru musí končiť .xlsx a nesmie obsahovať cestu.");
  const args = ["--out", name];
  const rows = $("#xlsxRows").value.trim();
  if (rows) args.push("--rows", rows);
  await run("export_xlsx.py", args);
});
$("#openXlsx").onclick = () => guard(() => window.api.open($("#xlsxName").value.trim() || "vysledky.xlsx"));

// ---------- prehliadač: originál vedľa vyťažených údajov ----------
const V = { rows: [], i: 0, file: null };
function openViewer(file, rows, i) {
  Object.assign(V, { file, rows, i });
  $("#viewer").hidden = false;
  showRow();
}
function showRow() {
  const r = V.rows[V.i];
  $("#vTitle").textContent = r.custom_id + (V.file ? ` – ${V.file}` : "");
  $("#vPos").textContent = `${V.i + 1} / ${V.rows.length}`;
  $("#vImg").src = `pages://img/${r.custom_id}_full.jpg`;
  const box = $("#vData");
  box.textContent = "";
  if (!V.file) { box.append(el("p", { class: "muted" }, "Strana ešte nebola spracovaná.")); return; }
  if (r.error) box.append(el("div", { class: "warn" }, "Chyba: " + r.error));
  if (r.note) box.append(el("div", { class: "warn" }, "Upozornenie: " + r.note));
  const d = r.data;
  if (!d) { box.append(el("p", { class: "muted" }, "Bez dát.")); return; }
  const kv = el("div", { class: "kv" });
  for (const [k, v] of Object.entries(d)) if (!Array.isArray(v) && typeof v !== "object" && k !== "page_transcription")
    kv.append(el("span", {}, k), el("span", {}, marked(v === true ? "áno" : v === false ? "nie" : v)));
  if (r.usage) kv.append(el("span", {}, "tokeny"), el("span", {}, `in ${r.usage.in}, out ${r.usage.out}`));
  box.append(kv);
  for (const [k, v] of Object.entries(d)) {
    if (!Array.isArray(v)) continue;
    box.append(el("h3", {}, `${k} (${v.length})`));
    if (!v.length) continue;
    const cols = [...new Set(v.flatMap((x) => (x && typeof x === "object" ? Object.keys(x) : ["hodnota"])))];
    const t = el("table", { class: "tbl" }, el("thead", {}, el("tr", {}, cols.map((c) => el("th", {}, c)))));
    const tb = el("tbody");
    for (const x of v) {
      const o = x && typeof x === "object" ? x : { hodnota: x };
      tb.append(el("tr", {}, cols.map((c) => {
        const val = o[c];
        return el("td", {}, marked(val === true ? "áno" : val === false ? "nie" : Array.isArray(val) ? val.join(" | ") : val ?? ""));
      })));
    }
    t.append(tb);
    box.append(t);
  }
  if (d.page_transcription) box.append(el("h3", {}, "Prepis strany"), el("pre", {}, marked(d.page_transcription)));
}
$("#vPrev").onclick = () => { if (V.i > 0) { V.i--; showRow(); } };
$("#vNext").onclick = () => { if (V.i < V.rows.length - 1) { V.i++; showRow(); } };
$("#vClose").onclick = () => ($("#viewer").hidden = true);
document.addEventListener("keydown", (e) => {
  if ($("#viewer").hidden) return;
  if (e.key === "Escape") $("#vClose").click();
  if (e.key === "ArrowLeft") $("#vPrev").click();
  if (e.key === "ArrowRight") $("#vNext").click();
});

// ---------- štart ----------
(async () => {
  fillModels();
  const st = await refreshStatus();
  if (!st.workOk || !st.toolkitOk) showTab("settings");
  else if (!st.keySet) showTab("settings");
  else showTab("run");
})();
