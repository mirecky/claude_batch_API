"""sample.py – skúšobný beh na niekoľkých stranách cez okamžité API + odhad ceny celej dávky.

Požiadavky skladá tá istá funkcia build() ako submit.py, takže skúška vidí presne to, čo ostrý batch.
Skúška sa platí plnou cenou (bez 50 % zľavy batchu); odhad pre celú dávku už zľavu zahŕňa.

Použitie (PowerShell, v pracovnej zložke):
  py sample.py                          # 5 strán rovnomerne rozložených cez všetky strany v pages/
  py sample.py --n 3
  py sample.py --list pilot.txt         # konkrétne strany
Voľby ako pri submit.py: --model … | --hires | --max-tokens 8000
Výstup:  sample_<čas>.jsonl  (rovnaký formát ako results_*.jsonl – dá sa skontrolovať a exportovať)
         sample_<čas>.json   (nastavenia, tokeny, odhad ceny – podľa neho GUI povolí spustenie dávky)
"""
import argparse, hashlib, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import make_client, load_text, price_for, BATCH_FACTOR, normalize, PROJECT, HERE
from submit import build, PAGES, PARTS, DEFAULT_MODEL

def file_sha(name):
    p = PROJECT / name
    if not p.exists():
        p = HERE / name
    return hashlib.sha256(p.read_bytes()).hexdigest()

def spread(ids, n):
    if n >= len(ids):
        return list(ids)
    return [ids[round(i * (len(ids) - 1) / (n - 1))] for i in range(n)] if n > 1 else [ids[len(ids) // 2]]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", help="textový súbor s id strán (jedno na riadok)")
    ap.add_argument("--n", type=int, default=5, help="počet strán pri automatickom výbere")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--hires", action="store_true")
    ap.add_argument("--max-tokens", type=int, default=8000)
    a = ap.parse_args()

    need = PARTS if a.hires else PARTS[:1]
    every = sorted(p.name[:-9] for p in PAGES.glob("*_full.jpg"))
    if not every:
        sys.exit("V pages/ nie sú žiadne strany – najprv spusti prepare.py.")
    usable = [i for i in every if all((PAGES / f"{i}_{s}.jpg").exists() for s, _ in need)]
    if a.list:
        ids = [l.strip().removesuffix(".jpg").removesuffix("_full") for l in Path(a.list).read_text(encoding="utf-8").splitlines()
               if l.strip() and not l.startswith("#")]
    else:
        ids = spread(usable, max(1, a.n))
    missing = [i for i in ids if i not in usable]
    if missing:
        sys.exit(f"Chýbajú obrázky v pages/ (spusti prepare.py{' --hires' if a.hires else ''}): {missing[:10]}")

    p = price_for(a.model)
    system = load_text("prompt.md")
    client = make_client()
    stamp = time.strftime("%Y%m%d_%H%M%S")
    out = Path(f"sample_{stamp}.jsonl")
    print(f"Skúšobný beh – počet strán: {len(ids)}   model: {a.model}   hires: {'áno' if a.hires else 'nie'}", flush=True)
    tin = tout = ok = 0
    with out.open("w", encoding="utf-8") as f:
        for n, pid in enumerate(ids, 1):
            req = build(pid, a.model, system, a.hires, a.max_tokens)
            row = {"custom_id": pid}
            t0 = time.time()
            try:
                m = client.messages.create(**req["params"])
            except Exception as e:
                row["error"] = str(e)
                print(f"[{n}/{len(ids)}] {pid}  CHYBA: {e}", flush=True)
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
                if n == 1:
                    sys.exit("Prvá strana zlyhala – nastavenie treba opraviť, ďalej nepokračujem.")
                continue
            tin += m.usage.input_tokens; tout += m.usage.output_tokens; ok += 1
            row["usage"] = {"in": m.usage.input_tokens, "out": m.usage.output_tokens}
            row["stop_reason"] = m.stop_reason
            tool = next((x for x in m.content if x.type == "tool_use"), None)
            row["data"] = normalize(tool.input) if tool else None
            if not tool:
                row["note"] = "bez_dat – model nezavolal nástroj"
            if m.stop_reason == "max_tokens":
                row["note"] = "max_tokens – zvýš --max-tokens"
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
            cost = (m.usage.input_tokens * p[0] + m.usage.output_tokens * p[1]) / 1e6 if p else None
            print(f"[{n}/{len(ids)}] {pid}  in={m.usage.input_tokens} out={m.usage.output_tokens}  "
                  f"stop={m.stop_reason}  nástroj={'áno' if tool else 'NIE'}  {time.time() - t0:.0f} s"
                  + (f"  {cost:.3f} USD" if cost is not None else ""), flush=True)
    if not ok:
        sys.exit("Žiadna strana neprešla.")

    avg_in, avg_out = tin / ok, tout / ok
    meta = {"file": out.name, "created": time.strftime("%Y-%m-%d %H:%M"), "model": a.model, "hires": a.hires,
            "max_tokens": a.max_tokens, "prompt_sha": file_sha("prompt.md"), "schema_sha": file_sha("schema.json"),
            "pages": ids, "ok": ok, "tokens_in": tin, "tokens_out": tout,
            "avg_in": round(avg_in), "avg_out": round(avg_out), "total_pages": len(usable), "batch_factor": BATCH_FACTOR}
    if p:
        meta["sample_cost"] = round((tin * p[0] + tout * p[1]) / 1e6, 4)
        meta["page_cost_batch"] = round((avg_in * p[0] + avg_out * p[1]) / 1e6 * BATCH_FACTOR, 5)
        meta["estimate_all"] = round(meta["page_cost_batch"] * len(usable), 2)
    Path(f"sample_{stamp}.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\nPriemer na stranu: in {avg_in:,.0f}  out {avg_out:,.0f} tokenov")
    if p:
        print(f"Skúška stála: {meta['sample_cost']:.3f} USD (plná cena)")
        print(f"ODHAD celej dávky: počet strán {len(usable)} × {meta['page_cost_batch']:.4f} USD = {meta['estimate_all']:.2f} USD"
              f"  (batch ×{BATCH_FACTOR}; presnú sumu over v konzole)")
    else:
        print(f"Model {a.model} nie je v cenníku common.py – odhad ceny nevypočítam.")
    print(f"Výsledky skúšky: {out}")

if __name__ == "__main__":
    main()
