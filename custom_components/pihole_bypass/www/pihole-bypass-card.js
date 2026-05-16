/**
 * PiHole Bypass Card for Home Assistant
 * Compatible with HA 2023.x+
 */

// Wait for HA custom card helpers to be available
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
    this._duration = 10;
    this._activeTimers = {};
    this._loading = false;
    this._error = "";
    this._timerInterval = null;
    this._initialized = false;
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
  }

  disconnectedCallback() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  getCardSize() {
    return 5;
  }

  // ── Data fetching ─────────────────────────────────────────────────────────

  async _apiGet(action) {
    const resp = await fetch(`/api/pihole_bypass/${action}`, {
      headers: { Authorization: `Bearer ${this._hass.auth.data.access_token}` },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }

  async _apiPost(action, body) {
    const resp = await fetch(`/api/pihole_bypass/${action}`, {
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
    try {
      const [clientsResp, groupsResp, timersResp] = await Promise.all([
        this._apiGet("clients"),
        this._apiGet("groups"),
        this._apiGet("timers"),
      ]);
      this._clients = clientsResp?.clients ?? [];
      this._groups = groupsResp?.groups ?? [];
      this._activeTimers = timersResp?.timers ?? {};
      if (!this._selectedClient && this._clients.length > 0) {
        this._selectedClient = this._clients[0].ip ?? "";
      }
    } catch (e) {
      this._error = `Ladefehler: ${e.message}`;
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _tickTimers() {
    let changed = false;
    for (const ip of Object.keys(this._activeTimers)) {
      const t = this._activeTimers[ip];
      if (t.remaining_seconds > 0) {
        t.remaining_seconds = Math.max(0, t.remaining_seconds - 1);
        changed = true;
        if (t.remaining_seconds === 0) {
          setTimeout(() => this._loadData(), 2500);
        }
      }
    }
    if (changed) this._render();
  }

  // ── Actions ───────────────────────────────────────────────────────────────

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

  _toggleGroup(groupId) {
    if (this._selectedGroups.includes(groupId)) {
      this._selectedGroups = this._selectedGroups.filter((g) => g !== groupId);
    } else {
      this._selectedGroups = [...this._selectedGroups, groupId];
    }
    this._render();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  _clientName(ip) {
    const c = this._clients.find((x) => x.ip === ip);
    return c ? (c.comment || c.name || c.ip) : ip;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    const timers = Object.entries(this._activeTimers);
    const canActivate = !this._loading && this._selectedClient && this._selectedGroups.length > 0;

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
          padding: 14px 18px;
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .header-icon { font-size: 26px; }
        .header-text h2 { margin: 0; color: #fff; font-size: 15px; font-weight: 700; }
        .header-text p  { margin: 2px 0 0; color: rgba(255,255,255,.75); font-size: 11px; }

        .body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

        .label {
          font-size: 10px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .9px; color: var(--secondary-text-color, #9e9e9e);
          margin-bottom: 5px;
        }

        select, input[type=number] {
          width: 100%; padding: 9px 11px; border-radius: 9px;
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

        .groups-grid {
          display: grid; grid-template-columns: repeat(auto-fill, minmax(120px,1fr));
          gap: 7px; max-height: 150px; overflow-y: auto; padding: 2px;
        }
        .chip {
          padding: 7px 10px; border-radius: 8px; cursor: pointer; user-select: none;
          border: 1.5px solid var(--divider-color, rgba(255,255,255,.12));
          background: var(--secondary-background-color, rgba(255,255,255,.04));
          color: var(--primary-text-color, #fff); font-size: 12px;
          display: flex; align-items: center; gap: 7px;
          transition: all .18s;
        }
        .chip:hover { border-color: #e63946; background: rgba(230,57,70,.08); }
        .chip.on { border-color: #e63946; background: rgba(230,57,70,.15); color: #e63946; font-weight: 600; }
        .chip-box {
          width: 15px; height: 15px; border-radius: 4px;
          border: 1.5px solid currentColor; display: flex; align-items: center; justify-content: center;
          flex-shrink: 0; font-size: 9px;
        }
        .chip.on .chip-box { background: #e63946; border-color: #e63946; color: #fff; }

        .dur-row { display: flex; gap: 7px; align-items: stretch; }
        .dur-wrap { flex: 1; position: relative; }
        .dur-wrap input { padding-right: 42px; }
        .dur-unit {
          position: absolute; right: 11px; top: 50%; transform: translateY(-50%);
          font-size: 11px; color: var(--secondary-text-color, #9e9e9e); pointer-events: none;
        }
        .quick-btns { display: flex; gap: 5px; }
        .qbtn {
          padding: 9px 10px; border-radius: 9px; cursor: pointer;
          border: 1px solid var(--divider-color, rgba(255,255,255,.12));
          background: var(--secondary-background-color, rgba(255,255,255,.05));
          color: var(--secondary-text-color, #9e9e9e); font-size: 11px; font-weight: 700;
          transition: all .18s; white-space: nowrap;
        }
        .qbtn:hover { border-color: #e63946; color: #e63946; background: rgba(230,57,70,.08); }

        .timer-box {
          background: rgba(230,57,70,.08); border: 1px solid rgba(230,57,70,.3);
          border-radius: 11px; padding: 12px 14px;
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
        }
        .timer-left { flex: 1; display: flex; flex-direction: column; gap: 2px; overflow: hidden; }
        .timer-lbl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .9px; color: #e63946; }
        .timer-client { font-size: 12px; color: var(--primary-text-color,#fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .timer-bar-wrap { margin-top: 6px; height: 3px; background: rgba(230,57,70,.15); border-radius: 2px; overflow: hidden; }
        .timer-bar { height: 100%; background: linear-gradient(90deg,#e63946,#ff6b6b); border-radius: 2px; transition: width 1s linear; }
        .timer-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
        .timer-cd { font-size: 26px; font-weight: 800; color: #e63946; font-variant-numeric: tabular-nums; font-family: 'Courier New', monospace; }

        .btn-activate {
          width: 100%; padding: 12px; border-radius: 11px; border: none;
          background: ${canActivate ? "linear-gradient(135deg,#e63946,#c1121f)" : "rgba(255,255,255,.08)"};
          color: ${canActivate ? "#fff" : "var(--secondary-text-color,#9e9e9e)"};
          font-size: 14px; font-weight: 700; cursor: ${canActivate ? "pointer" : "not-allowed"};
          box-shadow: ${canActivate ? "0 4px 14px rgba(230,57,70,.4)" : "none"};
          transition: all .2s; display: flex; align-items: center; justify-content: center; gap: 8px;
        }
        .btn-activate:hover:not([disabled]) { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(230,57,70,.5); }

        .btn-cancel {
          padding: 8px 12px; border-radius: 8px; cursor: pointer;
          border: 1.5px solid rgba(230,57,70,.4); background: transparent;
          color: #e63946; font-size: 12px; font-weight: 600;
          transition: background .18s;
        }
        .btn-cancel:hover { background: rgba(230,57,70,.1); }

        .btn-reload {
          background: none; border: 1px solid var(--divider-color, rgba(255,255,255,.12));
          border-radius: 8px; padding: 4px 8px; cursor: pointer;
          color: var(--secondary-text-color,#9e9e9e); font-size: 15px; line-height: 1;
          transition: color .18s, border-color .18s;
        }
        .btn-reload:hover { color: var(--primary-text-color,#fff); border-color: var(--primary-text-color,#fff); }

        .error {
          background: rgba(230,57,70,.1); border: 1px solid rgba(230,57,70,.3);
          border-radius: 9px; padding: 9px 13px; font-size: 12px; color: #e63946;
          display: flex; align-items: flex-start; gap: 7px;
        }

        .empty { text-align: center; padding: 10px; color: var(--secondary-text-color,#9e9e9e); font-size: 12px; font-style: italic; }

        .spin {
          display: inline-block; width: 14px; height: 14px;
          border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
          border-radius: 50%; animation: spin .7s linear infinite;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        .row-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 5px; }
        .divider { height: 1px; background: var(--divider-color, rgba(255,255,255,.07)); }
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
                <div class="timer-left">
                  <span class="timer-lbl">⏱ Aktiver Bypass</span>
                  <span class="timer-client">${this._clientName(ip)}</span>
                  <div class="timer-bar-wrap"><div class="timer-bar" style="width:${pct}%"></div></div>
                </div>
                <div class="timer-right">
                  <span class="timer-cd">${this._fmt(info.remaining_seconds)}</span>
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
            ${this._clients.length === 0
              ? `<div class="empty">${this._loading ? "Lade…" : "Keine Clients gefunden — PiHole-Verbindung prüfen"}</div>`
              : `<select id="clientSel">
                  <option value="">-- Client wählen --</option>
                  ${this._clients.map(c =>
                    `<option value="${c.ip}" ${c.ip === this._selectedClient ? "selected" : ""}>
                      ${c.comment || c.name || c.ip}${c.comment && c.comment !== c.ip ? ` (${c.ip})` : ""}
                      ${ip in this._activeTimers ? " 🔴" : ""}
                    </option>`
                  ).join("")}
                </select>`}
          </div>

          <!-- Groups -->
          <div>
            <div class="label">Gruppen (${this._selectedGroups.length} gewählt)</div>
            ${this._groups.length === 0
              ? `<div class="empty">${this._loading ? "Lade…" : "Keine Gruppen gefunden"}</div>`
              : `<div class="groups-grid">
                  ${this._groups.map(g => {
                    const on = this._selectedGroups.includes(g.id);
                    return `<div class="chip${on ? " on":" "}" data-gid="${g.id}">
                      <div class="chip-box">${on ? "✓" : ""}</div>
                      <span>${g.name || "Gruppe " + g.id}</span>
                    </div>`;
                  }).join("")}
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
                ${[5,10,30,60].map(t => `<button class="qbtn" data-min="${t}">${t}m</button>`).join("")}
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

    // Bind events after render
    this.shadowRoot.getElementById("reloadBtn")?.addEventListener("click", () => this._loadData());
    this.shadowRoot.getElementById("activateBtn")?.addEventListener("click", () => this._activateBypass());

    const clientSel = this.shadowRoot.getElementById("clientSel");
    if (clientSel) clientSel.addEventListener("change", (e) => { this._selectedClient = e.target.value; });

    const durInput = this.shadowRoot.getElementById("durInput");
    if (durInput) durInput.addEventListener("input", (e) => { this._duration = parseInt(e.target.value) || 10; });

    this.shadowRoot.querySelectorAll(".qbtn").forEach(btn =>
      btn.addEventListener("click", () => {
        this._duration = parseInt(btn.dataset.min);
        this._render();
      })
    );

    this.shadowRoot.querySelectorAll(".chip").forEach(chip =>
      chip.addEventListener("click", () => this._toggleGroup(parseInt(chip.dataset.gid)))
    );

    this.shadowRoot.querySelectorAll(".btn-cancel").forEach(btn =>
      btn.addEventListener("click", () => this._cancelBypass(btn.dataset.ip))
    );
  }

  static getConfigElement() {
    return document.createElement("pihole-bypass-card-editor");
  }

  static getStubConfig() {
    return { title: "PiHole Bypass", default_duration: 10 };
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
      </div>`;

    this.querySelectorAll("ha-textfield").forEach(el => {
      el.addEventListener("change", (e) => {
        const val = e.target.type === "number" ? parseInt(e.target.value) : e.target.value;
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
  "%c PIHOLE-BYPASS-CARD %c v1.1.0 ",
  "color:white;background:#e63946;font-weight:bold;padding:2px 6px;border-radius:3px 0 0 3px",
  "color:#e63946;background:#1c1c1e;font-weight:bold;padding:2px 6px;border-radius:0 3px 3px 0"
);
