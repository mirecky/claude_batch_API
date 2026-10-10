"""submit.py – pošle strany do Anthropic Batch API (50 % zľava, výsledok do 24 h, zvyčajne minúty).

Zadanie úlohy je v dvoch súboroch v pracovnej zložke (šablóny sú v toolkite):
  prompt.md    – systémový prompt (čo vyťažiť, pravidlá)
  schema.json  – JSON schéma výstupu (nástroj 'extract_page')

Použitie (PowerShell, v pracovnej zložke):
  py submit.py --list-models                         # aké modely máš k dispozícii
  py submit.py --list pilot.txt --dry-run            # len spočíta veľkosť, nič neposiela
  py submit.py --list pilot.txt --probe-only         # 1 strana hneď (plná cena) – overí parametre
  py submit.py --list pilot.txt                      # sonda + batch
  py submit.py --all --skip-probe                    # všetky strany z pages/, bez sondy
Voľby: --model claude-sonnet-5-5 (predvolené) | --hires (posiela aj štvrtiny _q1.._q4) | --max-tokens 8000
Potom:  py collect.py <id_batchu> --wait
"""
import sys, argparse, base64, json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import make_client, load_text, load_json

PAGES = Path("pages")
DEFAULT_MODEL = "claude-sonnet-5-5"
MAX_BATCH_MB = 200      # limit API je 256 MB na batch; väčší zoznam sa rozdelí sám
PARTS = [("full", "CELÁ STRANA"), ("q1", "štvrtina vľavo hore"), ("q2", "štvrtina vpravo hore"),
         ("q3", "štvrtina vľavo dole"), ("q4", "štvrtina vpravo dole")]

def tool():
    return {"name": "extract_page", "description": "Štruktúrovaný výpis jednej strany.",
            "input_schema": load_json("schema.json")}

def build(pid, model, system, hires, max_tokens):
    content = []
    for suf, label in (PARTS if hires else PARTS[:1]):
        data = base64.standard_b64encode((PAGES / f"{pid}_{suf}.jpg").read_bytes()).decode()
        if hires:
            content.append({"type": "text", "text": f"[{label}]"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": data}})
    content.append({"type": "text", "text": f"Strana {pid}. Vyťaž údaje podľa pokynov a zavolaj nástroj extract_page."})
    # POZOR (overené): modely 5.x nepodporujú tool_choice 'tool'/'any' → 'auto' + pokyn v prompte;
    #                  parameter 'temperature' je pri nich zrušený → neposielať.
    return {"custom_id": pid, "params": {"model": model, "max_tokens": max_tokens, "system": system,
            "tools": [tool()], "tool_choice": {"type": "auto"},
            "messages": [{"role": "user", "content": content}]}}

def chunks(reqs):
    cur, size = [], 0.0
    for r in reqs:
        s = len(json.dumps(r)) / 1e6
        if cur and size + s > MAX_BATCH_MB:
            yield cur; cur, size = [], 0.0
        cur.append(r); size += s
    if cur:
        yield cur

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--list", help="textový súbor s id strán (jedno na riadok)")
    g.add_argument("--all", action="store_true", help="všetky strany z pages/")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--hires", action="store_true")
    ap.add_argument("--max-tokens", type=int, default=8000)
    ap.add_argument("--list-models", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--probe-only", action="store_true")
    ap.add_argument("--skip-probe", action="store_true")
    a = ap.parse_args()

    if a.list_models:
        for m in make_client().models.list(limit=100):
            print(f"{m.id:40s} {getattr(m, 'display_name', '')}")
        return
    if a.list:
        ids = [l.strip().removesuffix(".jpg").removesuffix("_full") for l in Path(a.list).read_text(encoding="utf-8").splitlines()
               if l.strip() and not l.startswith("#")]
    elif a.all:
        ids = sorted(p.name[:-9] for p in PAGES.glob("*_full.jpg"))
    else:
        sys.exit("Zadaj --list subor.txt alebo --all")
    need = PARTS if a.hires else PARTS[:1]
    missing = sorted({i for i in ids for s, _ in need if not (PAGES / f"{i}_{s}.jpg").exists()})
    if missing:
        sys.exit(f"Chýbajú obrázky v pages/ (spusti prepare.py{' --hires' if a.hires else ''}): {missing[:10]}")

    system = load_text("prompt.md")
    reqs = [build(i, a.model, system, a.hires, a.max_tokens) for i in ids]
    parts = list(chunks(reqs))
    print(f"Strán: {len(reqs)}   model: {a.model}   veľkosť: {sum(len(json.dumps(r)) for r in reqs)/1e6:.1f} MB   batchov: {len(parts)}")
    if a.dry_run:
        return
    client = make_client()

    if not a.skip_probe:
        print("Sonda (1 strana, okamžité API, plná cena)…", end=" ", flush=True)
        try:
            pr = client.messages.create(**reqs[0]["params"])
        except Exception as e:
            sys.exit(f"\nSONDA ZLYHALA – batch neposielam.\n{e}")
        t = next((b for b in pr.content if b.type == "tool_use"), None)
        print(f"OK  in={pr.usage.input_tokens} out={pr.usage.output_tokens}  nástroj={'áno' if t else 'NIE'}  stop={pr.stop_reason}")
        if t:
            print("  ukážka:", json.dumps(t.input, ensure_ascii=False)[:400])
        if a.probe_only:
            return

    for n, part in enumerate(parts, 1):
        b = client.messages.batches.create(requests=part)
        meta = {"id": b.id, "model": a.model, "created": time.strftime("%Y-%m-%d %H:%M"),
                "pages": [r["custom_id"] for r in part], "hires": a.hires}
        Path(f"batch_{b.id}.json").write_text(json.dumps(meta, indent=1), encoding="utf-8")
        print(f"ODOSLANÉ {n}/{len(parts)}  id={b.id}  strán={len(part)}")
    print("Ďalej:  py collect.py <id> --wait     (NESPÚŠŤAJ submit znova – zaplatil by si dvakrát)")

if __name__ == "__main__":
    main()
