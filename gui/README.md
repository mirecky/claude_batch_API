# Batch API – desktopová aplikácia (GUI)

Grafické rozhranie nad overenými skriptmi toolkitu. Aplikácia **nemá vlastnú logiku Batch API**: spúšťa
`prepare.py`, `sample.py`, `submit.py`, `collect.py` a `export_xlsx.py` a zobrazuje ich výstup.
Všetko, čo sa dá urobiť v aplikácii, sa dá urobiť aj príkazmi podľa hlavného `README.md`.

## Inštalácia (Windows, jednorazovo)

1. Python a balíky podľa hlavného `README.md` (`py -m pip install anthropic pymupdf pillow openpyxl`).
2. Node.js LTS z https://nodejs.org (inštalátor, všetko predvolené).
3. Dvojklik na `gui\spustit.cmd`. Pri prvom spustení sa nainštaluje Electron (niekoľko minút).

Iný spôsob: v PowerShell v zložke `gui` príkazy `npm install` a potom `npm start`.

## Postup v aplikácii

| Krok | Čo urobíš | Ktorý skript sa spustí |
|---|---|---|
| 1 Nastavenia | zložka toolkitu, pracovná zložka, API kľúč | – |
| 2 Príprava strán | vyberieš zložku s PDF (pri rukopise zaškrtneš `--hires`), prípadne označíš skúšobné strany | `prepare.py` |
| 3 Zadanie | úprava `prompt.md` a `schema.json` (ukladá sa do pracovnej zložky) | – |
| 4 Skúška a spustenie | **A:** skúšobný beh na niekoľkých stranách → odhad ceny celej dávky; **B:** kontrola výsledkov vedľa originálu → tlačidlo *Schváliť a spustiť dávku* | `sample.py`, potom `submit.py --all --skip-probe` |
| 5 Výsledky a export | čakanie a stiahnutie výsledkov, prehliadanie, export do Excelu (predvolene 1 riadok = 1 žiak, voliteľne kontrola mien podľa zoznamu žiakov) | `collect.py`, `export_xlsx.py --students` |

### Skúšobný beh a schválenie

- Skúška ide cez **okamžité API** (výsledok o niekoľko sekúnd), preto sa platí **plnou cenou**.
  Orientačne: 5 strán so Sonnetom ~0,10 USD, s Fable a `--hires` ~2 USD.
- Odhad pre celú dávku = priemerné tokeny na stranu zo skúšky × počet strán × cena modelu × 0,5 (zľava batchu).
  Cenník sa číta z `common.py`.
- Tlačidlo *Schváliť a spustiť dávku* je aktívne iba vtedy, keď skúška zodpovedá aktuálnemu nastaveniu:
  rovnaký model, rovnaké `--hires` a max. tokenov, nezmenený `prompt.md` a `schema.json`, rovnaký počet strán.
  Po akejkoľvek zmene treba spraviť novú skúšku.
- Pred odoslaním sa zobrazí potvrdenie s počtom strán a odhadom ceny. Ak bola v ten deň už odoslaná dávka
  s rovnakým modelom a počtom strán, potvrdenie na to upozorní (ochrana pred dvojitou platbou).
- Odosielanie dávky sa nedá prerušiť a počas neho sa aplikácia nedá zavrieť.

## API kľúč

Kľúč sa **nikam neukladá**. Drží sa len v pamäti, kým je aplikácia otvorená, a odovzdáva sa skriptom
cez premennú prostredia. Ak ho máš nastavený v `$env:ANTHROPIC_API_KEY` a aplikáciu spustíš z toho istého
okna PowerShell (`npm start`), načíta sa sám. Do okna aplikácie sa kľúč nikdy neposiela, iba informácia,
či je nastavený.

Nastavenia (cesty k zložkám, príkaz pre Python) sa ukladajú do `%APPDATA%\batch-gui\settings.json`.

## Ochrana údajov

Obrázky strán, výsledky a Excel vznikajú len v pracovnej zložke. Nevkladaj ju do repozitára;
`.gitignore` v koreni repozitára tieto súbory vylučuje.
