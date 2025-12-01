var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
// music-airplay-outputs-card.ts
import { LitElement, html, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { appleMusicStore } from './store';
let MusicAirplayOutputsCard = class MusicAirplayOutputsCard extends LitElement {
    constructor() {
        super(...arguments);
        this._config = {};
        this._devices = [];
        this._current = new Set();
        this._vols = {};
        this._sseHealthy = false;
        this._unsubStore = null;
        this._deb = new Map();
        this._refresh = async () => {
            var _a, _b;
            // If SSE is healthy, rely on push but still do a quick pull to align names/volumes
            try {
                const list = await ((_a = this.hass) === null || _a === void 0 ? void 0 : _a.callApi('GET', 'apple_music/airplay_full'));
                if (Array.isArray(list))
                    this._applyAirplayList(list);
                // Also merge device_volumes for inactive devices if backend provides
                try {
                    const vols = await ((_b = this.hass) === null || _b === void 0 ? void 0 : _b.callApi('GET', 'apple_music/device_volumes'));
                    if (vols && typeof vols === 'object')
                        this._applyDeviceVolumesObj(vols);
                }
                catch ( /* ignore */_c) { /* ignore */ }
            }
            catch ( /* ignore */_d) { /* ignore */ }
        };
    }
    setConfig(config) {
        this._config = Object.assign({}, config);
    }
    render() {
        const title = this._config.title || 'AirPlay Outputs';
        return html `
      <ha-card .header=${title}>
        <div class="head">
          <div class="muted">SSE: ${this._sseHealthy ? 'Connected' : 'Polling'}</div>
          <div style="display:flex; gap:8px;">
            <button class="secondary" @click=${this._refresh}>Refresh</button>
          </div>
        </div>
        <div class="grid">
          ${this._devicesSorted().map((name) => this._renderDevice(name))}
        </div>
      </ha-card>
    `;
    }
    _renderDevice(name) {
        var _a;
        const checked = this._current.has(name);
        const vol01 = (_a = this._vols[name]) !== null && _a !== void 0 ? _a : 0;
        const vol = Math.max(0, Math.min(100, Math.round(vol01 * 100)));
        return html `
      <div class="card device" data-name=${name}>
        <header class="switch">
          <label style="display:flex;gap:8px;align-items:center;">
            <input type="checkbox" .checked=${checked} @change=${(e) => this._toggleDevice(name, e.target.checked)} />
            <span>${name}</span>
          </label>
          <span class="chip">${vol}%</span>
        </header>
        <div class="dev-volrow">
          <span class="muted">Vol</span>
          <input type="range" min="0" max="100" step="1" .value=${String(vol)} @input=${(e) => this._onVolInput(name, Number(e.target.value))} />
          <button class="secondary" @click=${() => this._bumpDevice(name, -5)} title="Down">−</button>
          <button class="secondary" @click=${() => this._bumpDevice(name, +5)} title="Up">+</button>
        </div>
      </div>
    `;
    }
    _devicesSorted() {
        const names = [...this._devices];
        names.sort((a, b) => {
            const ax = this._current.has(a) ? 0 : 1;
            const bx = this._current.has(b) ? 0 : 1;
            if (ax !== bx)
                return ax - bx;
            return a.localeCompare(b, undefined, { sensitivity: 'base' });
        });
        return names;
    }
    connectedCallback() {
        var _a, _b;
        super.connectedCallback();
        try {
            // Seed from store snapshot
            const snap = (_a = appleMusicStore === null || appleMusicStore === void 0 ? void 0 : appleMusicStore.snapshot) === null || _a === void 0 ? void 0 : _a.call(appleMusicStore);
            if (snap) {
                this._applySnapshot(snap);
            }
            // Subscribe for live updates
            this._unsubStore = ((_b = appleMusicStore === null || appleMusicStore === void 0 ? void 0 : appleMusicStore.subscribe) === null || _b === void 0 ? void 0 : _b.call(appleMusicStore, ({ event, data }) => {
                var _a, _b, _c;
                if (event === 'snapshot') {
                    this._applySnapshot(((data === null || data === void 0 ? void 0 : data.now) ? Object.assign(Object.assign({}, (_a = appleMusicStore.snapshot) === null || _a === void 0 ? void 0 : _a.call(appleMusicStore)), data) : (_b = appleMusicStore.snapshot) === null || _b === void 0 ? void 0 : _b.call(appleMusicStore)) || {});
                }
                else if (event === 'airplay_full') {
                    this._applyAirplayList(Array.isArray(data) ? data : []);
                }
                else if (event === 'device_volumes') {
                    this._applyDeviceVolumesObj(data);
                }
                else if (event === 'master_volume') {
                    // ignore here (per-device only)
                }
                // Track SSE health
                try {
                    const s = (_c = appleMusicStore === null || appleMusicStore === void 0 ? void 0 : appleMusicStore.snapshot) === null || _c === void 0 ? void 0 : _c.call(appleMusicStore);
                    if (s && typeof s.sseHealthy === 'boolean')
                        this._sseHealthy = !!s.sseHealthy;
                }
                catch ( /* ignore */_d) { /* ignore */ }
            })) || null;
        }
        catch ( /* ignore */_c) { /* ignore */ }
        // Also do a refresh pass
        this._refresh();
    }
    disconnectedCallback() {
        super.disconnectedCallback();
        if (this._unsubStore) {
            try {
                this._unsubStore();
            }
            catch ( /* ignore */_a) { /* ignore */ }
            this._unsubStore = null;
        }
        // Clear debouncers
        for (const t of this._deb.values())
            clearTimeout(t);
        this._deb.clear();
    }
    _applySnapshot(snap) {
        try {
            const air = Array.isArray(snap === null || snap === void 0 ? void 0 : snap.airplay) ? snap.airplay : null;
            if (air) {
                this._applyAirplayList(air);
            }
            else {
                // Fall back to devices/current/vols buckets when list not present
                const devs = Array.isArray(snap === null || snap === void 0 ? void 0 : snap.devices) ? snap.devices : [];
                const cur = (snap === null || snap === void 0 ? void 0 : snap.current) instanceof Set ? snap.current : (Array.isArray(snap === null || snap === void 0 ? void 0 : snap.current) ? new Set(snap.current) : new Set());
                const vols = typeof (snap === null || snap === void 0 ? void 0 : snap.vols) === 'object' && (snap === null || snap === void 0 ? void 0 : snap.vols) ? Object.assign({}, snap.vols) : {};
                this._devices = devs.slice();
                this._current = new Set([...cur].filter((x) => typeof x === 'string'));
                // vols in store are 0..1
                this._vols = vols;
            }
            if (typeof (snap === null || snap === void 0 ? void 0 : snap.sseHealthy) === 'boolean')
                this._sseHealthy = !!snap.sseHealthy;
        }
        catch ( /* ignore */_a) { /* ignore */ }
        this.requestUpdate();
    }
    _applyAirplayList(list) {
        try {
            const names = list.map((d) => d === null || d === void 0 ? void 0 : d.name).filter((n) => !!n);
            this._devices = names;
            const cur = list.filter((d) => !!(d === null || d === void 0 ? void 0 : d.active)).map((d) => String(d.name));
            this._current = new Set(cur);
            const v = {};
            list.forEach((d) => {
                const nm = d === null || d === void 0 ? void 0 : d.name;
                let lv = Number(d === null || d === void 0 ? void 0 : d.volume);
                if (!nm || !isFinite(lv))
                    return;
                // normalize 0..100 to 0..1 for internal state
                if (lv > 1.5)
                    lv = lv / 100;
                if (lv < 0)
                    lv = 0;
                if (lv > 1)
                    lv = 1;
                v[String(nm)] = lv;
            });
            if (Object.keys(v).length)
                this._vols = v;
        }
        catch ( /* ignore */_a) { /* ignore */ }
        this.requestUpdate();
    }
    _applyDeviceVolumesObj(obj) {
        try {
            const norm = {};
            for (const [k, v] of Object.entries(obj || {})) {
                let lv = Number(v);
                if (!isFinite(lv))
                    continue;
                if (lv > 1.5)
                    lv = lv / 100;
                if (lv < 0)
                    lv = 0;
                if (lv > 1)
                    lv = 1;
                norm[k] = lv;
            }
            if (Object.keys(norm).length) {
                this._vols = Object.assign(Object.assign({}, this._vols), norm);
            }
        }
        catch ( /* ignore */_a) { /* ignore */ }
        this.requestUpdate();
    }
    _toggleDevice(name, on) {
        var _a;
        const next = new Set(this._current);
        if (on)
            next.add(name);
        else
            next.delete(name);
        this._current = next;
        // Apply immediately
        const devicesCsv = Array.from(this._current).join(',');
        try {
            (_a = this.hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/set_devices', { devices: devicesCsv }).then(() => this._refresh()).catch(() => { });
        }
        catch ( /* ignore */_b) { /* ignore */ }
    }
    _onVolInput(name, levelPct) {
        const level = Math.max(0, Math.min(100, Math.round(levelPct)));
        // Update local state (0..1)
        const new01 = level / 100;
        this._vols = Object.assign(Object.assign({}, this._vols), { [name]: new01 });
        // Debounce server update
        const key = `dev:${name}`;
        if (this._deb.has(key))
            clearTimeout(this._deb.get(key));
        this._deb.set(key, window.setTimeout(() => {
            var _a;
            try {
                (_a = this.hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/set_device_volume', { device: name, level }).then(() => this._refresh()).catch(() => { });
            }
            catch ( /* ignore */_b) { /* ignore */ }
        }, 160));
    }
    _bumpDevice(name, delta) {
        var _a;
        const cur01 = (_a = this._vols[name]) !== null && _a !== void 0 ? _a : 0;
        const cur = Math.round(cur01 * 100);
        const next = Math.max(0, Math.min(100, cur + delta));
        this._onVolInput(name, next);
    }
    // Let HA estimate size in grid layouts
    getCardSize() { return 6; }
};
MusicAirplayOutputsCard.styles = css `
    ha-card { position: relative; }
    .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding:0 16px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:16px; padding:0 16px 16px; }
    .card { border-radius:12px; background: var(--card-background-color, Canvas); box-shadow: var(--ha-card-box-shadow, none); padding:16px; }
    .device { display:flex; flex-direction:column; gap:8px; }
    .switch { display:flex; align-items:center; gap:8px; }
    input[type="range"] { width: 100%; }
    .dev-volrow { display:grid; grid-template-columns: auto 1fr auto auto; gap:8px; align-items:center; }
    button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
    button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
    .chip { font-size:12px; padding:2px 8px; border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:999px; color: var(--primary-text-color, CanvasText); }
    .muted { opacity:.7; }
  `;
__decorate([
    property({ attribute: false })
], MusicAirplayOutputsCard.prototype, "hass", void 0);
__decorate([
    state()
], MusicAirplayOutputsCard.prototype, "_config", void 0);
__decorate([
    state()
], MusicAirplayOutputsCard.prototype, "_devices", void 0);
__decorate([
    state()
], MusicAirplayOutputsCard.prototype, "_current", void 0);
__decorate([
    state()
], MusicAirplayOutputsCard.prototype, "_vols", void 0);
__decorate([
    state()
], MusicAirplayOutputsCard.prototype, "_sseHealthy", void 0);
MusicAirplayOutputsCard = __decorate([
    customElement('music-airplay-outputs-card')
], MusicAirplayOutputsCard);
