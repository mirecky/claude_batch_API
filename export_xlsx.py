"""export_xlsx.py – prevedie results_*.jsonl do Excelu.

Použitie:
  py export_xlsx.py                          # všetky results_*.jsonl v zložke → vysledky.xlsx
  py export_xlsx.py results_msgbatch_X.jsonl --out dotazniky.xlsx
  py export_xlsx.py --rows entries           # 1 riadok = 1 prvok poľa 'entries' (ak ho schéma má)
  py export_xlsx.py --students               # 1 riadok = 1 žiak (spojí strany dotazníka, stĺpce Q1…Q76)
  py export_xlsx.py --students --roster ziaci_vsetci.txt   # + kontrola mien podľa zoznamu žiakov

Hárok 'data'   : 1 riadok = 1 strana (alebo 1 prvok poľa --rows); vnorené polia ako JSON text.
Hárok 'kontrola': strany s chybou / upozornením / bez dát.
--students: hárok 'ziaci' (1 riadok = 1 žiak) + 'kontrola_ziaci' (chýbajúce strany/otázky, neisté mená…).
  Nový žiak začína stranou s is_first_page / page_in_form = 1, alebo keď číslo strany klesne.
Zoradené podľa custom_id (= poradie strán v PDF). Ak sú v pages/manifest.csv, doplní pdf a stranu.
Pre konkrétnu aplikáciu (presné stĺpce) si dajte v chate upraviť funkciu row_for().
"""
import argparse, csv, difflib, json, re, sys, unicodedata
from pathlib import Path
try:
    from openpyxl import Workbook
    from openpyxl.utils import get_column_letter
except ImportError:
    sys.exit("Chýba balík. Spusti:  py -m pip install openpyxl")

def flat(v):
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return v

def row_for(base, d):
    r = dict(base)
    for k, v in (d or {}).items():
        r[k] = flat(v)
    return r

# ---------- 1 riadok = 1 žiak ----------
HEAD = [("student_name", "meno"), ("class_name", "trieda"), ("previous_school", "zakladna_skola"), ("form_date", "datum")]

def qkey(q):
    """'Q7', 'q 7', '7' → 'Q7'; iné označenia (napr. pri teste '2a') ostanú bez zmeny."""
    m = re.fullmatch(r"\s*[Qq]?\s*(\d+)\s*", str(q))
    return f"Q{int(m.group(1))}" if m else str(q).strip()

def qsort(q):
    m = re.fullmatch(r"Q(\d+)", q)
    return (0, int(m.group(1)), "") if m else (1, 0, q)

def plain(s):
    """meno bez diakritiky, malými písmenami, slová zoradené (poradie meno/priezvisko nehrá rolu)"""
    s = unicodedata.normalize("NFKD", str(s)).encode("ascii", "ignore").decode().lower()
    return " ".join(sorted(re.sub(r"[^a-z]+", " ", s).split()))

def ranges(nums):
    """[1,2,3,7] → 'Q1–Q3, Q7'"""
    out, nums = [], sorted(nums)
    i = 0
    while i < len(nums):
        j = i
        while j + 1 < len(nums) and nums[j + 1] == nums[j] + 1:
            j += 1
        out.append(f"Q{nums[i]}" if i == j else f"Q{nums[i]}–Q{nums[j]}")
        i = j + 1
    return ", ".join(out)

def group_students(seen, man):
    by_pdf = {}
    for cid in sorted(seen):
        by_pdf.setdefault(cid.rsplit("-", 1)[0], []).append(cid)
    studs = []
    for tag, cids in by_pdf.items():
        cur, prev = None, 0
        for cid in cids:
            r = seen[cid]
            d = r.get("data") or {}
            pif = d.get("page_in_form") if isinstance(d.get("page_in_form"), int) else None
            if cur is None or d.get("is_first_page") or pif == 1 or (pif is not None and prev and pif <= prev):
                cur = {"pdf": Path(man.get(cid, {}).get("pdf", tag)).name, "pages": [], "pif": [], "head": {},
                       "ans": {}, "unc": [], "prob": []}
                studs.append(cur)
                prev = 0
            cur["pages"].append(cid)
            prev = pif or prev + 1
            if r.get("data"):                     # strana bez dát (chyba API) sa do čísel strán nepočíta
                cur["pif"].append(prev)
            if r.get("error") or not r.get("data") or r.get("note"):
                cur["prob"].append(f"{cid}: {r.get('error') or r.get('note') or 'bez dát'}")
            if d and d.get("document_type") not in (None, "dotaznik"):
                cur["prob"].append(f"{cid}: typ dokumentu {d.get('document_type')}")
            for k, _ in HEAD:
                v = str(d.get(k) or "").strip()
                if v and not cur["head"].get(k):
                    cur["head"][k] = v
                elif v and plain(v) != plain(cur["head"][k]):
                    cur["prob"].append(f"{cid}: iná hodnota {k} „{v}“ – možno zlé priradenie strán")
            for a in d.get("answers") or []:
                if not isinstance(a, dict):
                    continue
                q = qkey(a.get("question_number", ""))
                v = str(a.get("answer") or "").strip() if a.get("answered", True) else ""
                old = cur["ans"].get(q)
                if old is None or (not old and v):
                    cur["ans"][q] = v
                elif v and v != old:
                    cur["prob"].append(f"{q} dvakrát: „{old}“ / „{v}“")
            for u in d.get("uncertain") or []:
                if isinstance(u, dict):
                    alt = u.get("alternatives") or []
                    cur["unc"].append(f"{u.get('where') or cid}: {u.get('read_as', '')}" + (f" (alebo: {', '.join(map(str, alt))})" if alt else ""))
    return studs

