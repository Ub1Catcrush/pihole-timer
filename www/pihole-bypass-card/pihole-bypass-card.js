/**
 * PiHole Bypass Card for Home Assistant
 * A Lovelace card to temporarily bypass PiHole filtering for specific clients
 */

const LitElement = Object.getPrototypeOf(customElements.get("ha-panel-lovelace"));
const html = LitElement.prototype.html;
const css = LitElement.prototype.css;

class PiHoleBypassCard extends LitElement {
  static get properties() {
    return {
      hass: {},
      config: {},
      _clients: { type: Array },
      _groups: { type: Array },
      _selectedClient: { type: String },
      _selectedGroups: { type: Array },
      _duration: { type: Number },
      _activeTimers: { type: Object },
      _loading: { type: Boolean },
      _error: { type: String },
      _timerInterval: { type: Object },
    };
  }

  constructor() {
    super();
    this._clients = [];
    this._groups = [];
    this._selectedClient = "";
    this._selectedGroups = [];
    this._duration = 10;
    this._activeTimers = {};
    this._loading = false;
    this._error = "";
    this._timerInterval = null;
  }

  static get styles() {
    return css`
      :host {
        display: block;
        font-family: var(--primary-font-family, 'Roboto', sans-serif);
      }

      ha-card {
        background: var(--card-background-color, #1c1c1e);
        border-radius: 16px;
        overflow: hidden;
        box-shadow: 0 4px 24px rgba(0,0,0,0.3);
      }

      .card-header {
        background: linear-gradient(135deg, #e63946 0%, #c1121f 100%);
        padding: 16px 20px;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .card-header .logo {
        width: 36px;
        height: 36px;
        background: rgba(255,255,255,0.15);
        border-radius: 10px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 20px;
      }

      .card-header .title-area h2 {
        margin: 0;
        color: white;
        font-size: 16px;
        font-weight: 700;
        letter-spacing: 0.3px;
      }

      .card-header .title-area p {
        margin: 2px 0 0;
        color: rgba(255,255,255,0.75);
        font-size: 12px;
      }

      .card-body {
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 16px;
      }

      .field-group {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .field-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: var(--secondary-text-color, #9e9e9e);
      }

      select, input[type="number"] {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        background: var(--secondary-background-color, rgba(255,255,255,0.05));
        color: var(--primary-text-color, #fff);
        font-size: 14px;
        appearance: none;
        -webkit-appearance: none;
        box-sizing: border-box;
        cursor: pointer;
        outline: none;
        transition: border-color 0.2s, box-shadow 0.2s;
      }

      select:focus, input[type="number"]:focus {
        border-color: #e63946;
        box-shadow: 0 0 0 3px rgba(230, 57, 70, 0.2);
      }

      select option {
        background: var(--card-background-color, #1c1c1e);
        color: var(--primary-text-color, #fff);
      }

      .groups-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
        gap: 8px;
        max-height: 160px;
        overflow-y: auto;
        padding: 2px;
      }

      .group-chip {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1.5px solid var(--divider-color, rgba(255,255,255,0.1));
        background: var(--secondary-background-color, rgba(255,255,255,0.04));
        cursor: pointer;
        transition: all 0.2s ease;
        font-size: 13px;
        color: var(--primary-text-color, #fff);
        user-select: none;
      }

      .group-chip:hover {
        border-color: #e63946;
        background: rgba(230, 57, 70, 0.08);
      }

      .group-chip.selected {
        border-color: #e63946;
        background: rgba(230, 57, 70, 0.15);
        color: #e63946;
        font-weight: 600;
      }

      .group-chip .check {
        width: 16px;
        height: 16px;
        border-radius: 4px;
        border: 1.5px solid currentColor;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 10px;
        transition: background 0.15s;
      }

      .group-chip.selected .check {
        background: #e63946;
        border-color: #e63946;
        color: white;
      }

      .duration-row {
        display: flex;
        gap: 8px;
        align-items: stretch;
      }

      .duration-input-wrap {
        flex: 1;
        position: relative;
      }

      .duration-input-wrap input {
        padding-right: 48px;
      }

      .duration-unit {
        position: absolute;
        right: 12px;
        top: 50%;
        transform: translateY(-50%);
        font-size: 12px;
        color: var(--secondary-text-color, #9e9e9e);
        pointer-events: none;
      }

      .quick-btns {
        display: flex;
        gap: 6px;
      }

      .quick-btn {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        background: var(--secondary-background-color, rgba(255,255,255,0.05));
        color: var(--secondary-text-color, #9e9e9e);
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s;
        white-space: nowrap;
      }

      .quick-btn:hover {
        border-color: #e63946;
        color: #e63946;
        background: rgba(230, 57, 70, 0.08);
      }

      .timer-display {
        background: linear-gradient(135deg, rgba(230, 57, 70, 0.1), rgba(193, 18, 31, 0.1));
        border: 1px solid rgba(230, 57, 70, 0.3);
        border-radius: 12px;
        padding: 14px 16px;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .timer-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .timer-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.8px;
        color: #e63946;
      }

      .timer-client {
        font-size: 13px;
        color: var(--primary-text-color, #fff);
        font-weight: 500;
      }

      .timer-countdown {
        font-size: 28px;
        font-weight: 800;
        color: #e63946;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.5px;
        font-family: 'Courier New', monospace;
      }

      .timer-progress {
        margin-top: 8px;
        height: 4px;
        background: rgba(230, 57, 70, 0.15);
        border-radius: 2px;
        overflow: hidden;
      }

      .timer-progress-bar {
        height: 100%;
        background: linear-gradient(90deg, #e63946, #ff6b6b);
        border-radius: 2px;
        transition: width 1s linear;
      }

      .actions {
        display: flex;
        gap: 10px;
      }

      .btn-activate {
        flex: 1;
        padding: 13px 20px;
        border-radius: 12px;
        border: none;
        background: linear-gradient(135deg, #e63946, #c1121f);
        color: white;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.3px;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        box-shadow: 0 4px 16px rgba(230, 57, 70, 0.4);
      }

      .btn-activate:hover:not(:disabled) {
        transform: translateY(-1px);
        box-shadow: 0 6px 20px rgba(230, 57, 70, 0.5);
      }

      .btn-activate:active:not(:disabled) {
        transform: translateY(0);
      }

      .btn-activate:disabled {
        opacity: 0.5;
        cursor: not-allowed;
        box-shadow: none;
      }

      .btn-cancel {
        padding: 13px 16px;
        border-radius: 12px;
        border: 1.5px solid rgba(230, 57, 70, 0.4);
        background: transparent;
        color: #e63946;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        transition: all 0.2s ease;
        white-space: nowrap;
      }

      .btn-cancel:hover {
        background: rgba(230, 57, 70, 0.1);
      }

      .btn-reload {
        padding: 10px;
        border-radius: 10px;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        background: transparent;
        color: var(--secondary-text-color, #9e9e9e);
        cursor: pointer;
        transition: all 0.2s;
        font-size: 16px;
        line-height: 1;
        display: flex;
        align-items: center;
      }

      .btn-reload:hover {
        color: var(--primary-text-color, #fff);
        border-color: var(--primary-text-color, #fff);
      }

      .error-box {
        background: rgba(230, 57, 70, 0.1);
        border: 1px solid rgba(230, 57, 70, 0.3);
        border-radius: 10px;
        padding: 10px 14px;
        font-size: 13px;
        color: #e63946;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .loading-spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.7s linear infinite;
      }

      @keyframes spin {
        to { transform: rotate(360deg); }
      }

      .empty-state {
        text-align: center;
        padding: 12px;
        color: var(--secondary-text-color, #9e9e9e);
        font-size: 13px;
        font-style: italic;
      }

      .divider {
        height: 1px;
        background: var(--divider-color, rgba(255,255,255,0.07));
        margin: 4px 0;
      }

      .groups-scroll::-webkit-scrollbar {
        width: 4px;
      }
      .groups-scroll::-webkit-scrollbar-track {
        background: transparent;
      }
      .groups-scroll::-webkit-scrollbar-thumb {
        background: rgba(255,255,255,0.1);
        border-radius: 2px;
      }
    `;
  }

