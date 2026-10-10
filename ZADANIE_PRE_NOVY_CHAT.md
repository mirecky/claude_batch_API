# Zadanie pre nový chat (skopíruj celé do prvej správy)

---

Chcem cez Anthropic **Batch API** spracovať naskenované dotazníky a testy žiakov (PDF, väčšinou rukou vyplnené) do Excelu, ktorý potom načíta moja aplikácia.

**Pripojené zložky:**
- `Triedy` – podzložky I.A, I.C, I.D… so skenmi v `dotazniky_scan/` a `testy_scan/`, zoznamy `_zoznam_<trieda>.md`
- `moji_ziaci_2026_2027` – `ziaci_vsetci.txt` (zoznam žiakov)

**Hotový a overený nástroj** je v `Triedy\_batch_api_toolkit\` – najprv si prečítaj `README.md` (postup, ceny, tabuľka overených chýb a riešení). Skripty `prepare.py`, `submit.py`, `collect.py`, `export_xlsx.py` sú odskúšané (430 + 141 strán bez chyby). Neprepisuj ich od nuly – upravuj len `prompt.md`, `schema.json` a pri potrebe `export_xlsx.py` (funkciu `row_for`) podľa stĺpcov mojej aplikácie.

**Ako pracujeme:**
- Som začiatočník – postupuj opatrne, krok za krokom, jeden príkaz naraz.
- Skripty spúšťam ja v PowerShell (`py …`) so svojím API kľúčom v `$env:ANTHROPIC_API_KEY`. Kľúč ti nikdy neposielam a nesmie byť v žiadnom súbore.
- Pred ostrým behom vždy: `--dry-run` → `--probe-only` → pilot 10–15 strán → tvoja kontrola pilotu oproti originálu → až potom všetko (`--all --skip-probe`).
- Pri rukopise zvážiť `--hires` a model `claude-fable-5-1` (drahší, ale čitateľnosť výrazne lepšia); inak `claude-sonnet-5-5`.
- Pred spustením mi povedz odhad ceny.

**Čo od teba potrebujem najprv:**
1. Pozri skeny (počet strán, či je to dotazník alebo test – pozor: `I.A\dotazniky_scan\i_a_vstupny_dotaznik.pdf` je totožný s testom a `I.C\dotazniky_scan\1c_vstupny_dotaznik03.pdf` je podľa 1. strany tiež test) a jeden vyplnený dotazník, aby si poznal otázky.
2. Opýtaj sa ma na presné stĺpce Excelu pre aplikáciu (pošlem ukážku) a podľa toho uprav `schema.json`, `prompt.md` (doplň zoznam otázok) a export.
3. Navrhni, ako priradiť strany k žiakom (meno je len na 1. strane dotazníka) a ako to skontrolovať voči `ziaci_vsetci.txt`.
4. Vyrieš so mnou ochranu osobných údajov žiakov (mená do API áno/nie).

---
