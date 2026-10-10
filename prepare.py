"""prepare.py – rozreže PDF na obrázky strán pre Batch API.

Použitie (PowerShell, v pracovnej zložke):
  py prepare.py VSTUPNA_ZLOZKA                 # každá strana = 1 obrázok (pages/)
  py prepare.py VSTUPNA_ZLOZKA --hires         # navyše 4 zväčšené štvrtiny (pre rukopis)
  py prepare.py VSTUPNA_ZLOZKA --dpi 200

Výstup:  pages/<id>_full.jpg (+ _q1.._q4.jpg pri --hires),  pages/manifest.csv
         id = <skratka PDF>-<strana 3 miesta>, napr. ia_dotaznik-007
Potrebné: py -m pip install pymupdf pillow
"""
import argparse, csv, io, re, sys, unicodedata
from pathlib import Path

try:
    try:
        import pymupdf as fitz
    except ImportError:
        import fitz  # staršie verzie PyMuPDF
    from PIL import Image
except ImportError:
    sys.exit("Chýba balík. Spusti:  py -m pip install pymupdf pillow")

MAXSIDE = 1568          # API väčšie obrázky aj tak zmenší na 1568 px – viac je zbytočné
OVERLAP = 0.56          # štvrtina = 56 % šírky a výšky → prekryv 12 %, text na okraji sa nestratí

def slug(s, n=24):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return (re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_").lower() or "pdf")[:n]

def save(img, path, q=85):
    img = img.convert("RGB")
    img.thumbnail((MAXSIDE, MAXSIDE), Image.LANCZOS)
    img.save(path, "JPEG", quality=q, optimize=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("vstup", help="zložka s PDF (prehľadáva aj podzložky)")
    ap.add_argument("--hires", action="store_true", help="pridať 4 zväčšené štvrtiny (rukopis)")
    ap.add_argument("--dpi", type=int, default=0, help="0 = 150 bez --hires, 300 s --hires")
    ap.add_argument("--out", default="pages")
    a = ap.parse_args()
    dpi = a.dpi or (300 if a.hires else 150)
    out = Path(a.out); out.mkdir(exist_ok=True)
    pdfs = sorted(Path(a.vstup).rglob("*.pdf"))
    if not pdfs:
        sys.exit(f"V '{a.vstup}' nie sú žiadne PDF.")
    rows, used = [], set()
    for pdf in pdfs:
        tag = slug(pdf.stem)
        while tag in used:
            tag += "x"
        used.add(tag)
        doc = fitz.open(pdf)
        print(f"{pdf}  →  {tag}  ({doc.page_count} str.)", flush=True)
        for i, page in enumerate(doc, 1):
            pid = f"{tag}-{i:03d}"
            rows.append({"id": pid, "pdf": str(pdf), "strana": i})
            if (out / f"{pid}_full.jpg").exists() and (not a.hires or (out / f"{pid}_q4.jpg").exists()):
                continue
            pix = page.get_pixmap(dpi=dpi)
            im = Image.open(io.BytesIO(pix.tobytes("png")))
            save(im, out / f"{pid}_full.jpg", q=80 if a.hires else 85)
            if a.hires:
                W, H = im.size; w, h = int(W * OVERLAP), int(H * OVERLAP)
                for k, b in enumerate([(0, 0, w, h), (W - w, 0, W, h), (0, H - h, w, H), (W - w, H - h, W, H)], 1):
                    save(im.crop(b), out / f"{pid}_q{k}.jpg")
    with open(out / "manifest.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["id", "pdf", "strana"], delimiter=";"); w.writeheader(); w.writerows(rows)
    print(f"Hotovo: {len(rows)} strán → {out}/  (zoznam: {out}/manifest.csv)")

if __name__ == "__main__":
    main()
