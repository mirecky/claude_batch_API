# Batch API toolkit – vyťaženie údajov z naskenovaných PDF

Overené v praxi 9.–10. 10. 2026 na zdravotnom zázname: 430 strán (Sonnet 5.5, 4,68 USD) + 141 rukopisných strán (Fable 5.1 vo vysokom rozlíšení, ~25 USD), 0 chýb.

## Čo je v zložke

| Súbor | Na čo |
|---|---|
| `prepare.py` | PDF → obrázky strán (`pages/`), voliteľne 4 zväčšené štvrtiny pre rukopis |
| `prompt.md` | **zadanie pre model** – čo vyťažiť a pravidlá (šablóna pre dotazníky, upraviť) |
| `schema.json` | **štruktúra výstupu** – polia, ktoré model vyplní (šablóna, upraviť podľa Excelu aplikácie) |
| `sample.py` | skúšobný beh na niekoľkých stranách cez okamžité API + odhad ceny celej dávky |
| `submit.py` | odoslanie do Batch API (sonda, delenie na batche ≤ 200 MB) |
| `collect.py` | stav a stiahnutie výsledkov + odhad ceny |
| `export_xlsx.py` | výsledky → Excel (hárok `data` + hárok `kontrola`) |
| `common.py` | spoločné funkcie (klient, cenník, oprava pokazeného JSON) |
| `ZADANIE_PRE_NOVY_CHAT.md` | text, ktorý vložíš do nového chatu |
| `gui/` | desktopová aplikácia (Electron) – celý postup v okne, návod v `gui/README.md` |

## Jednorazová príprava (Windows, PowerShell)

```powershell
py -m pip install anthropic pymupdf pillow openpyxl
```

API kľúč **len do premennej prostredia, nikdy do súborov** (platí len pre otvorené okno PowerShell):

```powershell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
# len ak API hlási "not scoped to a workspace":
$env:ANTHROPIC_WORKSPACE_ID = "wrkspc_..."
```

**Bez príkazového riadka:** rovnaký postup sa dá vykonať v aplikácii `gui\spustit.cmd` (pozri `gui/README.md`).

## Postup (pracovná zložka = kde máš skripty a kam chceš výsledky)

PowerShell otvor v zložke: v Prieskumníkovi klik do adresného riadku → napíš `powershell` → Enter.

1. **Obrázky:** `py prepare.py "cesta\k\PDF"` (rukopis: pridaj `--hires`)
2. **Pilot:** do `pilot.txt` daj 10–15 id strán (z `pages\manifest.csv`, napr. `i_a_vstupny_dotaznik-001`), radšej tie najhoršie.
3. `py submit.py --list pilot.txt --dry-run` → veľkosť
4. `py submit.py --list pilot.txt --probe-only` → 1 strana hneď; musí vypísať `OK … nástroj=áno`
5. `py submit.py --list pilot.txt` → odošle pilot
6. `py collect.py <id> --wait` → stiahne `results_<id>.jsonl`
   *Alternatíva k 3–6:* `py sample.py --list pilot.txt` → strany hneď cez okamžité API (plná cena) + odhad ceny celej dávky.
7. **Skontrolovať pilot** (v chate s Claude – porovnať s originálom), upraviť `prompt.md` / `schema.json`, opakovať 4–7.
8. **Ostrý beh:** `py submit.py --all --skip-probe` (pri rukopise `--hires`) → `py collect.py <id> --wait`
9. `py export_xlsx.py --out vysledky.xlsx`

Batch zvyčajne dobehne za minúty (pilot ~1 min, 126 strán ~20 min), garantované do 24 h. Výsledky sú na serveri 29 dní.

## Voľba modelu a cena (USD / 1M tokenov, batch = polovica)

| Model | Štandard in / out | Kedy |
|---|---|---|
| `claude-sonnet-5-5` | 2 / 10 | tlačené a bežne čitateľné strany – predvolený |
| `claude-fable-5-1` + `--hires` | 10 / 50 | zlý rukopis; v pilote čitateľnosť výrazne lepšia (zlé strany 48 → 10) |
| `claude-haiku-5-5` | 0,10 / 0,50 | jednoduché formuláre, zaškrtávanie |

Orientačne na stranu (batch): Sonnet ~0,011 USD; Fable + hires ~0,19 USD. Cenník over v konzole (console.anthropic.com → Settings → Billing / Pricing).

## Overené chyby a ich riešenia (neopakovať)

| Príznak | Príčina | Riešenie (už v skriptoch) |
|---|---|---|
| `Chýba balík anthropic` hoci si ho inštaloval | `pip` inštaloval do iného Pythonu | vždy `py -m pip install …` |
| `Unable to create process … python3.exe` | prvý riadok `#!/usr/bin/env python3` v skripte | skripty ho nemajú; nepridávať |
| 400 `API key is not scoped to a workspace` | kľúč viazaný na workspace | `$env:ANTHROPIC_WORKSPACE_ID` alebo kľúč vytvoriť vo workspace |
| všetky požiadavky chyba `tool_choice … not supported` | modely 5.x nedovolia `tool`/`any` | `tool_choice: auto` + v prompte „VŽDY zavolaj nástroj“ |
| všetky požiadavky chyba `temperature is deprecated` | parameter zrušený | neposielať `temperature` |
| celý batch zlyhá na zlom parametri | chyba sa ukáže až po hodinách | **sonda** (`--probe-only`) pred každým novým nastavením |
| strana skončí `max_tokens` | hustá tabuľka / dlhý prepis | `--max-tokens 8000` (Fable+prepis aj 16000) |
| pole v JSON príde ako reťazec s chybou | model občas neescapuje „…" | `collect.py` to opravuje automaticky (`normalize`) |
| všetky strany bez mena na hárku `kontrola` | `"" in "[{"` je v Pythone `True` | opravené v `collect.py` (10/2026) |
| príkaz vložený 2× do riadku | `unrecognized arguments` | vkladať po jednom |
| submit „visí“ | 100+ MB sa nahráva | čakať; **nespúšťať znova** (dvojitá platba) |

## Ochrana údajov

Dotazníky obsahujú osobné údaje žiakov (väčšinou maloletých). Pred ostrým behom si over so školou (GDPR / zodpovedná osoba), či môžu ísť do API. Možnosti: poslať len strany bez mien a mená doplniť z `student_name` lokálne, alebo mená v Exceli nahradiť kódmi. Podľa obchodných podmienok Anthropic dáta z API štandardne nepoužíva na tréning (over aktuálne znenie); výsledky batchu sú na serveri 29 dní.
