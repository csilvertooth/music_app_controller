// music-airplay-outputs-card.ts
import { LitElement, html, css, TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HomeAssistant } from 'custom-card-helpers';
import { appleMusicStore } from './store';

interface Config {
  title?: string;
}

type Vols = { [key: string]: number };

@customElement('music-airplay-outputs-card')
class MusicAirplayOutputsCard extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config: Config = {};
  @state() private _devices: string[] = [];
  @state() private _current = new Set<string>();
  @state() private _vols: Vols = {};
  @state() private _sseHealthy = false;

  private _unsubStore: (() => void) | null = null;
  private _deb: Map<string, number> = new Map();

  static styles = css`
    ha-card { position: relative; }
    .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding:0 16px; }
    .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:16px; padding:0 16px 16px; }
    .card { border-radius:12px; background: var(--card-background-color, Canvas); box-shadow: var(--ha-card-box-shadow, none); padding:16px; }
    .device { display:flex; flex-direction:column; gap:16px; }
    .switch { display:flex; align-items:center; gap:8px; }
    input[type="range"] { width: 100%; }
    .dev-volrow { display:grid; grid-template-columns: auto 1fr auto auto; gap:8px; align-items:center; }
    button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
    button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
    .chip { font-size:12px; padding:2px 8px; border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:999px; color: var(--primary-text-color, CanvasText); }
    .muted { opacity:.7; }
  `;

  setConfig(config: Config) {
    this._config = { ...config };
  }

  protected render(): TemplateResult {
    const title = this._config.title || 'AirPlay Outputs';
    return html`
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

  private _renderDevice(name: string): TemplateResult {
    const checked = this._current.has(name);
    const vol01 = this._vols[name] ?? 0;
    const vol = Math.max(0, Math.min(100, Math.round(vol01 * 100)));
    return html`
      <div class="card device" data-name=${name}>
        <header class="switch">
          <label style="display:flex;gap:8px;align-items:center;">
            <input type="checkbox" .checked=${checked} @change=${(e: Event) => this._toggleDevice(name, (e.target as HTMLInputElement).checked)} />
            <span>${name}</span>
          </label>
          <span class="chip">${vol}%</span>
        </header>
        <div class="dev-volrow">
          <span class="muted">Vol</span>
          <input type="range" min="0" max="100" step="1" .value=${String(vol)} @input=${(e: Event) => this._onVolInput(name, Number((e.target as HTMLInputElement).value))} />
          <button class="secondary" @click=${() => this._bumpDevice(name, -5)} title="Down">−</button>
          <button class="secondary" @click=${() => this._bumpDevice(name, +5)} title="Up">+</button>
        </div>
      </div>
    `;
  }

  private _devicesSorted(): string[] {
    const names = [...this._devices];
    names.sort((a, b) => {
      const ax = this._current.has(a) ? 0 : 1;
      const bx = this._current.has(b) ? 0 : 1;
      if (ax !== bx) return ax - bx;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    return names;
  }

  connectedCallback(): void {
    super.connectedCallback();
    try {
      // Seed from store snapshot
      const snap = appleMusicStore?.snapshot?.();
      if (snap) {
        this._applySnapshot(snap);
      }
      // Subscribe for live updates
      this._unsubStore = appleMusicStore?.subscribe?.(({ event, data }) => {
        if (event === 'snapshot') {
          this._applySnapshot((data?.now ? { ...appleMusicStore.snapshot?.(), ...data } : appleMusicStore.snapshot?.()) || {});
        } else if (event === 'airplay_full') {
          this._applyAirplayList(Array.isArray(data) ? data : []);
        } else if (event === 'device_volumes') {
          this._applyDeviceVolumesObj(data);
        } else if (event === 'master_volume') {
          // ignore here (per-device only)
        }
        // Track SSE health
        try {
          const s = appleMusicStore?.snapshot?.();
          if (s && typeof s.sseHealthy === 'boolean') this._sseHealthy = !!s.sseHealthy;
        } catch { /* ignore */ }
      }) || null;
    } catch { /* ignore */ }
    // Also do a refresh pass
    this._refresh();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._unsubStore) {
      try { this._unsubStore(); } catch { /* ignore */ }
      this._unsubStore = null;
    }
    // Clear debouncers
    for (const t of this._deb.values()) clearTimeout(t);
    this._deb.clear();
  }

  private _applySnapshot(snap: any): void {
    try {
      const air = Array.isArray(snap?.airplay) ? snap.airplay : null;
      if (air) {
        this._applyAirplayList(air);
      } else {
        // Fall back to devices/current/vols buckets when list not present
        const devs = Array.isArray(snap?.devices) ? snap.devices : [];
        const cur = snap?.current instanceof Set ? snap.current : (Array.isArray(snap?.current) ? new Set<string>(snap.current) : new Set<string>());
        const vols = typeof snap?.vols === 'object' && snap?.vols ? { ...(snap.vols as Vols) } : {};
        this._devices = devs.slice();
        this._current = new Set<string>([...cur].filter((x) => typeof x === 'string'));
        // vols in store are 0..1
        this._vols = vols;
      }
      if (typeof snap?.sseHealthy === 'boolean') this._sseHealthy = !!snap.sseHealthy;
    } catch { /* ignore */ }
    this.requestUpdate();
  }

  private _applyAirplayList(list: any[]): void {
    try {
      const names = list.map((d) => d?.name).filter((n) => !!n) as string[];
      this._devices = names;
      const cur = list.filter((d) => !!d?.active).map((d) => String(d.name));
      this._current = new Set(cur);
      const v: Vols = {};
      list.forEach((d) => {
        const nm = d?.name;
        let lv = Number(d?.volume);
        if (!nm || !isFinite(lv)) return;
        // normalize 0..100 to 0..1 for internal state
        if (lv > 1.5) lv = lv / 100;
        if (lv < 0) lv = 0;
        if (lv > 1) lv = 1;
        v[String(nm)] = lv;
      });
      if (Object.keys(v).length) this._vols = v;
    } catch { /* ignore */ }
    this.requestUpdate();
  }

  private _applyDeviceVolumesObj(obj: any): void {
    try {
      const norm: Vols = {};
      for (const [k, v] of Object.entries(obj || {})) {
        let lv = Number(v);
        if (!isFinite(lv)) continue;
        if (lv > 1.5) lv = lv / 100;
        if (lv < 0) lv = 0;
        if (lv > 1) lv = 1;
        norm[k] = lv;
      }
      if (Object.keys(norm).length) {
        this._vols = { ...this._vols, ...norm };
      }
    } catch { /* ignore */ }
    this.requestUpdate();
  }

  private _toggleDevice(name: string, on: boolean): void {
    const next = new Set(this._current);
    if (on) next.add(name);
    else next.delete(name);
    this._current = next;
    // Apply immediately
    const devicesCsv = Array.from(this._current).join(',');
    try {
      this.hass?.callApi('POST', 'apple_music/set_devices', { devices: devicesCsv })
        .then(() => this._refresh())
        .catch(() => {/* ignore */ });
    } catch { /* ignore */ }
  }

  private _onVolInput(name: string, levelPct: number): void {
    const level = Math.max(0, Math.min(100, Math.round(levelPct)));
    // Update local state (0..1)
    const new01 = level / 100;
    this._vols = { ...this._vols, [name]: new01 };
    // Debounce server update
    const key = `dev:${name}`;
    if (this._deb.has(key)) clearTimeout(this._deb.get(key));
    this._deb.set(key, window.setTimeout(() => {
      try {
        this.hass?.callApi('POST', 'apple_music/set_device_volume', { device: name, level })
          .then(() => this._refresh())
          .catch(() => {/* ignore */ });
      } catch { /* ignore */ }
    }, 160));
  }

  private _bumpDevice(name: string, delta: number): void {
    const cur01 = this._vols[name] ?? 0;
    const cur = Math.round(cur01 * 100);
    const next = Math.max(0, Math.min(100, cur + delta));
    this._onVolInput(name, next);
  }

  private _refresh = async (): Promise<void> => {
    // If SSE is healthy, rely on push but still do a quick pull to align names/volumes
    try {
      const list = await this.hass?.callApi('GET', 'apple_music/airplay_full');
      if (Array.isArray(list)) this._applyAirplayList(list);
      // Also merge device_volumes for inactive devices if backend provides
      try {
        const vols = await this.hass?.callApi('GET', 'apple_music/device_volumes');
        if (vols && typeof vols === 'object') this._applyDeviceVolumesObj(vols);
      } catch { /* ignore */ }
    } catch { /* ignore */ }
  };

  // Let HA estimate size in grid layouts
  public getCardSize(): number { return 6; }
}

declare global {
  interface HTMLElementTagNameMap {
    'music-airplay-outputs-card': MusicAirplayOutputsCard;
  }
}