  setConfig(config) {
    if (!config) throw new Error("Keine Konfiguration angegeben");
    this.config = config;
    this._duration = config.default_duration || 10;
    if (config.default_client) this._selectedClient = config.default_client;
    if (config.default_groups) this._selectedGroups = [...config.default_groups];
  }

  connectedCallback() {
    super.connectedCallback();
    this._loadData();
    this._timerInterval = setInterval(() => this._updateTimers(), 1000);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    if (this._timerInterval) clearInterval(this._timerInterval);
  }

  async _loadData() {
    this._loading = true;
    this._error = "";
    try {
      const [clientsResp, groupsResp, timersResp] = await Promise.all([
        this._apiGet("clients"),
        this._apiGet("groups"),
        this._apiGet("timers"),
      ]);
      this._clients = clientsResp?.clients || [];
      this._groups = groupsResp?.groups || [];
      this._activeTimers = timersResp?.timers || {};

      // Auto-select first client if none set
      if (!this._selectedClient && this._clients.length > 0) {
        this._selectedClient = this._clients[0].ip || this._clients[0].comment || "";
      }
    } catch (e) {
      this._error = `Fehler beim Laden: ${e.message}`;
    } finally {
      this._loading = false;
    }
  }

  _updateTimers() {
    // Decrement remaining_seconds locally for smooth display
    const updated = {};
    for (const [ip, info] of Object.entries(this._activeTimers)) {
      const remaining = Math.max(0, info.remaining_seconds - 1);
      updated[ip] = { ...info, remaining_seconds: remaining };
      if (remaining === 0) {
        // Reload from server
        setTimeout(() => this._loadData(), 2000);
      }
    }
    this._activeTimers = updated;
    this.requestUpdate();
  }