def student_rows(studs, roster):
    allq = sorted({q for s in studs for q in s["ans"]}, key=qsort)
    qn = [int(q[1:]) for q in allq if re.fullmatch(r"Q\d+", q)]
    form_pages = max((p for s in studs for p in s["pif"]), default=0)
    names = []
    if roster:
        names = [l.strip() for l in Path(roster).read_text(encoding="utf-8-sig").splitlines() if l.strip() and not l.startswith("#")]
    rows, check = [], []
    for n, s in enumerate(studs, 1):
        h = s["head"]
        miss_p = sorted(set(range(1, form_pages + 1)) - set(s["pif"]))
        if miss_p:
            s["prob"].append("chýba strana " + ", ".join(map(str, miss_p)))
        if not h.get("student_name"):
            s["prob"].append("chýba meno (prvá strana?)")
        if qn:
            miss_q = sorted(set(range(1, max(qn) + 1)) - {int(q[1:]) for q in s["ans"] if re.fullmatch(r"Q\d+", q)})
            if miss_q:
                s["prob"].append("v prepise chýbajú " + ranges(miss_q))
        row = {"poradie": n, "pdf": s["pdf"], "strany": f"{s['pages'][0]} … {s['pages'][-1]}" if len(s["pages"]) > 1 else s["pages"][0]}
        row.update({col: h.get(k, "") for k, col in HEAD})
        if names:
            best, score = "", 0.0
            for line in names:
                sc = difflib.SequenceMatcher(None, plain(h.get("student_name", "")), plain(line)).ratio()
                if sc > score:
                    best, score = line, sc
            if score >= 0.85:
                row["zoznam_ziakov"] = best
            else:
                row["zoznam_ziakov"] = f"? {best}" if score >= 0.6 else ""
                s["prob"].append(f"meno nie je v zozname žiakov" + (f" (najbližšie: {best})" if score >= 0.6 else ""))
        for q in allq:
            row[q] = s["ans"].get(q, "")
        row["neiste"] = "\n".join(s["unc"])
        row["na_kontrolu"] = "; ".join(s["prob"])
        rows.append(row)
        for p in s["prob"]:
            check.append({"poradie": n, "meno": h.get("student_name", ""), "pdf": s["pdf"], "problem": p})
    return rows, check

def write(path, sheets):
    wb = Workbook()
    wb.remove(wb.active)
    for title, data in sheets:
        ws = wb.create_sheet(title)
        cols = []
        for r in data:
            cols += [k for k in r if k not in cols]
        ws.append(cols or ["(prázdne)"])
        for r in data:
            ws.append([r.get(c, "") for c in cols])
        ws.freeze_panes = "A2"
        for i, c in enumerate(cols, 1):
            ws.column_dimensions[get_column_letter(i)].width = min(60, max(10, len(str(c)) + 2))
    wb.save(path)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*")
    ap.add_argument("--out", default="vysledky.xlsx")
    ap.add_argument("--rows", help="názov poľa, ktoré sa rozbalí na viac riadkov (napr. entries)")
    ap.add_argument("--students", action="store_true", help="1 riadok = 1 žiak (spojí strany dotazníka)")
    ap.add_argument("--roster", help="zoznam žiakov (1 meno na riadok) na kontrolu prečítaných mien")
    a = ap.parse_args()
    files = [Path(f) for f in a.files] or sorted(Path(".").glob("results_*.jsonl"))
    if not files:
        sys.exit("Nenašiel som results_*.jsonl")
    man = {}
    mf = Path("pages/manifest.csv")
    if mf.exists():
        with mf.open(encoding="utf-8") as f:
            man = {r["id"]: r for r in csv.DictReader(f, delimiter=";")}
    rows, check = [], []
    seen = {}
    for fp in files:                                  # neskorší súbor prepíše skorší (napr. opakované čítanie)
        for line in fp.open(encoding="utf-8"):
            r = json.loads(line); seen[r["custom_id"]] = r
    for cid in sorted(seen):
        r = seen[cid]
        base = {"id": cid, "pdf": man.get(cid, {}).get("pdf", ""), "strana": man.get(cid, {}).get("strana", "")}
        d = r.get("data")
        if r.get("error") or not d or r.get("note"):
            check.append({**base, "problem": r.get("error") or r.get("note") or "bez dát"})
        if not d:
            continue
        if a.rows and isinstance(d.get(a.rows), list) and d[a.rows]:
            top = {k: v for k, v in d.items() if k != a.rows}
            for i, e in enumerate(d[a.rows], 1):
                rows.append(row_for({**base, "poradie": i}, {**top, **(e if isinstance(e, dict) else {"hodnota": e})}))
        else:
            rows.append(row_for(base, d))
    if a.students:
        srows, scheck = student_rows(group_students(seen, man), a.roster)
        write(a.out, [("ziaci", srows), ("kontrola_ziaci", scheck), ("kontrola", check)])
        print(f"{a.out}: {len(srows)} žiakov, na kontrolu {len({c['poradie'] for c in scheck})} žiakov, {len(check)} strán")
        return
    write(a.out, [("data", rows), ("kontrola", check)])
    print(f"{a.out}: {len(rows)} riadkov, na kontrolu {len(check)}")

if __name__ == "__main__":
    main()
