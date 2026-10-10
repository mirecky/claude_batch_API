"""collect.py – stav batchu a stiahnutie výsledkov.

Použitie:
  py collect.py                     # zoznam posledných batchov a ich stav
  py collect.py <id>                # stav; ak je hotový, stiahne výsledky
  py collect.py <id> --wait         # čaká (kontrola každú minútu) a potom stiahne
Výstup:  results_<id>.jsonl  (riadok = 1 strana: custom_id, usage, data | error)
         summary_<id>.txt    (počty, tokeny, odhad ceny)
"""
import sys, argparse, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import make_client, price_for, BATCH_FACTOR, normalize

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("batch_id", nargs="?")
    ap.add_argument("--wait", action="store_true")
    a = ap.parse_args()
    c = make_client()
    if not a.batch_id:
        for b in c.messages.batches.list(limit=10):
            print(f"{b.id}  {b.processing_status:12s}  {b.created_at:%Y-%m-%d %H:%M}  {b.request_counts}")
        return
    while True:
        b = c.messages.batches.retrieve(a.batch_id)
        rc = b.request_counts
        print(f"{time.strftime('%H:%M:%S')}  stav={b.processing_status}  hotovo={rc.succeeded} chyby={rc.errored} "
              f"čaká={rc.processing} expirované={rc.expired}", flush=True)
        if b.processing_status == "ended" or not a.wait:
            break
        time.sleep(60)
    if b.processing_status != "ended":
        print("Ešte nie je hotové. Skús neskôr alebo pridaj --wait."); return

    meta = Path(f"batch_{a.batch_id}.json")
    model = json.loads(meta.read_text(encoding="utf-8"))["model"] if meta.exists() else "?"
    tin = tout = ok = err = 0
    errors, notes = [], 0
    out = Path(f"results_{a.batch_id}.jsonl")
    with out.open("w", encoding="utf-8") as f:
        for r in c.messages.batches.results(a.batch_id):
            row = {"custom_id": r.custom_id}
            if r.result.type == "succeeded":
                m = r.result.message
                tin += m.usage.input_tokens; tout += m.usage.output_tokens
                row["usage"] = {"in": m.usage.input_tokens, "out": m.usage.output_tokens}
                row["stop_reason"] = m.stop_reason
                tool = next((x for x in m.content if x.type == "tool_use"), None)
                if tool:
                    row["data"] = normalize(tool.input)
                else:                                   # model napísal JSON ako text
                    txt = "".join(x.text for x in m.content if x.type == "text")
                    try:
                        row["data"] = normalize(json.loads(txt[txt.index("{"): txt.rindex("}") + 1])); row["note"] = "json_z_textu"
                    except Exception:
                        row["data"] = None; row["note"] = "bez_dat"; notes += 1
                d = row.get("data") or {}
                # len skutočný JSON v reťazci; nie prázdny reťazec ("" in "[{" je True) ani prepis začínajúci značkou [?] / [...]
                if any(isinstance(v, str) and (v.lstrip()[:1] == "{" or v.lstrip()[:2] in ('[{', '["', '[]')) for v in d.values()):
                    row["note"] = "pole_prislo_ako_text – skontrolovať"; notes += 1
                if m.stop_reason == "max_tokens":
                    row["note"] = "max_tokens – zvýš --max-tokens"; notes += 1
                ok += 1
            else:
                err += 1; errors.append(r.custom_id)
                row["error"] = str(getattr(r.result, "error", r.result.type))
            f.write(json.dumps(row, ensure_ascii=False) + "\n")

    lines = [f"batch        : {a.batch_id}", f"model        : {model}", f"strán OK     : {ok}", f"strán chyba  : {err}",
             f"upozornenia  : {notes}", f"tokeny in    : {tin:,}", f"tokeny out   : {tout:,}"]
    if ok:
        lines.append(f"priemer/str. : in {tin//ok:,}  out {tout//ok:,}")
    p = price_for(model)
    if p:
        cost = (tin * p[0] + tout * p[1]) / 1e6 * BATCH_FACTOR
        lines.append(f"odhad ceny   : {cost:.2f} USD  (batch ×{BATCH_FACTOR}; presnú sumu over v konzole)")
    if errors:
        lines.append("chyby        : " + ", ".join(errors[:20]))
    txt = "\n".join(lines)
    Path(f"summary_{a.batch_id}.txt").write_text(txt, encoding="utf-8")
    print("\n" + txt + f"\n\nVýsledky: {out}")

if __name__ == "__main__":
    main()