  async _apiGet(action) {
    const resp = await fetch(`/api/pihole_bypass/${action}`, {
      headers: {
        Authorization: `Bearer ${this.hass.auth.data.access_token}`,
      },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  async _apiPost(action, body) {
    const resp = await fetch(`/api/pihole_bypass/${action}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.hass.auth.data.access_token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  _toggleGroup(groupId) {
    if (this._selectedGroups.includes(groupId)) {
      this._selectedGroups = this._selectedGroups.filter((g) => g !== groupId);
    } else {
      this._selectedGroups = [...this._selectedGroups, groupId];
    }
  }

  async _activateBypass() {
    if (!this._selectedClient) {
      this._error = "Bitte wähle einen Client aus.";
      return;
    }
    if (this._selectedGroups.length === 0) {
      this._error = "Bitte wähle mindestens eine Gruppe aus.";
      return;
    }
    this._loading = true;
    this._error = "";
    try {
      const result = await this._apiPost("activate", {
        client_ip: this._selectedClient,
        groups: this._selectedGroups,
        duration_minutes: this._duration,
      });
      if (result.success) {
        await this._loadData();
      } else {
        this._error = "Bypass konnte nicht aktiviert werden.";
      }
    } catch (e) {
      this._error = `Fehler: ${e.message}`;
    } finally {
      this._loading = false;
    }
  }

  async _cancelBypass(clientIp) {
    this._loading = true;
    try {
      await this._apiPost("deactivate", { client_ip: clientIp });
      await this._loadData();
    } catch (e) {
      this._error = `Fehler: ${e.message}`;
    } finally {
      this._loading = false;
    }
  }

  _formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  _getClientName(clientIp) {
    const client = this._clients.find((c) => c.ip === clientIp || c.comment === clientIp);
    if (client) {
      return client.comment || client.name || client.ip;
    }
    return clientIp;
  }

  _isClientActive(clientIp) {
    return clientIp in this._activeTimers;
  }

  render() {
    const activeTimerEntries = Object.entries(this._activeTimers);
    const currentClientActive = this._isClientActive(this._selectedClient);

    return html`
      <ha-card>
        <div class="card-header">
          <div class="logo">🛡️</div>
          <div class="title-area">
            <h2>${this.config?.title || "PiHole Bypass"}</h2>
            <p>${this.config?.host || "Filterung temporär umgehen"}</p>
          </div>
        </div>

        <div class="card-body">
          ${this._error
            ? html`<div class="error-box">⚠️ ${this._error}</div>`
            : ""}

          <!-- Active Timers -->
          ${activeTimerEntries.length > 0
            ? html`
                ${activeTimerEntries.map(([ip, info]) => {
                  const totalSec = info.duration_minutes * 60;
                  const progress = (info.remaining_seconds / totalSec) * 100;
                  return html`
                    <div class="timer-display">
                      <div class="timer-info" style="flex:1">
                        <span class="timer-label">⏱ Aktiver Bypass</span>
                        <span class="timer-client">${this._getClientName(ip)}</span>
                        <div class="timer-progress">
                          <div class="timer-progress-bar" style="width:${progress}%"></div>
                        </div>
                      </div>
                      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:6px;margin-left:12px">
                        <span class="timer-countdown">${this._formatTime(info.remaining_seconds)}</span>
                        <button class="btn-cancel" @click=${() => this._cancelBypass(ip)}>
                          Abbrechen
                        </button>
                      </div>
                    </div>
                  `;
                })}
                <div class="divider"></div>
              `
            : ""}

          <!-- Client Selection -->
          <div class="field-group">
            <div style="display:flex;align-items:center;justify-content:space-between">
              <span class="field-label">Client</span>
              <button class="btn-reload" @click=${this._loadData} title="Neu laden">↻</button>
            </div>
            ${this._clients.length === 0
              ? html`<div class="empty-state">
                  ${this._loading ? "Lade Clients..." : "Keine Clients gefunden"}
                </div>`
              : html`
                  <select
                    .value=${this._selectedClient}
                    @change=${(e) => (this._selectedClient = e.target.value)}
                  >
                    <option value="">-- Client wählen --</option>
                    ${this._clients.map(
                      (c) => html`
                        <option value="${c.ip}" ?selected=${c.ip === this._selectedClient}>
                          ${c.comment || c.name || c.ip}
                          ${c.ip !== (c.comment || c.name) ? `(${c.ip})` : ""}
                          ${this._isClientActive(c.ip) ? " 🔴" : ""}
                        </option>
                      `
                    )}
                  </select>
                `}
          </div>

          <!-- Group Selection -->
          <div class="field-group">
            <span class="field-label">Gruppen (${this._selectedGroups.length} gewählt)</span>
            ${this._groups.length === 0
              ? html`<div class="empty-state">
                  ${this._loading ? "Lade Gruppen..." : "Keine Gruppen gefunden"}
                </div>`
              : html`
                  <div class="groups-grid groups-scroll">
                    ${this._groups.map(
                      (g) => html`
                        <div
                          class="group-chip ${this._selectedGroups.includes(g.id) ? "selected" : ""}"
                          @click=${() => this._toggleGroup(g.id)}
                        >
                          <span class="check">${this._selectedGroups.includes(g.id) ? "✓" : ""}</span>
                          <span>${g.name || `Gruppe ${g.id}`}</span>
                        </div>
                      `
                    )}
                  </div>
                `}
          </div>

          <!-- Duration -->
          <div class="field-group">
            <span class="field-label">Bypass-Dauer</span>
            <div class="duration-row">
              <div class="duration-input-wrap">
                <input
                  type="number"
                  min="1"
                  max="1440"
                  .value=${this._duration}
                  @input=${(e) => (this._duration = parseInt(e.target.value) || 10)}
                />
                <span class="duration-unit">min</span>
              </div>
              <div class="quick-btns">
                ${[5, 10, 30, 60].map(
                  (t) => html`
                    <button class="quick-btn" @click=${() => (this._duration = t)}>${t}m</button>
                  `
                )}
              </div>
            </div>
          </div>

          <!-- Activate Button -->
          <div class="actions">
            <button
              class="btn-activate"
              @click=${this._activateBypass}
              ?disabled=${this._loading || !this._selectedClient || this._selectedGroups.length === 0}
            >
              ${this._loading
                ? html`<span class="loading-spinner"></span> Wird aktiviert...`
                : html`🛡️ Bypass aktivieren (${this._duration} Min)`}
            </button>
          </div>
        </div>
      </ha-card>
    `;
  }

  static getConfigElement() {
    return document.createElement("pihole-bypass-card-editor");
  }

  static getStubConfig() {
    return {
      title: "PiHole Bypass",
      default_duration: 10,
    };
  }
}

// Card Editor
class PiHoleBypassCardEditor extends LitElement {
  static get properties() {
    return { hass: {}, config: {} };
  }

  static get styles() {
    return css`
      .editor-row {
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 16px;
      }
      label {
        font-size: 13px;
        font-weight: 500;
        color: var(--secondary-text-color);
      }
      ha-textfield {
        width: 100%;
      }
    `;
  }

  setConfig(config) {
    this.config = config;
  }

  _valueChanged(ev) {
    if (!this.config) return;
    const target = ev.target;
    const newConfig = { ...this.config, [target.configValue]: target.value };
    const event = new CustomEvent("config-changed", {
      detail: { config: newConfig },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  render() {
    if (!this.config) return html``;
    return html`
      <div class="editor-row">
        <label>Titel</label>
        <ha-textfield
          .value=${this.config.title || "PiHole Bypass"}
          .configValue=${"title"}
          @input=${this._valueChanged}
        ></ha-textfield>
        <label>Standard-Dauer (Minuten)</label>
        <ha-textfield
          type="number"
          .value=${this.config.default_duration || 10}
          .configValue=${"default_duration"}
          @input=${this._valueChanged}
        ></ha-textfield>
      </div>
    `;
  }
}

customElements.define("pihole-bypass-card", PiHoleBypassCard);
customElements.define("pihole-bypass-card-editor", PiHoleBypassCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "pihole-bypass-card",
  name: "PiHole Bypass Card",
  description: "Temporär PiHole Filterung für Clients umgehen mit Timer",
  preview: true,
});

console.info(
  "%c PIHOLE-BYPASS-CARD %c v1.0.0 ",
  "color: white; background: #e63946; font-weight: bold; padding: 2px 6px; border-radius: 3px 0 0 3px",
  "color: #e63946; background: #1c1c1e; font-weight: bold; padding: 2px 6px; border-radius: 0 3px 3px 0"
);
