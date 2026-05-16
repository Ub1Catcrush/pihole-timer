# 🛡️ PiHole Timed Bypass für Home Assistant

[![HACS Custom][hacs-badge]][hacs-url]
[![GitHub Release][release-badge]][release-url]
[![License][license-badge]][license-url]
[![Validate with HACS][validate-badge]][validate-url]

Eine Home Assistant Custom Integration mit Lovelace Card zum **temporären Umgehen der PiHole-Filterung** für einzelne Clients – mit automatischer Wiederherstellung nach Timer-Ablauf.

![PiHole Bypass Card Screenshot](https://raw.githubusercontent.com/Ub1Catcrush/pihole-timer/master/docs/screenshot.png)

---

## ✨ Features

- 🛡️ **Bypass aktivieren** – Weist einem Client temporär andere PiHole-Gruppen zu
- ⏱️ **Automatische Wiederherstellung** – Ursprüngliche Gruppen werden nach Timer-Ablauf wiederhergestellt
- 🔄 **Timer-Persistenz** – Timer überlebt einen Home Assistant Neustart
- 🎛️ **Flexible Dauer** – 1–1440 Minuten, Schnell-Buttons für 5/10/30/60 min
- 👥 **Mehrere Gruppen** – Mehrere Zielgruppen gleichzeitig auswählbar
- ❌ **Manueller Abbruch** – Timer kann jederzeit beendet werden
- 🔔 **HA Events** – Feuert Events für Automatisierungen

> **Voraussetzung:** PiHole **v6+** (neue REST API)

---

## 📦 Installation via HACS (empfohlen)

### 1. Als Custom Repository hinzufügen

1. HACS in Home Assistant öffnen
2. Oben rechts: **⋮ → Custom repositories**
3. Repository URL eingeben: `https://github.com/Ub1Catcrush/pihole-timer`
4. Kategorie: **Integration**
5. **Add** klicken

[![Zu HACS hinzufügen][hacs-install-badge]][hacs-install-url]

### 2. Integration installieren

1. In HACS nach **"PiHole Bypass"** suchen
2. **Download** klicken
3. Home Assistant neu starten

### 3. Lovelace Card als Frontend-Ressource registrieren

Über die UI: **Einstellungen → Dashboards → ⋮ → Ressourcen → Ressource hinzufügen**

| Feld | Wert |
|------|------|
| URL | `/local/pihole-bypass-card/pihole-bypass-card.js` |
| Ressourcentyp | JavaScript-Modul |

Oder in `configuration.yaml`:

```yaml
lovelace:
  resources:
    - url: /local/pihole-bypass-card/pihole-bypass-card.js
      type: module
```

---

## ⚙️ Konfiguration

### Integration einrichten

1. **Einstellungen → Geräte & Dienste → Integration hinzufügen**
2. Nach **"PiHole Bypass"** suchen
3. Daten eingeben:

| Feld | Beschreibung |
|------|-------------|
| Name | Anzeigename (z.B. "PiHole Heimnetz") |
| Host | IP oder Hostname deines PiHole (z.B. `192.168.1.100`) |
| API Passwort | Findest du in PiHole unter **Settings → API** |

### Karte zum Dashboard hinzufügen

Karte manuell per YAML hinzufügen:

```yaml
type: custom:pihole-bypass-card
title: PiHole Bypass
default_duration: 10
```

#### Alle Optionen

| Option | Typ | Standard | Beschreibung |
|--------|-----|---------|--------------|
| `title` | string | `"PiHole Bypass"` | Kartentitel |
| `default_duration` | number | `10` | Standard-Dauer in Minuten |
| `default_client` | string | – | Vorausgewählte Client-IP |
| `default_groups` | list | `[]` | Vorausgewählte Gruppen-IDs |

**Beispiel mit Voreinstellungen:**

```yaml
type: custom:pihole-bypass-card
title: YouTube freischalten
default_duration: 30
default_client: "192.168.1.42"
default_groups:
  - 2
```

---

## 🚀 Verwendung

### PiHole vorbereiten (Empfehlung)

1. PiHole Weboberfläche → **Group Management → Groups**
2. Neue Gruppe erstellen, z.B. `Bypass` oder `Freigabe`
3. Dieser Gruppe **keine Blocklisten** zuweisen
4. Clients in **Group Management → Clients** anlegen (falls noch nicht vorhanden)

### Bypass aktivieren

1. **Client** aus der Liste wählen
2. **Zielgruppe(n)** auswählen (z.B. "Bypass")
3. **Dauer** festlegen
4. Roten Button klicken → Timer läuft
5. Nach Ablauf: Gruppen werden automatisch wiederhergestellt

---

## 🔔 Events & Automatisierungen

Die Integration feuert folgende HA-Events:

| Event | Auslöser | Daten |
|-------|---------|-------|
| `pihole_timer_bypass_activated` | Bypass gestartet | `client_ip`, `groups`, `end_time` |
| `pihole_timer_bypass_expired` | Timer abgelaufen | `client_ip`, `restored_groups` |
| `pihole_timer_bypass_cancelled` | Manuell abgebrochen | `client_ip` |

**Beispiel-Automatisierung:**

```yaml
automation:
  - alias: "Benachrichtigung bei Bypass-Aktivierung"
    trigger:
      platform: event
      event_type: pihole_timer_bypass_activated
    action:
      service: notify.mobile_app_mein_handy
      data:
        title: "🛡️ PiHole Bypass aktiv"
        message: >
          Bypass für {{ trigger.event.data.client_ip }} aktiviert.
          Endet um {{ trigger.event.data.end_time }}.
```

---

## 🛠️ Services

| Service | Parameter | Beschreibung |
|---------|-----------|-------------|
| `pihole_timer.activate_bypass` | `client_ip`, `groups`, `duration_minutes` | Bypass aktivieren |
| `pihole_timer.deactivate_bypass` | `client_ip` | Bypass beenden |
| `pihole_timer.get_clients` | – | Clients neu laden |
| `pihole_timer.get_groups` | – | Gruppen neu laden |

---

## 🐛 Troubleshooting

**Verbindung schlägt fehl:**
- PiHole v6+ erforderlich (neue REST API unter `/api/`)
- Teste manuell: `curl http://PIHOLE_IP/api/auth`
- Firewall / VLAN-Routing prüfen

**Clients werden nicht angezeigt:**
- Clients müssen in PiHole unter **Group Management → Clients** angelegt sein
- ↻ Neu-Laden-Button in der Karte verwenden

**Timer läuft nach HA-Neustart nicht weiter:**
- Nur der verbleibende Rest wird fortgesetzt, nicht von vorne gestartet
- Überprüfe die HA-Logs auf Fehler beim Laden der Integration

---

## 📄 Lizenz

[MIT License](LICENSE) – Freie Verwendung, Modifikation und Weiterverteilung erlaubt.

---

[hacs-badge]: https://img.shields.io/badge/HACS-Custom-orange.svg
[hacs-url]: https://hacs.xyz
[release-badge]: https://img.shields.io/github/release/Ub1Catcrush/pihole-timer.svg
[release-url]: https://github.com/Ub1Catcrush/pihole-timer/releases
[license-badge]: https://img.shields.io/github/license/Ub1Catcrush/pihole-timer.svg
[license-url]: https://github.com/Ub1Catcrush/pihole-timer/blob/main/LICENSE
[validate-badge]: https://github.com/Ub1Catcrush/pihole-timer/actions/workflows/validate.yml/badge.svg
[validate-url]: https://github.com/Ub1Catcrush/pihole-timer/actions/workflows/validate.yml
[hacs-install-badge]: https://my.home-assistant.io/badges/hacs_repository.svg
[hacs-install-url]: https://my.home-assistant.io/redirect/hacs_repository/?owner=Ub1Catcrush&repository=pihole-timer&category=integration
