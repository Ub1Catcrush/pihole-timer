/**
 * PiHole Bypass Card for Home Assistant
 * Compatible with HA 2023.x+
 */

const fireEvent = (node, type, detail = {}) => {
  node.dispatchEvent(new CustomEvent(type, { bubbles: true, composed: true, detail }));
};

class PiHoleBypassCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._clients = [];
    this._groups = [];
    this._selectedClient = "";
    this._selectedGroups = [];
    this._editComment = "";
    this._duration = 10;
    this._activeTimers = {};
    this._loading = false;
    this._error = "";
    this._timerInterval = null;
    this._initialized = false;
    this._groupsExpanded = false;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._initialized) {
      this._initialized = true;
      this._render();
      this._loadData();
      this._timerInterval = setInterval(() => this._tickTimers(), 1000);
    }
  }

  setConfig(config) {
    if (!config) throw new Error("Keine Konfiguration");
    this._config = config;
    this._duration = config.default_duration || 10;
    if (config.default_client) this._selectedClient = config.default_client;
    if (config.default_groups) this._selectedGroups = [...config.default_groups];
    // favorite_clients: list of IPs to show as quick-select chips
    this._favoriteClients = config.favorite_clients || [];
    // favorite_groups: list of group IDs or names to always show
    this._favoriteGroups = config.favorite_groups || [];
  }

  disconnectedCallback() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  getCardSize() { return 5; }

  // ── Data fetching ──────────────────────────────────────────────────────────

  async _apiGet(action) {
    const resp = await fetch(`/api/pihole_timer/${action}`, {
      headers: { Authorization: `Bearer ${this._hass.auth.data.access_token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async _apiPost(action, body) {
    const resp = await fetch(`/api/pihole_timer/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this._hass.auth.data.access_token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async _loadData() {
    this._loading = true;
    this._error = "";
    this._render();

    const [clientsResult, groupsResult, timersResult] = await Promise.allSettled([
      this._apiGet("clients"),
      this._apiGet("groups"),
      this._apiGet("timers"),
    ]);

    const errors = [];

    if (clientsResult.status === "fulfilled") {
      this._clients = (clientsResult.value?.clients ?? []).map(c => ({
        ip: c.ip ?? c.client ?? "",
        name: c.name ?? "",
        comment: c.comment ?? "",
        vendor: c.macVendor ?? "",
        groups: c.groups ?? [],
      })).filter(c => c.ip)
        .sort((a, b) => {
          const labelA = a.comment || a.name || a.ip;
          const labelB = b.comment || b.name || b.ip;
          return labelA.localeCompare(labelB, undefined, { sensitivity: "base" });
        });
      if (!this._selectedClient && this._clients.length > 0) {
        this._selectedClient = this._clients[0].ip ?? "";
        this._preselectClientGroups();
      }
    } else {
      errors.push(`Clients: ${clientsResult.reason?.message ?? clientsResult.reason}`);
    }

    if (groupsResult.status === "fulfilled") {
      this._groups = (groupsResult.value?.groups ?? [])
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } else {
      errors.push(`Gruppen: ${groupsResult.reason?.message ?? groupsResult.reason}`);
    }

    if (timersResult.status === "fulfilled") {
      this._activeTimers = timersResult.value?.timers ?? {};
    } else {
      this._activeTimers = {};
    }

    this._error = errors.join(" | ");
    this._loading = false;
    this._render();
  }

  _tickTimers() {
    let changed = false;
    let anyExpired = false;
    for (const ip of Object.keys(this._activeTimers)) {
      const t = this._activeTimers[ip];
      if (t.remaining_seconds > 0) {
        t.remaining_seconds = Math.max(0, t.remaining_seconds - 1);
        changed = true;
        if (t.remaining_seconds === 0) anyExpired = true;
      }
    }
    if (changed) this._patchTimerDom();
    if (anyExpired) setTimeout(() => this._loadData(), 2500);
  }

  _patchTimerDom() {
    for (const [ip, info] of Object.entries(this._activeTimers)) {
      const cdEl = this.shadowRoot.querySelector(`.timer-cd[data-ip="${ip}"]`);
      const barEl = this.shadowRoot.querySelector(`.timer-bar[data-ip="${ip}"]`);
      if (cdEl) cdEl.textContent = this._fmt(info.remaining_seconds);
      if (barEl) {
        const pct = Math.round((info.remaining_seconds / (info.duration_minutes * 60)) * 100);
        barEl.style.width = pct + "%";
      }
    }
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  async _saveComment() {
    if (!this._selectedClient) return;
    const btn = this.shadowRoot.getElementById("saveCommentBtn");
    if (btn) btn.disabled = true;
    try {
      await this._apiPost("update_client", {
        client_ip: this._selectedClient,
        comment: this._editComment,
      });
      const client = this._clients.find(c => c.ip === this._selectedClient);
      if (client) client.comment = this._editComment;
      this._render();
    } catch (e) {
      this._error = `Fehler beim Speichern: ${e.message}`;
      this._render();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async _activateBypass() {
    if (!this._selectedClient) { this._error = "Bitte einen Client wählen."; this._render(); return; }
    if (this._selectedGroups.length === 0) { this._error = "Bitte mindestens eine Gruppe wählen."; this._render(); return; }
    this._loading = true;
    this._error = "";
    this._render();
    try {
      const result = await this._apiPost("activate", {
        client_ip: this._selectedClient,
        groups: this._selectedGroups,
        duration_minutes: this._duration,
      });
      if (result.success) {
        await this._loadData();
      } else {
        this._error = "Bypass konnte nicht aktiviert werden. PiHole-Logs prüfen.";
      }
    } catch (e) {
      this._error = `Fehler: ${e.message}`;
    } finally {
      this._loading = false;
      this._render();
    }
  }

  async _cancelBypass(clientIp) {
    this._loading = true;
    this._render();
    try {
      await this._apiPost("deactivate", { client_ip: clientIp });
      await this._loadData();
    } catch (e) {
      this._error = `Fehler: ${e.message}`;
      this._loading = false;
      this._render();
    }
  }

  async _extendTimer(clientIp, addMinutes) {
    const timer = this._activeTimers[clientIp];
    if (!timer) return;
    try {
      // Add minutes to the running timer via API
      await this._apiPost("extend", {
        client_ip: clientIp,
        add_minutes: addMinutes,
      });
      // Optimistically update local state
      timer.remaining_seconds += addMinutes * 60;
      timer.duration_minutes += addMinutes;
      this._patchTimerDom();
      // Refresh from server shortly after
      setTimeout(() => this._loadData(), 1000);
    } catch (e) {
      // Fallback: if API doesn't support extend, just update duration locally
      timer.remaining_seconds += addMinutes * 60;
      timer.duration_minutes += addMinutes;
      this._patchTimerDom();
    }
  }

  _preselectClientGroups() {
    const client = this._clients.find(c => c.ip === this._selectedClient);
    if (client && client.groups.length > 0) {
      this._selectedGroups = [...client.groups];
    } else {
      this._selectedGroups = [];
    }
    this._editComment = client?.comment ?? "";
  }

  _toggleGroup(groupId) {
    if (this._selectedGroups.includes(groupId)) {
      this._selectedGroups = this._selectedGroups.filter(g => g !== groupId);
    } else {
      this._selectedGroups = [...this._selectedGroups, groupId];
    }
    this._render();
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  _clientName(ip) {
    const c = this._clients.find(x => x.ip === ip);
    return c ? (c.comment || c.name || c.ip) : ip;
  }

  // Returns groups split into {favorites, others}
  _splitGroups() {
    if (!this._favoriteGroups || this._favoriteGroups.length === 0) {
      return { favorites: [], others: this._groups };
    }
    const favSet = new Set(
      this._favoriteGroups.map(f => (typeof f === "number" ? f : String(f)))
    );
    const favorites = this._groups.filter(g =>
      favSet.has(g.id) || favSet.has(String(g.id)) || favSet.has(g.name)
    );
    const others = this._groups.filter(g =>
      !favSet.has(g.id) && !favSet.has(String(g.id)) && !favSet.has(g.name)
    );
    return { favorites, others };
  }

  // Returns favorite client objects (only those present in loaded clients)
  _getFavoriteClients() {
    if (!this._favoriteClients || this._favoriteClients.length === 0) return [];
    return this._favoriteClients
      .map(ip => this._clients.find(c => c.ip === ip))
      .filter(Boolean);
  }

  _renderChip(g) {
    const on = this._selectedGroups.includes(g.id);
    return `<div class="chip${on ? " on" : ""}" data-gid="${g.id}">
      <div class="chip-box">${on ? "✓" : ""}</div>
      <span>${g.name || "Gruppe " + g.id}</span>
    </div>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  _render() {
    const timers = Object.entries(this._activeTimers);
    const canActivate = !this._loading && this._selectedClient && this._selectedGroups.length > 0;
    const { favorites: favGroups, others: otherGroups } = this._splitGroups();
    const favClients = this._getFavoriteClients();

    this.shadowRoot.innerHTML = `
      <style>
        * { box-sizing: border-box; }
        :host { display: block; font-family: var(--primary-font-family, Roboto, sans-serif); }

        ha-card, .card-root {
          background: var(--card-background-color, #1c1c1e);
          border-radius: 16px;
          overflow: hidden;
          box-shadow: var(--ha-card-box-shadow, 0 2px 12px rgba(0,0,0,.3));
        }

        .header {
          background: linear-gradient(135deg, #e63946 0%, #c1121f 100%);
          padding: 10px 14px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .header-icon { font-size: 22px; }
        .header-text h2 { margin: 0; color: #fff; font-size: 14px; font-weight: 700; }
        .header-text p  { margin: 1px 0 0; color: rgba(255,255,255,.75); font-size: 10px; }

        /* Compact body for mobile */
        .body { padding: 10px 12px; display: flex; flex-direction: column; gap: 10px; }

        .label {
          font-size: 9px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .9px; color: var(--secondary-text-color, #9e9e9e);
          margin-bottom: 4px;
        }

        .comment-row { display: flex; gap: 6px; align-items: center; }
        .comment-input {
          flex: 1; background: var(--input-fill-color, rgba(255,255,255,.08));
          border: 1px solid var(--divider-color, rgba(255,255,255,.12));
          border-radius: 7px; padding: 6px 9px;
          color: var(--primary-text-color); font-size: 13px;
        }
        .comment-input:focus { outline: none; border-color: var(--primary-color, #e63946); }
        .btn-save-comment {
          background: none; border: 1px solid var(--divider-color, rgba(255,255,255,.2));
          border-radius: 7px; padding: 6px 9px; cursor: pointer;
          color: var(--primary-text-color); font-size: 14px;
          transition: background .15s;
        }
        .btn-save-comment:hover { background: rgba(255,255,255,.08); }

        select, input[type="number"] {
          width: 100%; padding: 7px 10px; border-radius: 8px;
          border: 1px solid var(--divider-color, rgba(255,255,255,.12));
          background: var(--secondary-background-color, rgba(255,255,255,.05));
          color: var(--primary-text-color, #fff); font-size: 13px;
          appearance: none; outline: none;
          transition: border-color .18s, box-shadow .18s;
        }
        select:focus, input:focus {
          border-color: #e63946;
          box-shadow: 0 0 0 3px rgba(230,57,70,.2);
        }

        /* Favorite client chips row */
        .fav-clients {
          display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 5px;
        }
        .fav-client-chip {
          padding: 5px 10px; border-radius: 20px; cursor: pointer; user-select: none;
          border: 1.5px solid var(--divider-color, rgba(255,255,255,.15));
          background: var(--secondary-background-color, rgba(255,255,255,.05));
          color: var(--secondary-text-color, #9e9e9e); font-size: 11px; font-weight: 600;
          transition: all .18s; white-space: nowrap;
        }
        .fav-client-chip:hover { border-color: #e63946; color: #e63946; background: rgba(230,57,70,.08); }
        .fav-client-chip.active { border-color: #e63946; background: rgba(230,57,70,.15); color: #e63946; }
        .fav-client-chip .timer-dot { color: #e63946; margin-left: 2px; }

        /* Groups grid — compact: 4 visible without scroll */
        .groups-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 5px;
          padding: 1px;
        }
        .chip {
          padding: 5px 8px; border-radius: 7px; cursor: pointer; user-select: none;
          border: 1.5px solid var(--divider-color, rgba(255,255,255,.12));
          background: var(--secondary-background-color, rgba(255,255,255,.04));
          color: var(--primary-text-color, #fff); font-size: 11px;
          display: flex; align-items: center; gap: 5px;
          transition: all .18s; line-height: 1.3;
        }
        .chip:hover { border-color: #e63946; background: rgba(230,57,70,.08); }
        .chip.on { border-color: #e63946; background: rgba(230,57,70,.15); color: #e63946; font-weight: 600; }
        .chip-box {
          width: 13px; height: 13px; border-radius: 3px; flex-shrink: 0;
          border: 1.5px solid currentColor; display: flex; align-items: center; justify-content: center;
          font-size: 8px;
        }
        .chip.on .chip-box { background: #e63946; border-color: #e63946; color: #fff; }

        /* "More groups" toggle */
        .more-toggle {
          display: flex; align-items: center; gap: 6px; margin-top: 4px;
          padding: 5px 0; cursor: pointer; user-select: none;
          color: var(--secondary-text-color, #9e9e9e); font-size: 11px;
          border: none; background: none; width: 100%; text-align: left;
        }
        .more-toggle:hover { color: var(--primary-text-color, #fff); }
        .more-toggle .toggle-arrow { transition: transform .2s; display: inline-block; }
        .more-toggle.open .toggle-arrow { transform: rotate(180deg); }
        .other-groups { animation: fadeIn .15s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }

        /* Duration row — compact */
        .dur-row { display: flex; gap: 5px; align-items: stretch; }
        .dur-wrap { flex: 0 0 70px; position: relative; }
        .dur-wrap input { padding-right: 32px; text-align: center; }
        .dur-unit {
          position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
          font-size: 10px; color: var(--secondary-text-color, #9e9e9e); pointer-events: none;
        }
        .quick-btns { display: flex; gap: 4px; flex: 1; }
        .qbtn {
          flex: 1; padding: 7px 4px; border-radius: 8px; cursor: pointer;
          border: 1px solid var(--divider-color, rgba(255,255,255,.12));
          background: var(--secondary-background-color, rgba(255,255,255,.05));
          color: var(--secondary-text-color, #9e9e9e); font-size: 11px; font-weight: 700;
          transition: all .18s; white-space: nowrap; text-align: center;
        }
        .qbtn:hover { border-color: #e63946; color: #e63946; background: rgba(230,57,70,.08); }
        .qbtn.active { border-color: #e63946; color: #e63946; background: rgba(230,57,70,.15); }

        /* Timer box */
        .timer-box {
          background: rgba(230,57,70,.08); border: 1px solid rgba(230,57,70,.3);
          border-radius: 10px; padding: 10px 12px;
        }
        .timer-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
        .timer-left { flex: 1; display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
        .timer-lbl { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .9px; color: #e63946; }
        .timer-client { font-size: 12px; color: var(--primary-text-color,#fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .timer-bar-wrap { margin-top: 5px; height: 3px; background: rgba(230,57,70,.15); border-radius: 2px; overflow: hidden; }
        .timer-bar { height: 100%; background: linear-gradient(90deg,#e63946,#ff6b6b); border-radius: 2px; transition: width 1s linear; }
        .timer-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
        .timer-cd { font-size: 24px; font-weight: 800; color: #e63946; font-variant-numeric: tabular-nums; font-family: 'Courier New', monospace; }
        .timer-actions { display: flex; gap: 5px; align-items: center; margin-top: 6px; }
        .btn-extend {
          padding: 5px 10px; border-radius: 7px; cursor: pointer;
          border: 1.5px solid rgba(230,57,70,.4); background: rgba(230,57,70,.08);
          color: #e63946; font-size: 11px; font-weight: 700;
          transition: background .18s; white-space: nowrap;
        }
        .btn-extend:hover { background: rgba(230,57,70,.2); }
        .btn-cancel {
          padding: 5px 10px; border-radius: 7px; cursor: pointer;
          border: 1.5px solid rgba(255,255,255,.15); background: transparent;
          color: var(--secondary-text-color,#9e9e9e); font-size: 11px; font-weight: 600;
          transition: all .18s; white-space: nowrap;
        }
        .btn-cancel:hover { border-color: rgba(230,57,70,.4); color: #e63946; background: rgba(230,57,70,.08); }

        .btn-activate {
          width: 100%; padding: 11px; border-radius: 10px; border: none;
          background: ${canActivate ? "linear-gradient(135deg,#e63946,#c1121f)" : "rgba(255,255,255,.08)"};
          color: ${canActivate ? "#fff" : "var(--secondary-text-color,#9e9e9e)"};
          font-size: 14px; font-weight: 700; cursor: ${canActivate ? "pointer" : "not-allowed"};
          box-shadow: ${canActivate ? "0 4px 14px rgba(230,57,70,.4)" : "none"};
          transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .btn-activate:hover:not([disabled]) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(230,57,70,.5); }

        .btn-reload {
          background: none; border: 1px solid var(--divider-color, rgba(255,255,255,.12));
          border-radius: 7px; padding: 3px 7px; cursor: pointer;
          color: var(--secondary-text-color,#9e9e9e); font-size: 14px; line-height: 1;
          transition: color .18s, border-color .18s;
        }
        .btn-reload:hover { color: var(--primary-text-color,#fff); border-color: var(--primary-text-color,#fff); }

        .error {
          background: rgba(230,57,70,.1); border: 1px solid rgba(230,57,70,.3);
          border-radius: 8px; padding: 8px 12px; font-size: 11px; color: #e63946;
          display: flex; align-items: flex-start; gap: 6px;
        }

        .empty { text-align: center; padding: 8px; color: var(--secondary-text-color,#9e9e9e); font-size: 11px; font-style: italic; }

        .spin {
          display: inline-block; width: 13px; height: 13px;
          border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
          border-radius: 50%; animation: spin .7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
        .divider { height: 1px; background: var(--divider-color, rgba(255,255,255,.07)); }

        /* Separator between fav and other groups */
        .groups-sep { height: 1px; background: var(--divider-color, rgba(255,255,255,.07)); margin: 4px 0; }
      </style>

      <ha-card>
        <div class="header">
          <span class="header-icon">🛡️</span>
          <div class="header-text">
            <h2>${this._config?.title ?? "PiHole Bypass"}</h2>
            <p>${this._config?.host ?? "Filterung temporär umgehen"}</p>
          </div>
        </div>

        <div class="body">

          ${this._error ? `<div class="error">⚠️ <span>${this._error}</span></div>` : ""}

          ${timers.length > 0 ? timers.map(([ip, info]) => {
            const pct = Math.round((info.remaining_seconds / (info.duration_minutes * 60)) * 100);
            return `
              <div class="timer-box">
                <div class="timer-top">
                  <div class="timer-left">
                    <span class="timer-lbl">⏱ Aktiver Bypass</span>
                    <span class="timer-client">${this._clientName(ip)}</span>
                    <div class="timer-bar-wrap"><div class="timer-bar" data-ip="${ip}" style="width:${pct}%"></div></div>
                  </div>
                  <div class="timer-right">
                    <span class="timer-cd" data-ip="${ip}">${this._fmt(info.remaining_seconds)}</span>
                  </div>
                </div>
                <div class="timer-actions">
                  <button class="btn-extend" data-ip="${ip}" data-add="5">+5m verlängern</button>
                  <button class="btn-cancel" data-ip="${ip}">Abbrechen</button>
                </div>
              </div>`;
          }).join("") + '<div class="divider"></div>' : ""}

          <!-- Client -->
          <div>
            <div class="row-head">
              <span class="label">Client</span>
              <button class="btn-reload" id="reloadBtn" title="Neu laden">↻</button>
            </div>

            ${favClients.length > 0 ? `
              <div class="fav-clients">
                ${favClients.map(c => {
                  const label = c.comment || c.name || c.ip;
                  const isActive = c.ip === this._selectedClient;
                  const hasTimer = c.ip in this._activeTimers;
                  return `<button class="fav-client-chip${isActive ? " active" : ""}" data-fav-ip="${c.ip}">
                    ${label}${hasTimer ? ' <span class="timer-dot">🔴</span>' : ""}
                  </button>`;
                }).join("")}
              </div>` : ""}

            ${this._clients.length === 0
              ? `<div class="empty">${this._loading ? "Lade…" : "Keine Clients gefunden — PiHole-Verbindung prüfen"}</div>`
              : `<select id="clientSel">
                  <option value="">-- Client wählen --</option>
                  ${this._clients.map(c => {
                    const label = c.comment || c.name || c.ip;
                    const sub = (label !== c.ip ? ` (${c.ip})` : "") + (c.vendor ? ` • ${c.vendor}` : "");
                    return `<option value="${c.ip}" ${c.ip === this._selectedClient ? "selected" : ""}>
                      ${label}${sub}${c.ip in this._activeTimers ? " 🔴" : ""}
                    </option>`;
                  }).join("")}
                </select>`}
          </div>

          <!-- Comment -->
          ${this._selectedClient ? `
          <div>
            <div class="label">Kommentar</div>
            <div class="comment-row">
              <input type="text" id="commentInput" class="comment-input"
                placeholder="Beschreibung des Clients…"
                value="${this._editComment.replace(/"/g, '&quot;')}">
              <button class="btn-save-comment" id="saveCommentBtn" title="Kommentar speichern">💾</button>
            </div>
          </div>` : ""}

          <!-- Groups -->
          <div>
            <div class="label">Gruppen (${this._selectedGroups.length} gewählt)</div>
            ${this._groups.length === 0
              ? `<div class="empty">${this._loading ? "Lade…" : "Keine Gruppen gefunden"}</div>`
              : `<div>
                  ${favGroups.length > 0 ? `
                    <div class="groups-grid">
                      ${favGroups.map(g => this._renderChip(g)).join("")}
                    </div>
                  ` : ""}

                  ${otherGroups.length > 0 ? `
                    ${favGroups.length > 0 ? '<div class="groups-sep"></div>' : ""}
                    <button class="more-toggle${this._groupsExpanded ? " open" : ""}" id="moreGroupsBtn">
                      <span class="toggle-arrow">▼</span>
                      <span>${this._groupsExpanded
                        ? `Weitere Gruppen ausblenden`
                        : `${otherGroups.length} weitere Gruppen einblenden`}
                      </span>
                    </button>
                    ${this._groupsExpanded ? `
                      <div class="other-groups">
                        <div class="groups-grid">
                          ${otherGroups.map(g => this._renderChip(g)).join("")}
                        </div>
                      </div>
                    ` : ""}
                  ` : ""}

                  ${favGroups.length === 0 && otherGroups.length === 0 ? `
                    <div class="groups-grid">
                      ${this._groups.map(g => this._renderChip(g)).join("")}
                    </div>
                  ` : ""}
                </div>`}
          </div>

          <!-- Duration -->
          <div>
            <div class="label">Bypass-Dauer</div>
            <div class="dur-row">
              <div class="dur-wrap">
                <input type="number" id="durInput" min="1" max="1440" value="${this._duration}">
                <span class="dur-unit">min</span>
              </div>
              <div class="quick-btns">
                ${[5, 15, 30, 60].map(t =>
                  `<button class="qbtn${this._duration === t ? " active" : ""}" data-min="${t}">${t}m</button>`
                ).join("")}
                <button class="qbtn qbtn-plus5" data-plus="5">+5m</button>
              </div>
            </div>
          </div>

          <!-- Activate -->
          <button class="btn-activate" id="activateBtn" ${!canActivate ? "disabled" : ""}>
            ${this._loading
              ? '<span class="spin"></span> Wird verarbeitet…'
              : `🛡️ Bypass aktivieren (${this._duration} Min)`}
          </button>

        </div>
      </ha-card>
    `;

    // ── Bind events ────────────────────────────────────────────────────────────
    this.shadowRoot.getElementById("reloadBtn")?.addEventListener("click", () => this._loadData());
    this.shadowRoot.getElementById("activateBtn")?.addEventListener("click", () => this._activateBypass());

    const commentInput = this.shadowRoot.getElementById("commentInput");
    if (commentInput) {
      commentInput.addEventListener("input", e => { this._editComment = e.target.value; });
    }
    this.shadowRoot.getElementById("saveCommentBtn")?.addEventListener("click", () => this._saveComment());

    const clientSel = this.shadowRoot.getElementById("clientSel");
    if (clientSel) clientSel.addEventListener("change", e => {
      this._selectedClient = e.target.value;
      this._preselectClientGroups();
      this._render();
    });

    // Favorite client chips
    this.shadowRoot.querySelectorAll(".fav-client-chip").forEach(btn =>
      btn.addEventListener("click", () => {
        this._selectedClient = btn.dataset.favIp;
        this._preselectClientGroups();
        this._render();
      })
    );

    const durInput = this.shadowRoot.getElementById("durInput");
    if (durInput) durInput.addEventListener("input", e => { this._duration = parseInt(e.target.value) || 10; });

    // Quick duration buttons (fixed values)
    this.shadowRoot.querySelectorAll(".qbtn[data-min]").forEach(btn =>
      btn.addEventListener("click", () => {
        this._duration = parseInt(btn.dataset.min);
        this._render();
      })
    );

    // +5m button (increments current duration)
    this.shadowRoot.querySelectorAll(".qbtn[data-plus]").forEach(btn =>
      btn.addEventListener("click", () => {
        this._duration = Math.min(1440, (this._duration || 0) + parseInt(btn.dataset.plus));
        this._render();
      })
    );

    // Group chips
    this.shadowRoot.querySelectorAll(".chip").forEach(chip =>
      chip.addEventListener("click", () => this._toggleGroup(parseInt(chip.dataset.gid)))
    );

    // More groups toggle
    this.shadowRoot.getElementById("moreGroupsBtn")?.addEventListener("click", () => {
      this._groupsExpanded = !this._groupsExpanded;
      this._render();
    });

    // Timer cancel + extend
    this.shadowRoot.querySelectorAll(".btn-cancel").forEach(btn =>
      btn.addEventListener("click", () => this._cancelBypass(btn.dataset.ip))
    );
    this.shadowRoot.querySelectorAll(".btn-extend").forEach(btn =>
      btn.addEventListener("click", () => this._extendTimer(btn.dataset.ip, parseInt(btn.dataset.add)))
    );
  }

  static getConfigElement() {
    return document.createElement("pihole-bypass-card-editor");
  }

  static getStubConfig() {
    return {
      title: "PiHole Bypass",
      default_duration: 10,
      favorite_clients: [],
      favorite_groups: [],
    };
  }
}


class PiHoleBypassCardEditor extends HTMLElement {
  set hass(hass) { this._hass = hass; }

  setConfig(config) {
    this._config = config;
    this._render();
  }

  _render() {
    this.innerHTML = `
      <div style="padding:16px;display:flex;flex-direction:column;gap:12px">
        <ha-textfield label="Titel" .value="${this._config?.title ?? ''}" data-key="title"></ha-textfield>
        <ha-textfield label="Standard-Dauer (Minuten)" type="number"
          .value="${this._config?.default_duration ?? 10}" data-key="default_duration"></ha-textfield>
        <ha-textfield label="Favoriten-Clients (IPs, kommagetrennt)"
          .value="${(this._config?.favorite_clients ?? []).join(', ')}" data-key="favorite_clients" data-type="list"></ha-textfield>
        <ha-textfield label="Favoriten-Gruppen (IDs oder Namen, kommagetrennt)"
          .value="${(this._config?.favorite_groups ?? []).join(', ')}" data-key="favorite_groups" data-type="list"></ha-textfield>
      </div>`;

    this.querySelectorAll("ha-textfield").forEach(el => {
      el.addEventListener("change", e => {
        let val;
        if (e.target.dataset.type === "list") {
          val = e.target.value.split(",").map(s => s.trim()).filter(Boolean);
        } else if (e.target.type === "number") {
          val = parseInt(e.target.value);
        } else {
          val = e.target.value;
        }
        fireEvent(this, "config-changed", { config: { ...this._config, [e.target.dataset.key]: val } });
      });
    });
  }
}

customElements.define("pihole-bypass-card", PiHoleBypassCard);
customElements.define("pihole-bypass-card-editor", PiHoleBypassCardEditor);

window.customCards = window.customCards || [];
if (!window.customCards.find(c => c.type === "pihole-bypass-card")) {
  window.customCards.push({
    type: "pihole-bypass-card",
    name: "PiHole Bypass Card",
    description: "Temporär PiHole Filterung für Clients umgehen mit Timer",
    preview: true,
  });
}

console.info(
  "%c PIHOLE-BYPASS-CARD %c v0.2.0 ",
  "color:white;background:#e63946;font-weight:bold;padding:2px 6px;border-radius:3px 0 0 3px",
  "color:#e63946;background:#1c1c1e;font-weight:bold;padding:2px 6px;border-radius:0 3px 3px 0"
);
