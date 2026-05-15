# GitHub & HACS Setup – Schritt für Schritt

## Schritt 1: GitHub Repository erstellen

1. Gehe zu https://github.com/new
2. Repository-Name: `pihole-bypass-ha`
3. Beschreibung: `PiHole Bypass Integration for Home Assistant`
4. **Public** wählen (HACS erfordert öffentliche Repos)
5. **README** nicht vorab erstellen (wir haben schon eines)
6. **Create repository** klicken

---

## Schritt 2: Dateien hochladen

### Option A – GitHub Web-Upload (einfach)

1. Im neuen Repository: **Add file → Upload files**
2. Alle Dateien und Ordner aus dem ZIP hochladen
3. Commit-Nachricht: `Initial release v1.0.0`
4. **Commit changes** klicken

> Wichtig: Die Ordnerstruktur muss erhalten bleiben:
> ```
> custom_components/pihole_bypass/...
> www/pihole-bypass-card/...
> .github/workflows/...
> hacs.json
> README.md
> LICENSE
> ```

### Option B – Git CLI (empfohlen)

```bash
# ZIP entpacken
unzip pihole-bypass-ha.zip
cd pihole-bypass-ha

# Git initialisieren
git init
git add .
git commit -m "Initial release v1.0.0"

# Mit GitHub verbinden (URL anpassen!)
git remote add origin https://github.com/DEIN_USERNAME/pihole-bypass-ha.git
git branch -M main
git push -u origin main
```

---

## Schritt 3: README anpassen

Öffne `README.md` und ersetze **alle** Vorkommen von `YOUR_GITHUB_USERNAME` mit deinem echten GitHub-Benutzernamen.

Ebenso in `custom_components/pihole_bypass/manifest.json`:
```json
"documentation": "https://github.com/DEIN_USERNAME/pihole-bypass-ha",
"issue_tracker": "https://github.com/DEIN_USERNAME/pihole-bypass-ha/issues",
"codeowners": ["@DEIN_USERNAME"]
```

---

## Schritt 4: Ersten Release erstellen

HACS benötigt mindestens einen Release mit einem Git-Tag.

### Über die GitHub Web-Oberfläche:

1. Im Repository rechts: **Releases → Create a new release**
2. **Choose a tag** → Neuen Tag eingeben: `v1.0.0` → **Create new tag**
3. Release title: `v1.0.0`
4. Beschreibung: `Initial release`
5. **Publish release** klicken

→ GitHub Actions erstellt automatisch das Release-ZIP (dauert ~1 Minute)

### Über Git CLI:

```bash
git tag v1.0.0
git push origin v1.0.0
```

---

## Schritt 5: In HACS als Custom Repository hinzufügen

1. Home Assistant öffnen → **HACS**
2. Oben rechts: **⋮ → Custom repositories**
3. Eingeben:
   - **Repository:** `https://github.com/DEIN_USERNAME/pihole-bypass-ha`
   - **Category:** Integration
4. **Add** klicken
5. In HACS nach **"PiHole Bypass"** suchen → **Download**
6. Home Assistant neu starten

---

## Schritt 6: Lovelace Ressource registrieren

**Einstellungen → Dashboards → ⋮ → Ressourcen → + Hinzufügen**

| Feld | Wert |
|------|------|
| URL | `/local/pihole-bypass-card/pihole-bypass-card.js` |
| Typ | JavaScript-Modul |

---

## Neue Versionen veröffentlichen

```bash
# Änderungen committen
git add .
git commit -m "Fix: Beschreibung der Änderung"
git push

# Neuen Release taggen (GitHub Actions erstellt automatisch den Release)
git tag v1.1.0
git push origin v1.1.0
```

HACS erkennt neue Releases automatisch und zeigt ein Update-Banner an.

---

## Häufige Probleme

**HACS findet das Repository nicht:**
- Repository muss **Public** sein
- `hacs.json` muss im Root-Verzeichnis liegen
- Mindestens ein Release/Tag muss existieren

**"Integration not found" nach Installation:**
- HA neu starten
- Prüfen ob `custom_components/pihole_bypass/` korrekt in `/config/custom_components/` liegt

**Karte wird nicht geladen:**
- Lovelace Ressource prüfen (Pfad exakt wie oben)
- Browser-Cache leeren (Strg+Shift+R)
- HA-Entwicklertools → YAML neu laden
