# Review-Regeln für den AI-Reviewer (Repo: pi-smart-terminal)

Der Bot liest diese Datei vom PR-Head. Kurze, konkrete Regeln, eine pro Zeile.

## Projekt

- Single-Package-Repo (kein Monorepo): npm-Paket `pi-smart-terminal`, TypeScript, ESM, Tab-Einrückung, Imports mit `.js`-Suffix.
- Pi-Extension (Entry `src/index.ts`): überschreibt das built-in bash-Tool durch persistente PTY-Sessions, ergänzt `terminal_*`-Tools, Overlay `/term` und Footer-Statusline.
- Die Kern-Logik (PTY, Sessions, Tool-Implementierung) lebt in der Dependency `smart-terminal-mcp` — dieses Repo ist die pi-Integrationsschicht (renderers, overlay, footer, config, bash-backend).
- Qualitätssicherung: `npm run check` = `tsc --noEmit` + Vitest (`test/`, eine Datei pro Modul).
- Release: Tag-getrieben (`v*.*.*` → `.github/workflows/release.yml`); manuelles `npm publish` ist per `prepublishOnly` gesperrt.
- Läuft auf Windows (Git Bash/CMD), macOS und Linux — Cross-Plattform-Verhalten ist Kerneigenschaft.
- `package-lock.json` wird nicht reviewt (automatisch ausgeschlossen).

## Regeln

- Keine Secrets, Keys oder Token im Code, in Configs oder in Logs.
- Kein `any` in neuem Code ohne Begründung (der Bestand ist `any`-frei — halten).
- Keine leeren catch-Blöcke: Fehler behandeln oder sichtbar durchreichen, nicht verschlucken.
- Cross-Plattform-Pflicht: Shell-, Pfad- und Prozess-Logik muss auf Windows und Unix funktionieren — bash-only Syntax in portablen Codepfaden ist ein Finding.
- Tool-Schemata und Ergebnisformate der `terminal_*`-Tools sind API-Verträge: keine stillen Breaking Changes; Vertragsänderungen im PR benennen.
- `peerDependencies` (`@earendil-works/pi-coding-agent`, `pi-tui`) nicht unnötig einschränken; Range-Änderungen im PR begründen.
- Version-Anheben von `smart-terminal-mcp` im PR begründen (welches Upstream-Feature/-Fix wird genutzt).
- Neue Logik in `src/` braucht Vitest-Tests in `test/` oder eine PR-Begründung, warum nicht.
- Release-Publishing nicht schwächen: `prepublishOnly`-Sperre, OIDC-Trusted-Publishing-Pfad und die NPM_TOKEN-Auth-Pfade in `release.yml` sind bewusst so gebaut.
- Neue Config-Keys in `src/config.ts` brauchen Default, Merge-Logik und einen Testfall in `test/config.test.ts`.

## Bekannte Kontexte (nicht als Finding melden)

- Dieses Repo ist public und kann deshalb den privaten reusable Workflow in `pungggi/ai-review` nicht aufrufen (GitHub-Plattformbeschränkung). Die Dateien `.github/workflows/ai-review.yml`, `.github/workflows/ai-review-sweep.yml` und `.github/scripts/ai_review.py` sind deshalb eine bewusste Vollkopie (Standalone-Modus von `pungggi/ai-review`, siehe dessen `scripts/seed-repo.sh`) — Updates kommen per Übernahme aus dem Zentral-Repo, kein zu dünner Stub, kein Tippfehler.
- Bei Fork-PRs liefert GitHub keine Secrets — der AI-Check schlägt dort fehl bzw. wird übersprungen; das ist bekannt und kein Finding in den Workflow-Dateien.
- `release.yml` unterstützt bewusst zwei Auth-Pfade (OIDC Trusted Publishing ohne `NPM_TOKEN` UND Classic Token); das umständliche Leer-Token-Handling ist Absicht (actions/setup-node#1551), kein toter Code.
- `npm-support-ticket.md` und `docs/` sind Arbeits- und Doku-Dateien, kein Produktionscode.
- `src/upstream.d.ts` enthält lokale Typ-Deklarationen für Upstream-APIs — Abweichungen von den Original-Typen sind bewusst minimal gehalten.
- Slot-Check in beiden Workflows: numerische Validierung (`elif ! [[ =~ ^[0-9]+$ ]]`) und explizite if/then-Form sind vorhanden und getestet (leer / nicht-numerisch / Wrap / Normal). Der zitierte Legacy-Ausdruck `IN=$(... && echo true || echo false)` existiert nicht mehr; Precedence-Diskussionen dazu sind obsolet.
- Cron `5-59/20 18-23,0-1` und das exklusive Slot-Ende (`H < E`) sind konsistent: Block = 18:00–01:59 UTC, identisch zum zentralen Sweep in `pungggi/ai-review` — keine Abdeckungslücke, Stunde 2 wäre per Slot-Check ein No-Op.
- Die gemeinsame concurrency-Gruppe `ai-review` beider Workflows ist bewusst: genau ein Review-Run gleichzeitig (Fair Use, „1 Request gleichzeitig pro Key" — siehe Kommentar im Script).
- Außerhalb des Slots wird der Review-Step bewusst übersprungen; das Step-Log dokumentiert `in_slot=...` — kein stiller Ausfall.
- `.github/scripts/ai_review.py` ist eine Vollkopie aus `pungggi/ai-review`: Code-Verbesserungen daran (call_llm-Retry-Struktur — der Retry-Call liegt innerhalb des äußeren try/except und wird von den 429/5xx-Handlern abgedeckt, parse_review-Fence-Handling, Verhalten bei Inline-POST-Fehlern) gehören upstream ins Zentral-Repo, nicht in diesen PR.
- Diese Datei selbst ist Konfiguration für den Reviewer: eine Regel pro Zeile ist Format, kein Stilfehler.
