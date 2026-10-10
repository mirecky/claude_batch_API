"""common.py – spoločné funkcie pre prepare/submit/collect/export.
Overené pri spracovaní zdravotného záznamu 10/2026 (430 + 141 strán, 0 chýb)."""
import json, os, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = Path.cwd()          # pracovná zložka = tam, kde spúšťaš príkazy (môže byť iná než toolkit)

# Cenník USD / 1M tokenov (štandard). Batch = polovica. Over v konzole: Settings → Billing / Pricing.
PRICES = {
    "claude-haiku-5-5": (0.10, 0.50),
    "claude-sonnet-5-5": (2.00, 10.00),
    "claude-opus-5-5": (4.00, 20.00),
    "claude-opus-5": (5.00, 25.00),
    "claude-sonnet-5": (3.00, 15.00),
    "claude-fable-5": (10.00, 50.00),      # platí aj pre claude-fable-5-1
    "claude-opus-4": (15.00, 75.00),
    "claude-sonnet-4": (3.00, 15.00),
    "claude-haiku-4": (1.00, 5.00),
}
BATCH_FACTOR = 0.5

def price_for(model):
    hits = [k for k in PRICES if model.startswith(k)]
    return PRICES[max(hits, key=len)] if hits else None

def make_client():
    """Klient Anthropic. Kľúč LEN z premennej prostredia ANTHROPIC_API_KEY – nikdy ho neukladaj do súborov.
    Ak je kľúč viazaný na workspace a API hlási 'not scoped to a workspace', nastav ANTHROPIC_WORKSPACE_ID."""
    try:
        import anthropic
    except ImportError:
        sys.exit("Chýba balík. Spusti:  py -m pip install anthropic pymupdf openpyxl")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit('Chýba kľúč. V PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."')
    ws = os.environ.get("ANTHROPIC_WORKSPACE_ID")
    return anthropic.Anthropic(default_headers={"anthropic-workspace-id": ws} if ws else None)

def load_text(name):
    p = PROJECT / name
    if not p.exists():
        p = HERE / name
    return p.read_text(encoding="utf-8")

def load_json(name):
    return json.loads(load_text(name))

def repair_json(s):
    """Model občas vráti vnorené pole ako reťazec s drobnou chybou (neescapované „...\" , čiarka navyše).
    Skúsi bežné opravy; pri neúspechu vráti None."""
    if not isinstance(s, str):
        return s
    cands = [s]
    t = re.sub(r'„([^"„“\n]{0,200}?)"', r'„\1“', s)          # slovenské úvodzovky zakončené rovnou "
    t = t.replace('"","}', '""}')
    cands += [t, re.sub(r",\s*([}\]])", r"\1", t)]              # čiarka pred } alebo ]
    for c in cands:
        for extra in ("", "]", "}]"):
            try:
                return json.loads(c + extra)
            except Exception:
                pass
    return None

def normalize(data):
    """Prejde výstup nástroja a opraví polia, ktoré prišli ako JSON reťazec namiesto poľa/objektu."""
    if not isinstance(data, dict):
        return data
    for k, v in list(data.items()):
        if isinstance(v, str) and v[:1] in "[{":
            fixed = repair_json(v)
            if fixed is not None:
                data[k] = fixed
        if isinstance(data[k], list):
            data[k] = [normalize(x) if isinstance(x, dict) else x for x in data[k]]
    return data
