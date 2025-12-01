import type { HomeAssistant } from 'custom-card-helpers';


interface Layout {
  order?: string[];
  sizes?: { [key: string]: 's' | 'm' | 'l' };
  link_sizes?: boolean;
}

export class MusicControllerPanel extends HTMLElement {
  private _ready = false;
  private _hass: HomeAssistant | null = null;
  private _pollHandle: number | null = null;
  private _devices: string[] = [];
  private _currentDevices = new Set<string>();
  private _deviceVolumes: { [key: string]: number } = {};
  private _debouncers = new Map<string, number>();
  private _pendingApply = false;
  private _showDisabled = false;
  private _browseSection = '';
  private _browseStack: { section: string; arg?: string }[] = [];
  private _browseData: { section: string; arg?: string; data: any } | null = null;
  private _browseCache: { playlists: any[] | null; albums: any[] | null; artists: any[] | null } = { playlists: null, albums: null, artists: null };
  private _browsePage = 0;
  private _pageSize = 5;
  private _browseAlpha = '';
  private _browseReqToken = 0;
  private _preferWS = true;
  private _marqTimers = new WeakMap<Element, number>();
  private _es: EventSource | null = null;
  private _sseBackoff = 1000;
  private _sseHealthy = false;
  private _healthHandle: number | null = null;
  private _storeUnsub: (() => void) | null = null;
  private _masterHoldUntil = 0;
  private _devHold = new Map<string, number>();
  private _lastNPKey = '';
  private _masterVolDragging = false;
  private _deviceVolDragging = new Set<string>();
  private _status: any = {};
  private _layout?: Layout;
  private _wakeHandlersBound = false;
  private _onVis?: (ev: Event) => void;
  private _onPageShow?: (ev: PageTransitionEvent) => void;
  private _onFocus?: (ev: FocusEvent) => void;
  private _onOnline?: (ev: Event) => void;

  // Global throttling for artwork API calls (shared with now-playing card)
  private static _lastArtworkFetch = 0;
  private static readonly ARTWORK_THROTTLE_MS = 500;

  // Methods will be implemented below

  // Implement the missing methods
  private _connectSSE(): void {
    try {
      if (this._es) {
        try { this._es.close(); } catch (_) { }
        this._es = null;
      }
      const open = async () => {
        const base = '/api/apple_music/events';
        let url = base;
        try {
          url = await this._signedPath(base);
        } catch (_) { url = base; }
        const src = new EventSource(url);
        this._es = src;
        src.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            this._handleSSEEvent(data);
            this._sseHealthy = true;
          } catch (e) {
            console.warn('Failed to parse SSE event:', e);
          }
        };
        src.onopen = () => {
          this._sseHealthy = true;
          this._sseBackoff = 1000;
          this._poll(true);
        };
        src.onerror = () => {
          this._sseHealthy = false;
          try { src.close(); } catch (_) { }
          if (this._es === src) this._es = null;
          const wait = this._sseBackoff;
          this._sseBackoff = Math.min(this._sseBackoff * 2, 30000);
          setTimeout(() => {
            if (!this._es) this._connectSSE();
          }, wait);
        };
      };
      open();
    } catch (_) { }
  }

  private _handleSSEEvent(data: any): void {
    const event = data.event;
    const payload = data.data;

    switch (event) {
      case 'now':
        this._updateFromSSE(payload);
        break;
      case 'snapshot':
        if (payload.now) this._updateFromSSE(payload.now);
        if (payload.airplay) this._updateDevicesFromSSE(payload.airplay);
        if (typeof payload.master === 'number') this._updateVolumeFromSSE(payload.master);
        break;
      case 'airplay_full':
        this._updateDevicesFromSSE(payload);
        break;
      case 'master_volume':
        if (typeof payload === 'number') {
          this._updateVolumeFromSSE(payload);
        }
        break;
      case 'shuffle':
        try {
          const enabled = !!(payload?.enabled);
          this._status = { ...(this._status || {}), shuffle: enabled };
          this._updateShuffleButtonVisual?.();
        } catch (_) { }
        break;
    }
  }

  private _updateFromSSE(now: any): void {
    if (!now || typeof now !== 'object') return;

    const mp = this._mpEntity();
    const attrs = mp?.attributes || {};
    const nextTitle = now.title || attrs.media_title || (this.querySelector('#track')?.textContent || '—');
    const nextArtist = now.artist || attrs.media_artist || (this.querySelector('#artist')?.textContent || '—');
    const nextAlbum = now.album || attrs.media_album_name || (this.querySelector('#album')?.textContent || '—');

    const prevKey = this._lastNPKey || '';
    const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
    this._lastNPKey = nextKey;

    const trackEl = this.querySelector('#track') as HTMLElement;
    const artistEl = this.querySelector('#artist') as HTMLElement;
    const albumEl = this.querySelector('#album') as HTMLElement;

    if (trackEl) trackEl.textContent = nextTitle;
    if (artistEl) artistEl.textContent = nextArtist;
    if (albumEl) albumEl.textContent = nextAlbum;

    // Update volume if provided and user is not actively dragging
    if (typeof now.volume === 'number' && Date.now() >= this._masterHoldUntil && !this._masterVolDragging) {
      const masterVol = this.querySelector('#masterVol') as HTMLInputElement;
      if (masterVol) masterVol.value = String(now.volume / 100);
    }

    // Update artwork if token provided
    const token = now.artwork_token;
    if (token) {
      try {
        this._setArtwork?.(token);
      } catch (_) { }
    } else if (nextKey !== prevKey) {
      try {
        this._refreshCurrentArtworkNoToken?.();
      } catch (_) { }
    }

    // Update play/pause state from SSE if provided
    try {
      const s = (typeof now.state === 'string' && now.state) ? String(now.state).toLowerCase() : '';
      if (s) {
        this._status = { ...(this._status || {}), state: s };
      }
    } catch (_) { }

    this._applyNowPlayingMarquee?.();
    this._updatePlayPauseVisual?.();
  }

  private _updateDevicesFromSSE(devices: any[]): void {
    if (!Array.isArray(devices)) return;

    const names = devices.map((d: any) => d.name).filter((n: string) => n);
    this._devices = names;

    const active = devices.filter(d => d.active).map(d => d.name);
    this._currentDevices = new Set(active);

    // Update device volumes
    devices.forEach((d: any) => {
      if (d.name && typeof d.volume === 'number') {
        this._deviceVolumes[d.name] = d.volume;
      }
    });

    this._renderDevices?.();
  }

  private _updateVolumeFromSSE(volume: number): void {
    if (typeof volume !== 'number') return;

    const masterVol = this.querySelector('#masterVol') as HTMLInputElement;
    if (masterVol && Date.now() >= this._masterHoldUntil) {
      masterVol.value = String(volume / 100);
    }
  }


  // Implementations for previously optional helpers

  private _updateShuffleButtonVisual(): void {
    try {
      const btn = this.querySelector('#shuffle') as HTMLElement;
      if (!btn) return;
      const on = !!(this._status && this._status.shuffle);
      btn.classList.toggle('active', on);
    } catch (_) { }
  }

  private _updatePlayPauseVisual(): void {
    try {
      const mp = this._mpEntity();
      const sseState = String((this as any)._status?.state || (this as any)._status?.playerState || '').toLowerCase();
      const state = sseState || ((mp && typeof (mp as any).state === 'string') ? String((mp as any).state).toLowerCase() : '');
      const btn = this.querySelector('#playpause') as HTMLElement;
      if (!btn) return;
      btn.classList.remove('pp-playing', 'pp-paused', 'pp-idle');
      if (state === 'playing') btn.classList.add('pp-playing');
      else if (state === 'paused') btn.classList.add('pp-paused');
      else btn.classList.add('pp-idle');
    } catch (_) { }
  }

  private _applyNowPlayingMarquee(): void {
    try {
      const apply = (el: HTMLElement | null) => {
        if (!el) return;
        el.style.willChange = 'transform';
        // simple reset - do not animate continuously to avoid motion sickness
      };
      apply(this.querySelector('#track') as HTMLElement);
      apply(this.querySelector('#artist') as HTMLElement);
      apply(this.querySelector('#album') as HTMLElement);
    } catch (_) { }
  }

  private async _signedPath(path: string): Promise<string> {
    try {
      if (this._hass && (this._hass as any).callWS) {
        const resp = await (this._hass as any).callWS({ type: 'auth/sign_path', path, expires: 60 });
        if (resp && typeof resp.path === 'string' && resp.path) return resp.path;
      }
    } catch (_) { }
    return path;
  }

  private async _setArtwork(token: string): Promise<void> {
    try {
      const base = '/api/apple_music/artwork';
      // Always include timestamp and random parameter to force fresh fetch
      const cacheBuster = `t=${Date.now()}&r=${Math.random().toString(36).substring(2, 15)}`;
      const u = token ? `${base}?tok=${encodeURIComponent(token)}&size=256&${cacheBuster}` : `${base}?size=256&${cacheBuster}`;
      const url = await this._signedPath(u).catch(() => u);
      const r = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      if (!r || !r.ok) return;
      const blob = await r.blob();
      const artEl = this.querySelector('#art') as HTMLImageElement;
      if (!artEl) return;
      const obj = URL.createObjectURL(blob);
      const prev = (artEl as any).dataset?.blobUrl;
      artEl.src = obj;
      (artEl as any).dataset = { ...(artEl as any).dataset, blobUrl: obj, artworkToken: token };
      if (prev && prev !== obj) { try { URL.revokeObjectURL(prev); } catch (_) { } }
    } catch (_) { }
  }

  private async _refreshCurrentArtworkNoToken(): Promise<void> {
    // Global throttling to prevent excessive API calls
    const now = Date.now();
    if (now - MusicControllerPanel._lastArtworkFetch < MusicControllerPanel.ARTWORK_THROTTLE_MS) {
      return;
    }
    MusicControllerPanel._lastArtworkFetch = now;

    try {
      const base = '/api/apple_music/artwork';
      const url = await this._signedPath(base).catch(() => base);
      const r = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
      if (!r || !r.ok) return;
      const blob = await r.blob();
      const artEl = this.querySelector('#art') as HTMLImageElement;
      if (!artEl) return;
      const obj = URL.createObjectURL(blob);
      const prev = (artEl as any).dataset?.blobUrl;
      artEl.src = obj;
      (artEl as any).dataset = { ...(artEl as any).dataset, blobUrl: obj };
      if (prev && prev !== obj) { try { URL.revokeObjectURL(prev); } catch (_) { } }
    } catch (_) { }
  }

  private _updateNowPlayingAux(): void {
    // Sync shuffle button state from backend when possible
    try {
      if (!this._hass || !(this._hass as any).callApi) return;
      (this._hass as any).callApi('GET', 'apple_music/shuffle').then((res: any) => {
        const on = !!(res && (res.enabled === true));
        this._status = { ...(this._status || {}), shuffle: on };
        this._updateShuffleButtonVisual();
      }).catch(() => { });
    } catch (_) { }
  }

  private _renderDevices(): void {
    try {
      const grid = this.querySelector('#devices') as HTMLElement;
      if (!grid) return;
      const names = Array.isArray(this._devices) ? [...this._devices] : [];
      names.sort((a, b) => {
        const ax = this._currentDevices.has(a) ? 0 : 1;
        const bx = this._currentDevices.has(b) ? 0 : 1;
        if (ax !== bx) return ax - bx;
        return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
      });
      const list = this._showDisabled ? names : names.filter(n => this._currentDevices.has(n));
      const html = list.map((nm) => {
        const vol = Math.max(0, Math.min(100, Math.round(this._deviceVolumes[nm] ?? 0)));
        const checked = this._currentDevices.has(nm) ? 'checked' : '';
        const esc = (s: string) => String(s).replace(/&/g, '&').replace(/"/g, '"').replace(/</g, '<');
        return `
          <div class="card device" data-name="${esc(nm)}">
            <header class="switch">
              <label style="display:flex;gap:8px;align-items:center;">
                <input type="checkbox" data-dev="${esc(nm)}" ${checked} />
                <span>${esc(nm)}</span>
              </label>
              <span class="chip" style="margin-left:auto;opacity:.8">${vol}%</span>
            </header>
            <div class="dev-volrow">
              <span style="opacity:.8">Vol</span>
              <input class="dev-volume" type="range" min="0" max="100" step="1" value="${vol}" data-dev-vol="${esc(nm)}" />
              <button class="secondary" data-vol-down="${esc(nm)}" title="Down">−</button>
              <button class="secondary" data-vol-up="${esc(nm)}" title="Up">+</button>
            </div>
          </div>
        `;
      }).join('');
      grid.innerHTML = html;

      // Wire handlers
      grid.querySelectorAll('input[type="checkbox"][data-dev]').forEach((el) => {
        el.addEventListener('change', (e) => {
          const t = e.target as HTMLInputElement;
          const name = t.getAttribute('data-dev') || '';
          if (!name) return;
          if (t.checked) this._currentDevices.add(name);
          else this._currentDevices.delete(name);
          this._applyDevices();
        });
      });
      const bump = (name: string, delta: number) => {
        const cur = Math.max(0, Math.min(100, Math.round(this._deviceVolumes[name] ?? 0)));
        const next = Math.max(0, Math.min(100, cur + delta));
        const slider = grid.querySelector(`input[type="range"][data-dev-vol="${CSS.escape(name)}"]`) as HTMLInputElement | null;
        if (slider) slider.value = String(next);
        this._deviceVolumes[name] = next;
        this._debounceDevVol(name, next);
      };
      grid.querySelectorAll('button[data-vol-down]').forEach((el) => {
        el.addEventListener('click', (e) => {
          const name = (e.currentTarget as HTMLElement).getAttribute('data-vol-down') || '';
          if (name) bump(name, -5);
        });
      });
      grid.querySelectorAll('button[data-vol-up]').forEach((el) => {
        el.addEventListener('click', (e) => {
          const name = (e.currentTarget as HTMLElement).getAttribute('data-vol-up') || '';
          if (name) bump(name, +5);
        });
      });
      grid.querySelectorAll('input[type="range"][data-dev-vol]').forEach((el) => {
        el.addEventListener('input', (e) => {
          const t = e.target as HTMLInputElement;
          const name = t.getAttribute('data-dev-vol') || '';
          const v = Math.max(0, Math.min(100, Math.round(Number(t.value) || 0)));
          this._deviceVolumes[name] = v;
          // Update chip
          try {
            const card = t.closest('.device') as HTMLElement | null;
            const chip = card?.querySelector('.chip') as HTMLElement | null;
            if (chip) chip.textContent = `${v}%`;
          } catch (_) { }
          this._debounceDevVol(name, v);
        });
      });
    } catch (_) { }
  }

  private _debounceDevVol(name: string, level: number): void {
    const key = `dev:${name}`;
    if (this._debouncers.has(key)) {
      clearTimeout(this._debouncers.get(key));
    }
    this._debouncers.set(key, setTimeout(() => {
      try {
        this._hass?.callApi('POST', 'apple_music/set_device_volume', { device: name, level: level }).catch(() => { });
      } catch (_) { }
    }, 200));
  }

  private _applyDevices(): void {
    try {
      const payload = { devices: Array.from(this._currentDevices).join(',') };
      this._hass?.callApi('POST', 'apple_music/set_devices', payload).then(() => {
        // best-effort refresh of live state
        this._poll(true);
      }).catch(() => { });
    } catch (_) { }
  }


  connectedCallback(): void {
    // Reconnect/poll when returning from sleep or navigating back
    if (!this._wakeHandlersBound) {
      const refreshFromWake = () => {
        try { this._ensureUI?.(); this._restoreUIFromCache?.(); } catch (_) { }
      };
      this._onVis = () => { if (document.visibilityState === 'visible') { refreshFromWake(); try { this._connectSSE?.(); } catch (_) { } this._poll(true); } };
      this._onPageShow = () => { refreshFromWake(); try { this._connectSSE?.(); } catch (_) { } this._poll(true); };
      this._onFocus = () => { refreshFromWake(); this._poll(true); };
      this._onOnline = () => { refreshFromWake(); try { this._connectSSE?.(); } catch (_) { } this._poll(true); };
      if (this._onVis) document.addEventListener('visibilitychange', this._onVis as any);
      if (this._onPageShow) window.addEventListener('pageshow', this._onPageShow as any);
      if (this._onFocus) window.addEventListener('focus', this._onFocus as any);
      if (this._onOnline) window.addEventListener('online', this._onOnline as any);
      this._wakeHandlersBound = true;
    }
    // If we were detached and reattached, make sure polling resumes
    if (this._ready && !this._pollHandle) this._startPolling();
  }

  // Ensure the panel DOM exists after a suspension or HA hot-reload
  _ensureUI(): void {
    try {
      // If the main sections container is missing but we were previously ready, re-render the shell
      const hasSections = !!this.querySelector('#sections');
      if (!hasSections) {
        this._renderSkeleton();
        this._wireStaticHandlers();
        try { this._applyLayout?.(); } catch (_) { }
      }
    } catch (_) { /* ignore */ }
  }

  // Quickly paint last-known state so the UI isn't blank while waking
  _restoreUIFromCache(): void {
    try {
      // Seed from shared store snapshot to avoid blank UI on wake
      try {
        const store = (typeof window !== 'undefined') ? window.__appleMusicStore : null;
        if (store) {
          const snap = store.snapshot();
          // Now Playing
          const now = snap.now || {};
          const nowTs = Number(snap.nowTs || 0);
          const t = this.querySelector('#track'); const ar = this.querySelector('#artist'); const al = this.querySelector('#album');
          if (t && now.title) t.textContent = now.title;
          if (ar && now.artist) ar.textContent = now.artist;
          if (al && now.album) al.textContent = now.album;
          const tok = now.artwork_token || '';
          if (tok && (!nowTs || (Date.now() - nowTs) < 10000)) { try { this._setArtwork(tok); } catch (_) { } }
          // Shuffle + play/pause
          try { this._status = { ...(this._status || {}), shuffle: !!snap.shuffle }; this._updateShuffleButtonVisual?.(); } catch (_) { }
          try { if (snap.playerState) this._updatePlayPauseVisual?.(); } catch (_) { }
          // Devices snapshot
          try {
            const names = Array.isArray(snap.devices) ? snap.devices : [];
            this._devices = names;
            if (snap.current && typeof snap.current.has === 'function') {
              this._currentDevices = new Set(names.filter(n => snap.current.has(n)));
            }
            this._deviceVolumes = { ...(snap.vols || {}) };
            // Master volume from snapshot if present
            try {
              const mEl = this.querySelector('#masterVol') as HTMLInputElement;
              const mv = Number(snap.master);
              if (mEl && isFinite(mv)) mEl.value = String(mv / 100);
            } catch (_) { }
          } catch (_) { }
        }
      } catch (_) { }
      // If still missing now-playing metadata (e.g. fresh load and no store yet), fetch once
      try {
        const trackEl = this.querySelector('#track');
        const artistEl = this.querySelector('#artist');
        const albumEl = this.querySelector('#album');
        const missing = !(trackEl && trackEl.textContent && trackEl.textContent.trim())
          || !(artistEl && artistEl.textContent && artistEl.textContent.trim())
          || !(albumEl && albumEl.textContent && albumEl.textContent.trim());
        if (missing && this._hass && this._hass.callApi) {
          this._hass.callApi('GET', 'apple_music/now_playing').then((np: any) => {
            try {
              if (!np || typeof np !== 'object') return;
              if (np.title && trackEl) trackEl.textContent = np.title;
              if (np.artist && artistEl) artistEl.textContent = np.artist;
              if (np.album && albumEl) albumEl.textContent = np.album;
              // If token present, set artwork
              const tok = (np.artwork_token || np.token || '');
              if (tok) { try { this._setArtwork(tok); } catch (_) { } }
              this._applyNowPlayingMarquee?.();
            } catch (_) { }
          }).catch(() => { });
        }
      } catch (_) { }
      // Devices/outputs from last poll
      this._renderDevices?.();
      // Now playing from HA state and/or cached /status
      this._updateFromHass?.();
      this._updateNowPlayingAux?.();
      // Keep layout consistent
      this._applyLayout?.();
    } catch (_) { /* ignore */ }
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    if (!this._ready) {
      this._ready = true;
      this._renderSkeleton();
      this._wireStaticHandlers();
      // Apply saved layout immediately to avoid flash of defaults
      try { this._applyLayout?.(); } catch { }
      this._startPolling();
      // Connect SSE early so live updates apply without waiting for user interaction
      try { this._connectSSE?.(); } catch (_) { }
      // Prime state immediately
      try { this._poll(true); } catch (_) { }
    }
    this._updateFromHass?.();
  }

  disconnectedCallback(): void {
    if (this._pollHandle) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
    for (const t of this._debouncers.values()) clearTimeout(t);
    this._debouncers.clear();
    if (this._storeUnsub) { try { this._storeUnsub(); } catch (_) { } this._storeUnsub = null; }
    // Close SSE connection to avoid long-running work during unload
    if (this._es) { try { this._es.close(); } catch (_) { } this._es = null; }
    if (this._healthHandle) { try { clearTimeout(this._healthHandle); } catch (_) { } this._healthHandle = null; }
    // Remove wake handlers to avoid leaks
    if (this._wakeHandlersBound) {
      try { document.removeEventListener('visibilitychange', this._onVis as any); } catch (_) { }
      try { window.removeEventListener('pageshow', this._onPageShow as any); } catch (_) { }
      try { window.removeEventListener('focus', this._onFocus as any); } catch (_) { }
      try { window.removeEventListener('online', this._onOnline as any); } catch (_) { }
      this._wakeHandlersBound = false;
    }
  }

  // ====== Render ======
  _renderSkeleton(): void {
    const style = `
          :host { display:block; height:100%; box-sizing:border-box; color: var(--primary-text-color); color-scheme: light dark; }
          .wrap { height:100%; padding:16px; box-sizing:border-box; overflow-y:auto; overflow-x:hidden; }
          .row { display:flex; flex-wrap:wrap; gap:16px; align-items:center; }
          .sections { display:grid; gap:16px; grid-template-columns: 1fr; align-items:start; grid-auto-flow: dense; }
          /* Column assignment for medium/small cards */
          .sections > ha-card[data-col="left"] { grid-column: 1; }
          .sections > ha-card[data-col="right"] { grid-column: 2; }
          .sections > ha-card { min-width: 0; }
          .constrain { width:100%; max-width: clamp(320px, 92vw, 860px); margin: 0 auto; }
          /* Keep Browse card size stable; scroll list instead of resizing card */
          #browse .constrain { display:flex; flex-direction:column; }
          #browse .browse-inner { display:flex; flex-direction:column; max-height: clamp(360px, 60vh, 540px); }
          #browse .list { flex: 1 1 auto; overflow-y:auto; overflow-x:hidden; }
          #browse .pager, #browse .backrow, #browse .hint { flex: 0 0 auto; }
          /* Music Player header row */
          #now { position: relative; }
          .card-header.mp-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 16px 0; }
          /* Browse card header styling to match now playing */
          #browse .card-header.mp-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 16px 0; }
          #browse .toolbar { display:flex; align-items:center; justify-content:flex-end; gap:12px; padding:8px 16px 0; flex-wrap: wrap; }
          #browse .seg { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
          /* Browse modal */
          .modal { position: fixed; inset: 0; display:none; align-items:center; justify-content:center; z-index: 1000; }
          .modal.show { display:flex; }
          .modal .backdrop { position:absolute; inset:0; background: var(--dialog-backdrop-color, color-mix(in srgb, var(--primary-text-color) 50%, transparent)); }
          .modal .sheet { position:relative; width: min(92vw, 860px); max-width: 860px; max-height: 80vh; margin: 0 16px; }
          .modal .close { position:absolute; top:8px; right:12px; z-index:1; }
          .modal .sheet ha-card { display:flex; flex-direction:column; height: 100%; }
          .modal .sheet .browse-inner { flex: 1 1 auto; display:flex; flex-direction:column; max-height: none; }
          .modal .sheet .list { flex: 1 1 auto; overflow:auto; }
          /* Use two columns only on wider displays; keep iPad Pro portrait single column */
          @media (min-width: 1200px) { .sections { grid-template-columns: 1fr 1fr; } }
          /* Layout sizes for cards */
          .sections > ha-card.size-l { grid-column: 1 / -1; }
          .sections > ha-card.size-m { grid-column: auto; }
          .sections > ha-card.size-s { grid-column: auto; }
          /* AirPlay Outputs should expand with the card; no scrollbars */
          #outputs .constrain { max-width: none; }
          /* Add padding to AirPlay outputs header */
          #outputs .head { padding: 0 16px 8px; }
          /* Customize mode visuals */
          .sections.edit ha-card { position: relative; }
          .sections.edit ha-card.editable { outline: 2px dashed var(--divider-color, #aaaaaa); cursor: grab; }
          .sections.edit ha-card.editable:active { cursor: grabbing; }
          .resize-handle { position:absolute; right:6px; bottom:6px; width:16px; height:16px; border-right: 3px solid var(--divider-color, #888888); border-bottom:3px solid var(--divider-color, #888888); border-left: 3px solid transparent; border-top: 3px solid transparent; border-radius:2px; cursor: nwse-resize; opacity:.8; }
          .drag-placeholder { border:2px dashed var(--primary-color); border-radius:12px; min-height: 80px; background: transparent; }
          /* Remove fixed large art on wider screens; keep responsive sizing */
          @media (min-width: 900px) { .art { width:auto; height:auto; } }
          .media { display:flex; align-items:center; justify-content:center; text-align:center; gap:16px; flex-wrap: wrap; padding:6px 12px 12px; min-width:0; }
          /* Only switch to side-by-side in landscape; keep stacking in iPad portrait */
          @media (min-width: 1024px) and (orientation: landscape) {
            .media { flex-wrap: nowrap; }
            .art { width: clamp(160px, 30%, 320px); max-width: 30%; }
          }
          .appbar { position:sticky; top:0; z-index:1; display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 12px; margin-bottom:12px; background: var(--card-background-color, Canvas); border-radius:12px; box-shadow: var(--ha-card-box-shadow, none); }
          .appbar .link { color: var(--primary-color); }
          .appbar .left { display:flex; align-items:center; gap:8px; }
          .appbar button.icon { line-height:1; padding:6px 10px; border-radius:8px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          .appbar .apptitle { font-weight:600; display:flex; align-items:center; gap:8px; }
          .appbar .apptitle img.logo { width:20px; height:20px; display:inline-block; border-radius:4px; }
          .appbar a.link { text-decoration:none; color: var(--primary-color); }
          /* Settings menu text should track theme */
          .menu { color: var(--primary-text-color, CanvasText); }
          .menu .menuitem { color: var(--primary-text-color, CanvasText); }
          .menu .menuitem:hover { background: color-mix(in srgb, var(--primary-text-color) 10%, transparent); }
          /* Customize/layout bar styling */
          .layoutbar { background: var(--card-background-color, Canvas); border-radius:12px; padding:12px 16px; margin: 8px 0 16px; }
          .layoutbar .grp { display:flex; align-items:center; gap:8px; margin: 10px 0; }
          .layoutbar .grp.cards { padding-left: 16px; }
          .layoutbar .grp label { display:flex; align-items:center; gap:8px; }
          .layoutbar button { margin: 0; }
          .card { border-radius:12px; background: var(--card-background-color, Canvas); box-shadow: var(--ha-card-box-shadow, none); padding:16px; min-width:260px; }
          .full { width:100%; }
          .title { font-size:1.1rem; font-weight:600; margin-bottom:8px; }
          /* Artwork scales within card bounds horizontally and vertically */
          .art { width: min(100%, 360px); max-width: 100%; aspect-ratio: 1 / 1; height: auto; border-radius:8px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 8%, transparent)); object-fit:cover; }
          .meta { min-width: 380px; text-align:center; margin-inline:auto; max-width:100%; flex: 1 1 380px; }
          .track { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .artist, .album { opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .controls { display:flex; gap:12px; margin-top:12px; flex-wrap: nowrap; justify-content:center; }
          .controls button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-width:72px; }
          .controls button ha-icon { --mdc-icon-size: 26px; }
          button:active { transform: scale(0.97); filter: brightness(0.95); transition: transform .06s ease, filter .06s ease; }
          /* avoid visual size shift on active */
          .volrow { display:flex; gap:12px; margin-top:12px; align-items:center; }
          /* Slightly larger buttons in Now Playing */
          #now .controls button, #now .volrow button { padding:10px 14px; font-size:0.95rem; border-radius:10px; }
          /* Shuffle visual states */
          #shuffle { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          #shuffle.active { background: var(--primary-color); color: #fff; }
          /* Play/Pause visual states */
          #playpause { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          #playpause.pp-playing { background: var(--primary-color); color: #fff; }
          #playpause.pp-paused { background: #FB8C00; color: #1b1b1b; }
          #playpause.pp-idle { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          /* Add gentle spacing between text rows */
          #now .meta .track, #now .meta .artist, #now .meta .album { margin-bottom:6px; }
          button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
          button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap:16px; }
          /* Make Outputs devices span available width responsively */
          #outputs .grid { grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); }
          .device { display:flex; flex-direction:column; gap:8px; }
          .device header { display:flex; align-items:center; justify-content:space-between; gap:8px; }
          .switch { display:flex; align-items:center; gap:8px; }
          .toolbar { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:12px 16px 0; flex-wrap: wrap; }
          .seg { display:flex; gap:6px; flex-wrap:wrap; }
          .segbtn { cursor:pointer; border:none; border-radius:12px; padding:6px 10px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          .segbtn.active { background: var(--primary-color); color:#fff; }
          .search { display:flex; gap:8px; align-items:center; flex: 1 1 240px; justify-content:flex-end; }
          .search input[type="search"] { flex: 1 1 180px; max-width: 320px; border-radius:8px; border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); background: transparent; color: var(--primary-text-color, CanvasText); padding:6px 10px; }
          .hint { opacity:.7; padding:4px 16px 0; }
          .list { padding:8px 16px 16px; display:grid; gap:8px; max-width:100%; overflow-x:hidden; }
          .item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-radius:10px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); flex-wrap: nowrap; cursor: pointer; min-height:56px; height:56px; box-sizing:border-box; overflow:hidden; }
          .label { position:relative; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex: 1 1 0; min-width:0; }
          .actions { display:flex; gap:8px; flex: 0 0 auto; flex-wrap: nowrap; justify-content:flex-end; align-items:center; }
          .item * { min-width:0; }
          .actions button { white-space: nowrap; }
          .label-inner { display:inline-block; will-change: transform; transform: translateX(0); }
          .scroll-viewport { overflow:hidden; white-space:nowrap; }
          .scroll-inner { display:inline-block; will-change: transform; transform: translateX(0); }
          .item[data-act] { border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); transition: background .15s ease, transform .02s ease-in; }
          .item[data-act]:hover { background: color-mix(in srgb, var(--card-background-color) 94%, var(--primary-text-color) 6%); }
          .item[data-act]:hover { background: color-mix(in srgb, var(--card-background-color) 94%, var(--primary-text-color) 6%); }
          .item[data-act]:active { transform: translateY(1px); }
          .item[data-act] .label::after { content: '›'; opacity:.6; margin-left:8px; }
          .item { cursor: pointer; }
          /* Tap/click feedback */
          @keyframes pressPulse { 0% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary-text-color) 15%, transparent);} 50% { transform: scale(0.985); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-text-color) 10%, transparent);} 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary-text-color) 0%, transparent);} }
          .pulse { animation: pressPulse .18s ease-in-out; }
          .flash { background: var(--primary-color) !important; color:#fff !important; }
          .backrow { padding:0 16px 16px; }
          .pager { display:flex; flex-direction:column; gap:10px; padding:0 16px 16px; margin-top:12px; }
          .list { margin-top:8px; }
          .pager .letters { display:flex; gap:6px; overflow:auto; -webkit-overflow-scrolling: touch; padding-bottom:4px; }
          .pager .letters .letterbtn { flex:0 0 auto; cursor:pointer; border:none; border-radius:999px; padding:4px 8px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); font-size:12px; }
          .pager .letters .letterbtn.active { background: var(--primary-color); color:#fff; }
          .pager .letters .letterbtn[disabled] { opacity:.45; cursor:not-allowed; pointer-events:none; }
          .pager .pn { display:flex; align-items:center; gap:8px; }
          .pager .pn .info { opacity:.8; }
          .pager .pn button[disabled] { opacity:.5; cursor:not-allowed; }
          input[type="range"] { width: 100%; max-width: 560px; }
          .range-compact { width: 100%; }
          .device .dev-volume { width: 100%; max-width: none; }
          .dev-volrow { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; }
          /* Outputs header layout */
          .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding:0 16px; }
        `;

    this.innerHTML = `
          <style>${style}</style>
          <div class="wrap">
            <div class="appbar">
              <div class="left">
                  <button id="menu" class="icon" title="Toggle sidebar">☰</button>
                  <div class="apptitle">Music Controller</div>
                </div>

              <div class="right-actions" style="position:relative; display:flex; gap:8px; align-items:center;">
                <button id="settingsBtn" class="secondary" title="Settings">Settings ▾</button>
                <div id="settingsMenu" class="menu" style="display:none; position:absolute; right:0; top:36px; background: var(--card-background-color, Canvas); border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:10px; box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,0.4)); min-width:200px; z-index:5;">
                  <button class="menuitem" id="menuCustomize" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Customize Layout</button>
                  <button class="menuitem" id="menuReset" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Reset Layout</button>
                  <div style="height:1px; background: var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); margin:6px 0;"></div>
                  <div style="position:relative;">
                    <button class="menuitem" id="menuAbout" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">About ▾</button>
                    <div id="aboutMenu" class="menu" style="display:none; position:absolute; right:100%; top:0; background: var(--card-background-color, Canvas); border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:10px; box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,0.4)); min-width:260px; margin-right:8px; padding:6px 0;">
                      <div style="padding:6px 12px; font-size:12px; opacity:.9;">Panel Version: <span id="aboutPanelVer">—</span></div>
                      <div style="padding:6px 12px; font-size:12px; opacity:.9;">Music Controller.js: <span id="aboutJsVer">—</span></div>
                    </div>
                  </div>

                  <div style="position:relative;">
                    <button class="menuitem" id="menuServices" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Services ▾</button>
                    <div id="servicesMenu" class="menu" style="display:none; position:absolute; right:100%; top:0; background: var(--card-background-color, Canvas); border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:10px; box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,0.4)); min-width:260px; margin-right:8px;">
                      <button class="menuitem" id="menuRefreshArtwork" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Refresh Current Artwork</button>
                      <div style="height:1px; background: var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); margin:4px 0;"></div>
                      <button class="menuitem" id="menuPurgeAlbumServer" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Purge Server Album Cache</button>
                      <button class="menuitem" id="menuPurgeAlbumHA" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Purge Home Assistant Album Cache</button>
                    </div>
                  </div>
                  <div style="height:1px; background: var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); margin:6px 0;"></div>
                  <button class="menuitem" id="menuRestart" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Restart Music App Server</button>
                </div>
              </div>
            </div>
            <div id="layoutBar" class="layoutbar" style="display:none;">
              <div class="grp">
                <strong style="opacity:.8;">Layout</strong>
              </div>
              <div class="grp cards">
                <span style="min-width:140px;">Music Player</span>
                <button data-key="now" data-act="up" class="secondary">↑</button>
                <button data-key="now" data-act="down" class="secondary">↓</button>
              </div>
              <div class="grp cards">
                <span style="min-width:140px;">AirPlay Outputs</span>
                <button data-key="outputs" data-act="up" class="secondary">↑</button>
                <button data-key="outputs" data-act="down" class="secondary">↓</button>
              </div>
              <div class="grp">
                <label>
                  <input id="linkSizes" type="checkbox" />
                  <span>Make the Music Player and AirPlay Outputs cards the same width</span>
                </label>
              </div>
              <div class="grp" style="gap:10px;">
                <button id="saveLayout" class="secondary" title="Save and close">Save</button>
                <button id="resetLayout" class="secondary" title="Reset panel">Reset Panel</button>
            </div>
          </div>
          <div id="sections" class="sections">
            <ha-card id="now" class="size-l">
              <div class="card-header mp-header">
                <div class="title">Now Playing</div>
                <button id="openBrowse" class="secondary">Browse</button>
              </div>
              <div class="media">
                <img id="art" class="art" alt="artwork"/>
                <div class="meta">
                  <div id="track" class="track">—</div>
                  <div id="artist" class="artist">—</div>
                  <div id="album" class="album">—</div>
                  <div class="controls">
                    <button id="prev" class="secondary"><ha-icon icon="mdi:skip-previous"></ha-icon><span class="btnlabel">Prev</span></button>
                    <button id="playpause"><ha-icon icon="mdi:play-pause"></ha-icon><span class="btnlabel">Play/Pause</span></button>
                    <button id="shuffle" class="secondary"><ha-icon icon="mdi:shuffle"></ha-icon><span class="btnlabel">Shuffle</span></button>
                    <button id="next" class="secondary"><ha-icon icon="mdi:skip-next"></ha-icon><span class="btnlabel">Next</span></button>
                  </div>
                  <div class="volrow">
                    <span style="opacity:.8">Vol</span>
                    <button id="mvDown" class="secondary" title="Volume down">−</button>
                    <input id="masterVol" type="range" min="0" max="1" step="0.01" value="0" />
                    <button id="mvUp" class="secondary" title="Volume up">+</button>
                  </div>
                </div>
              </div>
            </ha-card>
            <ha-card id="outputs" class="size-l">
              <div class="card-header mp-header">
                <div class="title">AirPlay Outputs</div>
                <div style="display:flex; gap:8px; align-items:center;">
                  <button id="toggleDisabled" class="secondary">Show Disabled</button>
                  <button id="refreshOutputs" class="secondary">Refresh</button>
                </div>
              </div>
              <div class="constrain">
                <div id="devices" class="grid"></div>
              </div>
            </ha-card>
            <ha-card id="browse" class="size-l">
              <div class="card-header mp-header">
                <div class="title">Browse & Search</div>
                <div class="toolbar">
                  <div class="seg">
                    <button id="browsePlaylists" class="segbtn">Playlists</button>
                    <button id="browseAlbums" class="segbtn">Albums</button>
                    <button id="browseArtists" class="segbtn">Artists</button>
                  </div>
                  <div class="search">
                    <input id="browseSearch" type="search" placeholder="Search..." />
                  </div>
                </div>
              </div>
              <div class="browse-inner">
                <div id="browseList" class="list"></div>
                <div class="pager" style="display:none;">
                  <div class="letters">
                    <button class="letterbtn" data-letter="A">A</button>
                    <button class="letterbtn" data-letter="B">B</button>
                    <button class="letterbtn" data-letter="C">C</button>
                    <button class="letterbtn" data-letter="D">D</button>
                    <button class="letterbtn" data-letter="E">E</button>
                    <button class="letterbtn" data-letter="F">F</button>
                    <button class="letterbtn" data-letter="G">G</button>
                    <button class="letterbtn" data-letter="H">H</button>
                    <button class="letterbtn" data-letter="I">I</button>
                    <button class="letterbtn" data-letter="J">J</button>
                    <button class="letterbtn" data-letter="K">K</button>
                    <button class="letterbtn" data-letter="L">L</button>
                    <button class="letterbtn" data-letter="M">M</button>
                    <button class="letterbtn" data-letter="N">N</button>
                    <button class="letterbtn" data-letter="O">O</button>
                    <button class="letterbtn" data-letter="P">P</button>
                    <button class="letterbtn" data-letter="Q">Q</button>
                    <button class="letterbtn" data-letter="R">R</button>
                    <button class="letterbtn" data-letter="S">S</button>
                    <button class="letterbtn" data-letter="T">T</button>
                    <button class="letterbtn" data-letter="U">U</button>
                    <button class="letterbtn" data-letter="V">V</button>
                    <button class="letterbtn" data-letter="W">W</button>
                    <button class="letterbtn" data-letter="X">X</button>
                    <button class="letterbtn" data-letter="Y">Y</button>
                    <button class="letterbtn" data-letter="Z">Z</button>
                    <button class="letterbtn" data-letter="#">#</button>
                  </div>
                  <div class="pn">
                    <button id="browsePrev" class="secondary" disabled>Prev</button>
                    <span class="info">Page 1 of 1</span>
                    <button id="browseNext" class="secondary" disabled>Next</button>
                  </div>
                </div>
              </div>
            </ha-card>
          </div>
        </div>
      </div>
    `;
    // Safety: ensure no leftover Overview anchors exist
    try { this.querySelectorAll('a.link').forEach(a => a.remove()); } catch (_) { }
  }

  _wireStaticHandlers(): void {
    // Add the event handlers from the original JS
    // Now Playing controls
    this.querySelector('#prev')?.addEventListener('click', () => this._mpService('media_previous_track'));
    this.querySelector('#playpause')?.addEventListener('click', () => this._mpService('media_play_pause'));
    this.querySelector('#shuffle')?.addEventListener('click', () => this._toggleShuffle());
    this.querySelector('#next')?.addEventListener('click', () => this._mpService('media_next_track'));
    this.querySelector('#mvDown')?.addEventListener('click', () => this._bumpVol(-0.05));
    this.querySelector('#mvUp')?.addEventListener('click', () => this._bumpVol(0.05));
    const masterVolEl = this.querySelector('#masterVol') as HTMLInputElement;
    if (masterVolEl) {
      masterVolEl.addEventListener('input', (e) => this._setVol(Number((e.target as HTMLInputElement).value)));
      masterVolEl.addEventListener('mousedown', () => { this._masterVolDragging = true; });
      masterVolEl.addEventListener('mouseup', () => { this._masterVolDragging = false; });
      masterVolEl.addEventListener('mouseleave', () => { this._masterVolDragging = false; });
    }
    this.querySelector('#openBrowse')?.addEventListener('click', () => this._showBrowse());
    // AirPlay Outputs
    this.querySelector('#refreshOutputs')?.addEventListener('click', () => this._poll(true));
    this.querySelector('#toggleDisabled')?.addEventListener('click', () => {
      this._showDisabled = !this._showDisabled;
      const btn = this.querySelector('#toggleDisabled') as HTMLButtonElement | null;
      if (btn) btn.textContent = this._showDisabled ? 'Hide Disabled' : 'Show Disabled';
      this._renderDevices?.();
    });
    // Browse controls
    this.querySelector('#browsePlaylists')?.addEventListener('click', () => this._setBrowseSection('playlists'));
    this.querySelector('#browseAlbums')?.addEventListener('click', () => this._setBrowseSection('albums'));
    this.querySelector('#browseArtists')?.addEventListener('click', () => this._setBrowseSection('artists'));
    this.querySelector('#browseSearch')?.addEventListener('input', (e) => this._setBrowseSearch((e.target as HTMLInputElement).value));
    this.querySelector('#browsePrev')?.addEventListener('click', () => this._browsePrev());
    this.querySelector('#browseNext')?.addEventListener('click', () => this._browseNext());
    // Letter buttons
    this.querySelectorAll('.letterbtn').forEach(btn => {
      btn.addEventListener('click', (e) => this._setBrowseAlpha((e.target as HTMLElement).dataset.letter || ''));
    });
    // Settings menu
    this.querySelector('#settingsBtn')?.addEventListener('click', () => this._toggleSettingsMenu());
    this.querySelector('#menuCustomize')?.addEventListener('click', () => this._showLayoutBar());
    this.querySelector('#menuReset')?.addEventListener('click', () => this._resetLayout());

    // Sidebar toggle (HA drawer)
    this.querySelector('#menu')?.addEventListener('click', () => {
      try {
        // Dispatch from this component so the event bubbles up through HA's DOM
        this.dispatchEvent(new CustomEvent('hass-toggle-menu', { bubbles: true, composed: true }));
      } catch (_) { }
    });

    // Settings submenus: About and Services
    const toggleSubmenu = (btnSel: string, menuSel: string, otherSel?: string) => {
      const btn = this.querySelector(btnSel) as HTMLElement | null;
      const menu = this.querySelector(menuSel) as HTMLElement | null;
      const other = otherSel ? (this.querySelector(otherSel) as HTMLElement | null) : null;
      if (btn && menu) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (other) other.style.display = 'none';
          const show = menu.style.display !== 'block';
          menu.style.display = show ? 'block' : 'none';
          // Populate About submenu on open
          if (show && menuSel === '#aboutMenu') {
            try { this._populateAboutMenu?.(); } catch (_) { }
          }
        });
      }
    };
    toggleSubmenu('#menuAbout', '#aboutMenu', '#servicesMenu');
    toggleSubmenu('#menuServices', '#servicesMenu', '#aboutMenu');

    // Close submenus when clicking outside settings
    document.addEventListener('click', (ev) => {
      try {
        const settings = this.querySelector('#settingsMenu') as HTMLElement | null;
        if (!settings) return;
        const t = ev.target as Node;
        if (settings && !settings.contains(t)) {
          const aboutMenu = this.querySelector('#aboutMenu') as HTMLElement | null;
          const servicesMenu = this.querySelector('#servicesMenu') as HTMLElement | null;
          if (aboutMenu) aboutMenu.style.display = 'none';
          if (servicesMenu) servicesMenu.style.display = 'none';
        }
      } catch (_) { }
    });

    // Settings actions
    this.querySelector('#menuRestart')?.addEventListener('click', () => {
      try {
        // Call macOS server restart via HA proxy
        this._hass?.callApi('POST', 'apple_music/restart').catch(() => { });
        // Hide menu
        const menu = this.querySelector('#settingsMenu') as HTMLElement | null;
        if (menu) menu.style.display = 'none';
      } catch (_) { }
    });
    this.querySelector('#menuPurgeAlbumServer')?.addEventListener('click', () => {
      try {
        // Prefer HA service which proxies to backend purge
        this._hass?.callService('apple_music', 'purge_album_cache', {});
      } catch (_) { }
    });
    this.querySelector('#menuPurgeAlbumHA')?.addEventListener('click', () => {
      try {
        this._hass?.callService('apple_music', 'purge_ha_album_cache', {});
      } catch (_) { }
    });
    this.querySelector('#menuRefreshArtwork')?.addEventListener('click', () => {
      try {
        this._hass?.callService('apple_music', 'refresh_current_artwork', {});
      } catch (_) { }
    });
  }

  // Add all other methods from the original class, converted to TS
  _entityId(): string {
    const s = this._hass?.states || {};
    return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }

  _mpEntity() {
    const id = this._entityId();
    return this._hass?.states?.[id];
  }

  _mpService(service: string, data: any = {}): void {
    if (!this._hass) return;
    this._hass.callService('media_player', service, { entity_id: this._entityId(), ...data });
  }

  _updateFromHass(): void {
    const mp = this._mpEntity();
    const art = this.querySelector('#art') as HTMLImageElement;
    const track = this.querySelector('#track') as HTMLElement;
    const artist = this.querySelector('#artist') as HTMLElement;
    const album = this.querySelector('#album') as HTMLElement;
    const masterVol = this.querySelector('#masterVol') as HTMLInputElement;

    if (!mp) return;

    const attrs = mp.attributes || {};
    const nextTitle = attrs.media_title || (track?.textContent || '—');
    const nextArtist = attrs.media_artist || (artist?.textContent || '—');
    const nextAlbum = attrs.media_album_name || (album?.textContent || '—');
    const prevKey = this._lastNPKey || '';
    const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
    this._lastNPKey = nextKey;
    if (track) track.textContent = nextTitle;
    if (artist) artist.textContent = nextArtist;
    if (album) album.textContent = nextAlbum;
    if (typeof attrs.volume_level === 'number' && Date.now() >= this._masterHoldUntil) {
      if (masterVol) masterVol.value = String(attrs.volume_level);
    }
    const tok = this._status?.artwork_token;
    if (tok) {
      try { this._setArtwork?.(tok); } catch (_) { }
    } else {
      if (nextKey !== prevKey) {
        try { this._refreshCurrentArtworkNoToken?.(); } catch (_) { }
      }
      const imgEl = this.querySelector('#art') as HTMLImageElement;
      const hasBlob = !!(imgEl?.dataset?.blobUrl);
      if (!hasBlob) {
        // Use direct artwork API instead of entity_picture to avoid media player proxy
        try { this._refreshCurrentArtworkNoToken?.(); } catch (_) { }
      }
    }
    this._applyNowPlayingMarquee?.();
    this._updatePlayPauseVisual?.();
  }

  _startPolling(): void {
    if (this._pollHandle) clearInterval(this._pollHandle);
    this._pollHandle = setInterval(() => {
      try { this._poll?.(); } catch (_) { }
    }, 5000);
  }

  _poll(force = false): void {
    if (!this._hass) return;
    const calls: Promise<any>[] = [];
    // Always try to keep shuffle/state fresh
    calls.push(this._hass.callApi('GET', 'apple_music/status').then((st: any) => {
      this._status = st || {};
      this._updateShuffleButtonVisual?.();
      this._updateFromHass?.();
      try { if (typeof st?.master === 'number') this._updateVolumeFromSSE(st.master); } catch (_) { }
    }).catch(() => { }));
    // If forcing or SSE isn't healthy, fetch AirPlay snapshot
    if (force || !this._sseHealthy || !this._preferWS) {
      calls.push(this._hass.callApi('GET', 'apple_music/airplay_full').then((list: any) => {
        if (Array.isArray(list)) this._updateDevicesFromSSE(list);
      }).catch(() => { }));
    }
    // No need to wait; fire-and-forget
    Promise.all(calls).catch(() => { });
  }

  _toggleShuffle(): void {
    if (!this._hass) return;

    const currentShuffle = !!(this._status?.shuffle);
    const newShuffle = !currentShuffle;

    this._hass.callApi('POST', 'apple_music/shuffle', { enabled: newShuffle })
      .then((_response: any) => {
        this._status = { ...(this._status || {}), shuffle: newShuffle };
        this._updateShuffleButtonVisual?.();
      })
      .catch((error) => {
        console.warn('Failed to toggle shuffle:', error);
      });
  }

  _bumpVol(delta: number): void {
    if (!this._hass) return;

    const masterVol = this.querySelector('#masterVol') as HTMLInputElement;
    if (!masterVol) return;

    const currentVol = parseFloat(masterVol.value) || 0;
    const newVol = Math.max(0, Math.min(1, currentVol + delta));

    const key = 'master_vol';
    if (this._debouncers.has(key)) {
      clearTimeout(this._debouncers.get(key));
    }

    this._debouncers.set(key, setTimeout(() => {
      this._hass?.callApi('POST', 'apple_music/master_volume', {
        level: Math.round(newVol * 100)
      }).catch((error) => {
        console.warn('Failed to set master volume:', error);
      });
    }, 150));

    masterVol.value = String(newVol);
    this._masterHoldUntil = Date.now() + 1000;
  }

  _setVol(level: number): void {
    if (!this._hass) return;

    const clampedLevel = Math.max(0, Math.min(1, level));

    const key = 'master_vol';
    if (this._debouncers.has(key)) {
      clearTimeout(this._debouncers.get(key));
    }

    this._debouncers.set(key, setTimeout(() => {
      this._hass?.callApi('POST', 'apple_music/master_volume', {
        level: Math.round(clampedLevel * 100)
      }).catch((error) => {
        console.warn('Failed to set master volume:', error);
      });
    }, 150));

    this._masterHoldUntil = Date.now() + 1000;
  }

  _showBrowse(): void {
    const browseCard = this.querySelector('#browse') as HTMLElement;
    if (browseCard) {
      browseCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  _setBrowseSection(section: string): void {
    if (this._browseSection === section) return;

    this._browseSection = section;
    this._browsePage = 0;
    this._browseAlpha = '';
    this._browseReqToken++;

    // Update UI buttons
    this.querySelectorAll('.segbtn').forEach(btn => {
      btn.classList.remove('active');
    });

    const activeBtn = this.querySelector(`#browse${section.charAt(0).toUpperCase() + section.slice(1)}`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }

    this._loadBrowseData();
  }

  _setBrowseSearch(query: string): void {
    this._browseAlpha = '';
    this._browsePage = 0;
    this._browseReqToken++;

    if (query.trim()) {
      this._searchBrowseData(query.trim());
    } else {
      this._loadBrowseData();
    }
  }

  _browsePrev(): void {
    if (this._browsePage > 0) {
      this._browsePage--;
      // For drill-down views (tracks/albums), page locally without hitting HA HTTP endpoints
      const sec = this._browseSection;
      if (sec === 'album_tracks' || sec === 'playlist_tracks' || sec === 'artist_albums') {
        this._renderBrowseList(Array.isArray(this._browseData?.data) ? (this._browseData as any).data : []);
      } else {
        this._loadBrowseData();
      }
    }
  }

  _browseNext(): void {
    this._browsePage++;
    // For drill-down views (tracks/albums), page locally without hitting HA HTTP endpoints
    const sec = this._browseSection;
    if (sec === 'album_tracks' || sec === 'playlist_tracks' || sec === 'artist_albums') {
      this._renderBrowseList(Array.isArray(this._browseData?.data) ? (this._browseData as any).data : []);
    } else {
      this._loadBrowseData();
    }
  }

  _setBrowseAlpha(alpha: string): void {
    this._browseAlpha = alpha;
    this._browsePage = 0;
    this._browseReqToken++;

    // Update letter button states
    this.querySelectorAll('.letterbtn').forEach(btn => {
      btn.classList.remove('active');
    });

    const activeBtn = this.querySelector(`.letterbtn[data-letter="${alpha}"]`);
    if (activeBtn) {
      activeBtn.classList.add('active');
    }

    // Only reload from server for top-level lists/search; drill-down pages render locally
    if (this._browseSection === 'playlists' || this._browseSection === 'albums' || this._browseSection === 'artists' || this._browseSection === 'search') {
      this._loadBrowseData();
    } else {
      this._renderBrowseList(Array.isArray(this._browseData?.data) ? (this._browseData as any).data : []);
    }
  }

  private _loadBrowseData(): void {
    if (!this._hass) return;

    const token = ++this._browseReqToken;
    const section = this._browseSection;
    const page = this._browsePage;
    const alpha = this._browseAlpha;

    const endpoint = `/${section}`;
    // Fetch full list (client-side pagination) so we can compute total pages reliably
    const params: any = {};
    if (alpha) params.starts_with = alpha;

    try {
      const qs = new URLSearchParams(params as any).toString();
      this._hass.callApi('GET', `apple_music${endpoint}${qs ? `?${qs}` : ''}`)
        .then((data: any) => {
          if (token !== this._browseReqToken) return;
          if (Array.isArray(data)) {
            // Cache full list for top-level sections
            if (section === 'playlists' || section === 'albums' || section === 'artists') {
              (this as any)._browseCache = (this as any)._browseCache || { playlists: null, albums: null, artists: null };
              (this as any)._browseCache[section as 'playlists' | 'albums' | 'artists'] = data;
            }
            this._browseData = { section, data };
            // Keep current page; render will slice and compute totals
            this._renderBrowseList(data);
          } else {
            this._renderBrowseList([]);
            this._updateBrowsePager(false, 1);
          }
        })
        .catch((_error) => {
          if (token === this._browseReqToken) {
            this._renderBrowseList([]);
            this._updateBrowsePager(false, 1);
          }
        });
    } catch (_error) {
      if (token === this._browseReqToken) {
        this._renderBrowseList([]);
        this._updateBrowsePager(false, 1);
      }
    }
  }

  private _searchBrowseData(query: string): void {
    if (!this._hass) return;

    const token = ++this._browseReqToken;

    try {
      const typeMap: Record<string, string> = { playlists: 'playlist', albums: 'album', artists: 'artist' };
      const types = typeMap[this._browseSection] || 'album,artist,playlist';
      const qs = new URLSearchParams({ q: query, types }).toString();
      this._hass.callApi('GET', `apple_music/search?${qs}`)
        .then((data: any) => {
          if (token !== this._browseReqToken) return;

          const results = data?.[this._browseSection] || [];
          this._browseData = { section: 'search', data: results, arg: query };
          this._renderBrowseList(results);
          this._updateBrowsePager(false); // No pagination for search
        })
        .catch((error) => {
          console.warn('Search failed:', error);
          if (token === this._browseReqToken) {
            this._renderBrowseList([]);
            this._updateBrowsePager(false);
          }
        });
    } catch (error) {
      console.warn('Search failed:', error);
      if (token === this._browseReqToken) {
        this._renderBrowseList([]);
        this._updateBrowsePager(false);
      }
    }
  }

  private _renderBrowseList(items: any[]): void {
    const listEl = this.querySelector('#browseList') as HTMLElement | null;
    if (!listEl) return;

    // Normalize names for filtering and rendering
    const nameOf = (it: any) =>
      typeof it === 'string' ? it : (it?.title || it?.name || it?.id || 'Unknown');

    // Basic escape for innerHTML usage
    const esc = (s: string) =>
      String(s).replace(/&/g, '&').replace(/"/g, '"').replace(/</g, '<');

    // Build available-letters set based on full unfiltered list (respecting search results when applicable)
    const all = Array.isArray(items) ? items.slice() : [];
    const letters = new Set<string>();
    for (const it of all) {
      const nm = String(nameOf(it) || '').trim();
      if (!nm) continue;
      const stripped = nm.replace(/^[^A-Za-z0-9]+/, '');
      const ch = (stripped[0] || '').toUpperCase();
      if (/[A-Z]/.test(ch)) letters.add(ch);
      else letters.add('#');
    }
    // Show only letters that have matches; hide others
    try {
      this.querySelectorAll('.letterbtn').forEach((btn) => {
        const l = (btn as HTMLElement).dataset.letter || '';
        const has = letters.has(l);
        (btn as HTMLElement).style.display = has ? '' : 'none';
        // If current alpha is now hidden, clear it
        if (!has && this._browseAlpha === l) {
          this._browseAlpha = '';
          (btn as HTMLElement).classList.remove('active');
        }
      });
    } catch (_) { }

    // Apply client-side alpha filter when server doesn't support it
    const alpha = (this._browseAlpha || '').toUpperCase();
    let base = Array.isArray(items) ? items.slice() : [];
    if (alpha) {
      base = base.filter((it) => {
        const nm = String(nameOf(it) || '').trim();
        if (!nm) return false;
        const stripped = nm.replace(/^[^A-Za-z0-9]+/, '');
        if (alpha === '#') {
          const ch = (stripped[0] || '').toUpperCase();
          return !(/[A-Z]/.test(ch));
        }
        return (stripped[0] || '').toUpperCase() === alpha;
      });
    }

    // Pagination (apply to all views including search)
    const page = this._browsePage;
    const pageSize = this._pageSize;
    const start = page * pageSize;
    const end = start + pageSize;
    const view = base.slice(start, end);

    // Render simple list (rows only; actions handled elsewhere)
    let html = '';
    // Back row for drill-down views
    if (Array.isArray(this._browseStack) && this._browseStack.length) {
      html += `
        <div class="item" data-back="1">
          <div class="label"><span class="label-inner">← Back</span></div>
          <div class="actions"></div>
        </div>`;
    }
    // Play All/Shuffle All for artist albums
    if (this._browseData?.section === 'artist_albums') {
      const artistId = this._browseData.arg || '';
      html += `
        <div class="item" data-play-all-header="1">
          <div class="label"><span class="label-inner">All Albums</span></div>
          <div class="actions">
            <button class="secondary" data-play-all="${esc(artistId)}" title="Play All">Play All</button>
            <button class="secondary" data-shuffle-all="${esc(artistId)}" title="Shuffle All">Shuffle All</button>
          </div>
        </div>`;
    }
    html += view.map((it) => {
      const nm = nameOf(it);
      const idVal = typeof it === 'string' ? it : (it?.id || nm);
      const nEsc = esc(nm);
      const idEsc = esc(idVal);
      const type = this._browseSection === 'artist_albums' ? 'album' : this._browseSection.slice(0, -1); // Remove 's' from plural
      return `
        <div class="item" data-name="${idEsc}" data-id="${idEsc}">
          <div class="label"><span class="label-inner">${nEsc}</span></div>
          <div class="actions">
            <button class="secondary" data-play="${idEsc}" data-name="${nEsc}" data-type="${type}" title="Play">Play</button>
            <button class="secondary" data-shuffle="${idEsc}" data-name="${nEsc}" data-type="${type}" title="Shuffle">Shuffle</button>
          </div>
        </div>
      `;
    }).join('');

    listEl.innerHTML = html || `<div class="item"><div class="label">No items</div></div>`;

    // Update pager with total pages
    const totalPages = Math.max(1, Math.ceil((base.length || 0) / (this._pageSize || 1)));
    const hasMore = (this._browsePage + 1) < totalPages;
    this._updateBrowsePager(!!hasMore, totalPages);

    // Wire row clicks (placeholder for future drill-down; no autoplay here)
    try {
      listEl.querySelectorAll('.item').forEach((el) => {
        el.addEventListener('click', (ev) => {
          const row = ev.currentTarget as HTMLElement;
          // Handle back navigation
          if (row.hasAttribute('data-back')) {
            try { this._browseBack?.(); } catch (_) { }
            return;
          }
          // Skip play-all header
          if (row.hasAttribute('data-play-all-header')) return;
          const id = row?.getAttribute('data-id') || '';
          if (!id) return;
          // Drill into contents based on current section
          const sec = String(((this._browseData?.section === 'search') ? this._browseSection : this._browseData?.section) || this._browseSection || '').toLowerCase();
          try {
            if (sec === 'playlists') this._browseInto?.('playlist', id);
            else if (sec === 'albums') this._browseInto?.('album', id);
            else if (sec === 'artists') this._browseInto?.('artist', id);
            else if (sec === 'artist_albums') this._browseInto?.('album', id);
            // For tracks (album_tracks/playlist_tracks), no further drill-down
          } catch (_) { /* ignore */ }
        });
      });
      // Wire Play/Shuffle action buttons
      listEl.querySelectorAll('button[data-play]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const id = (ev.currentTarget as HTMLElement).getAttribute('data-play') || '';
          const name = (ev.currentTarget as HTMLElement).getAttribute('data-name') || '';
          const type = (ev.currentTarget as HTMLElement).getAttribute('data-type') || 'album';
          if (id || name) this._playBrowseItem(id || name, false, type);
        });
      });
      listEl.querySelectorAll('button[data-shuffle]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const id = (ev.currentTarget as HTMLElement).getAttribute('data-shuffle') || '';
          const name = (ev.currentTarget as HTMLElement).getAttribute('data-name') || '';
          const type = (ev.currentTarget as HTMLElement).getAttribute('data-type') || 'album';
          if (id || name) this._playBrowseItem(id || name, true, type);
        });
      });
      // Wire Play All/Shuffle All for artists
      listEl.querySelectorAll('button[data-play-all]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const artistId = (ev.currentTarget as HTMLElement).getAttribute('data-play-all') || '';
          if (artistId) this._playAllArtist(artistId, false);
        });
      });
      listEl.querySelectorAll('button[data-shuffle-all]').forEach((btn) => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const artistId = (ev.currentTarget as HTMLElement).getAttribute('data-shuffle-all') || '';
          if (artistId) this._playAllArtist(artistId, true);
        });
      });
    } catch (_) { }
  }

  private _playBrowseItem(name: string, shuffle: boolean, type?: string): void {
    if (!this._hass) return;

    const section = this._browseSection;

    // For tracks, use media_player service with the full media_content_id
    if (section.includes('_tracks')) {
      this._hass.callService('media_player', 'play_media', {
        entity_id: this._entityId(),
        media_content_type: 'music',
        media_content_id: name // Use the full ID for proper track identification
      }).then(() => {
        console.log(`Playing track: ${name}`);
      }).catch((error) => {
        console.warn(`Failed to play track ${name}:`, error);
      });
      return;
    }

    // For albums, playlists, and artists, use media_player service with proper content IDs
    let contentType = '';
    if (section === 'artist_albums') contentType = 'album';
    else contentType = section.slice(0, -1); // Remove 's' from plural

    // Extract clean name from ID if needed
    let cleanName = name;
    if (name.startsWith(`${contentType}:`)) {
      try {
        cleanName = decodeURIComponent(name.slice(contentType.length + 1));
      } catch {
        cleanName = name.slice(contentType.length + 1);
      }
    }

    // Build the correct media content ID based on type and shuffle
    let mediaContentId = '';

    if (shuffle) {
      if (contentType === 'playlist') {
        mediaContentId = `shuffle_playlist:${cleanName}`;
      } else if (contentType === 'album') {
        mediaContentId = `shuffle_album:${cleanName}`;
      } else if (contentType === 'artist') {
        // For artist shuffle, use the special queue_artist_shuffled API
        try {
          this._hass.callApi('POST', 'apple_music/queue_artist_shuffled', { artist: cleanName });
          return;
        } catch (error) {
          console.warn('Failed to shuffle artist:', error);
          return;
        }
      }
    } else {
      if (contentType === 'playlist') {
        mediaContentId = `play_playlist:${cleanName}`;
      } else if (contentType === 'album') {
        mediaContentId = `play_album:${cleanName}`;
      } else if (contentType === 'artist') {
        mediaContentId = `artist:${cleanName}`;
      }
    }

    if (mediaContentId) {
      this._hass.callService('media_player', 'play_media', {
        entity_id: this._entityId(),
        media_content_type: 'music',
        media_content_id: mediaContentId,
      }).then(() => {
        console.log(`Playing ${type}: ${cleanName}`);
      }).catch((error) => {
        console.warn(`Failed to play ${type}:`, error);
      });
    }
  }

  private _playAllArtist(artistId: string, shuffle: boolean): void {
    if (!this._hass) return;

    // Extract artist name from ID if it's prefixed
    let artistName = artistId;
    if (artistId.startsWith('artist:')) {
      try {
        artistName = decodeURIComponent(artistId.slice(7));
      } catch {
        artistName = artistId.slice(7);
      }
    }

    if (shuffle) {
      // For shuffle, use the special queue_artist_shuffled API endpoint
      this._hass.callApi('POST', 'apple_music/queue_artist_shuffled', {
        artist: artistName
      }).then(() => {
        console.log(`Shuffling all albums for artist: ${artistName}`);
      }).catch((error) => {
        console.warn('Failed to shuffle all artist albums:', error);
      });
    } else {
      // For regular play, use media_player service with artist content ID
      this._hass.callService('media_player', 'play_media', {
        entity_id: this._entityId(),
        media_content_type: 'music',
        media_content_id: `artist:${artistName}`
      }).then(() => {
        console.log(`Playing all albums for artist: ${artistName}`);
      }).catch((error) => {
        console.warn('Failed to play all artist albums:', error);
      });
    }
  }

  private _updateBrowsePager(hasMore: boolean, totalPages?: number): void {
    try {
      const pager = this.querySelector('.pager') as HTMLElement | null;
      const letters = this.querySelector('.letters') as HTMLElement | null;
      const isTopLevel = this._browseSection === 'playlists' || this._browseSection === 'albums' || this._browseSection === 'artists' || this._browseSection === 'search';
      const isDrillDown = this._browseSection === 'album_tracks' || this._browseSection === 'playlist_tracks' || this._browseSection === 'artist_albums';

      // Show pager for both top-level sections with multiple pages AND drill-down sections
      const shouldShowPager = isDrillDown || (isTopLevel && typeof totalPages === 'number' && totalPages > 1);

      if (pager) {
        pager.style.display = shouldShowPager ? '' : 'none';
      }
      if (letters) {
        letters.style.display = isTopLevel ? '' : 'none';
      }

      // Update pagination controls for both top-level and drill-down sections
      if (shouldShowPager) {
        const prevBtn = this.querySelector('#browsePrev') as HTMLButtonElement;
        const nextBtn = this.querySelector('#browseNext') as HTMLButtonElement;
        const infoEl = this.querySelector('.pager .info') as HTMLElement;
        const pageNum = this._browsePage + 1;
        if (prevBtn) prevBtn.disabled = this._browsePage === 0;
        if (nextBtn) nextBtn.disabled = !hasMore;
        if (infoEl) {
          if (typeof totalPages === 'number' && totalPages > 0) {
            infoEl.textContent = hasMore ? `Page ${pageNum} of ${totalPages}` : `Page ${pageNum} of ${totalPages} (last)`;
          } else {
            infoEl.textContent = hasMore ? `Page ${pageNum}` : `Page ${pageNum} (last)`;
          }
        }
      }
    } catch (_) { /* ignore */ }
  }

  _toggleSettingsMenu(): void {
    const menu = this.querySelector('#settingsMenu') as HTMLElement;
    if (!menu) return;

    const isVisible = menu.style.display !== 'none';
    menu.style.display = isVisible ? 'none' : 'block';

    // Close submenu when main menu closes
    if (isVisible) {
      const aboutMenu = this.querySelector('#aboutMenu') as HTMLElement;
      const servicesMenu = this.querySelector('#servicesMenu') as HTMLElement;
      if (aboutMenu) aboutMenu.style.display = 'none';
      if (servicesMenu) servicesMenu.style.display = 'none';
    }
  }

  _showLayoutBar(): void {
    const layoutBar = this.querySelector('#layoutBar') as HTMLElement;
    const settingsMenu = this.querySelector('#settingsMenu') as HTMLElement;

    if (layoutBar) {
      layoutBar.style.display = 'block';
    }
    if (settingsMenu) {
      settingsMenu.style.display = 'none';
    }

    // Add event listeners for layout controls
    this._setupLayoutHandlers();
  }

  _resetLayout(): void {
    // Reset to default layout and order
    const sections = this.querySelector('#sections') as HTMLElement | null;
    if (sections) {
      // Reset sizes to large
      const cards = sections.querySelectorAll('ha-card');
      cards.forEach(card => {
        card.classList.remove('size-s', 'size-m');
        card.classList.add('size-l');
      });
      // Reset order to default sequence
      const order = ['now', 'outputs', 'browse'];
      order.forEach(id => {
        const el = this.querySelector(`#${id}`) as HTMLElement | null;
        if (el) sections.appendChild(el);
      });
    }
    // Reset layout bar control
    const linkSizes = this.querySelector('#linkSizes') as HTMLInputElement | null;
    if (linkSizes) linkSizes.checked = false;

    // Close settings and layout bar
    const settingsMenu = this.querySelector('#settingsMenu') as HTMLElement | null;
    if (settingsMenu) settingsMenu.style.display = 'none';
    this._hideLayoutBar();
  }

  private _setupLayoutHandlers(): void {
    const saveBtn = this.querySelector('#saveLayout');
    const resetBtn = this.querySelector('#resetLayout');

    if (saveBtn) {
      saveBtn.addEventListener('click', () => this._saveLayout());
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', () => this._resetLayout());
    }

    // Layout control buttons
    this.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const key = target.dataset.key;
        const action = target.dataset.act;

        if (key && action) {
          this._handleLayoutAction(key, action);
        }
      });
    });
  }

  private _handleLayoutAction(key: string, action: string): void {
    const card = this.querySelector(`#${key}`) as HTMLElement;
    if (!card) return;

    if (action === 'up' || action === 'down') {
      // Move card up/down in order
      const sections = this.querySelector('#sections');
      if (!sections) return;

      const cards = Array.from(sections.children) as HTMLElement[];
      const currentIndex = cards.indexOf(card);

      if (action === 'up' && currentIndex > 0) {
        sections.insertBefore(card, cards[currentIndex - 1]);
      } else if (action === 'down' && currentIndex < cards.length - 1) {
        sections.insertBefore(cards[currentIndex + 1], card);
      }
    }
  }

  private _saveLayout(): void {
    // Save current layout preferences
    const layout: Layout = {
      order: [],
      sizes: {},
      link_sizes: false
    };

    const sections = this.querySelector('#sections');
    const linkSizes = this.querySelector('#linkSizes') as HTMLInputElement;

    if (sections) {
      const cards = sections.querySelectorAll('ha-card');
      cards.forEach(card => {
        const id = card.id;
        if (id) {
          layout.order?.push(id);

          if (card.classList.contains('size-s')) {
            layout.sizes![id] = 's';
          } else if (card.classList.contains('size-m')) {
            layout.sizes![id] = 'm';
          } else {
            layout.sizes![id] = 'l';
          }
        }
      });
    }

    if (linkSizes) {
      layout.link_sizes = linkSizes.checked;
    }

    // Store layout (could be saved to localStorage or sent to backend)
    this._layout = layout;
    console.log('Layout saved:', layout);

    this._hideLayoutBar();
  }

  private _hideLayoutBar(): void {
    const layoutBar = this.querySelector('#layoutBar') as HTMLElement;
    if (layoutBar) {
      layoutBar.style.display = 'none';
    }
  }

  private _applyLayout(): void {
    if (!this._layout) return;

    const sections = this.querySelector('#sections');
    if (!sections) return;

    // Apply saved sizes
    if (this._layout.sizes) {
      Object.entries(this._layout.sizes).forEach(([cardId, size]) => {
        const card = this.querySelector(`#${cardId}`) as HTMLElement;
        if (card) {
          card.classList.remove('size-s', 'size-m', 'size-l');
          card.classList.add(`size-${size}`);
        }
      });
    }

    // Apply linked sizes
    if (this._layout.link_sizes) {
      const linkSizes = this.querySelector('#linkSizes') as HTMLInputElement;
      if (linkSizes) linkSizes.checked = true;
    }
  }

  // Fetch and populate About submenu versions
  async _populateAboutMenu(): Promise<void> {
    try {
      const panelEl = this.querySelector('#aboutPanelVer') as HTMLElement | null;
      const jsEl = this.querySelector('#aboutJsVer') as HTMLElement | null;
      // If DOM not present, nothing to do
      if (!panelEl && !jsEl) return;
      const info = await (((this._hass as any)?.callApi('GET', 'apple_music/panel_info').catch(() => null)) as any);
      const panelVer = info && typeof (info as any).panel_version === 'string' ? (info as any).panel_version : 'unknown';
      const assetVer = info && typeof (info as any).asset_version === 'string' ? (info as any).asset_version : 'unknown';
      if (panelEl) panelEl.textContent = panelVer;
      if (jsEl) jsEl.textContent = assetVer;
    } catch (_) { /* ignore */ }
  }

  // Drill-down navigation helpers

  private async _wsBrowse(id: string, overrideType?: string): Promise<any> {
    try {
      const entity_id = this._entityId();
      const type = overrideType || (id.startsWith('album:') ? 'album'
        : id.startsWith('artist:') ? 'artist'
          : id.startsWith('playlist:') ? 'playlist'
            : 'library');
      // Pass full id (including prefix) to HA browse API along with explicit type
      return await (this._hass as any)?.callWS({ type: 'media_player/browse_media', entity_id, media_content_id: id, media_content_type: type });
    } catch (_) { return null; }
  }

  private _flattenChildren(arr: any[]): any[] {
    const out: any[] = [];
    const stack = Array.isArray(arr) ? [...arr] : [];
    while (stack.length) {
      const n = stack.shift();
      if (!n) continue;
      if (Array.isArray(n.children) && n.children.length) stack.push(...n.children);
      else out.push(n);
    }
    return out;
  }

  private _isTrackNode(c: any): boolean {
    const cid = String(c?.media_content_id || '');
    const mc = String(c?.media_class || '').toLowerCase();
    const title = String(c?.title || '').toLowerCase();
    if (cid.startsWith('song:')) return true;
    if (mc === 'track') return true;
    if (mc.includes('music') || mc.includes('audio')) {
      if (cid.startsWith('play_') || cid.startsWith('shuffle_')) return false;
      if (title.includes('play album') || title.includes('shuffle')) return false;
      return true;
    }
    return false;
  }

  private _pushBrowseContext(): void {
    try {
      const cur = { section: String(this._browseData?.section || this._browseSection || ''), arg: this._browseData?.arg };
      if (!this._browseStack) this._browseStack = [];
      this._browseStack.push(cur);
    } catch (_) { }
  }

  private _setBrowseData(section: string, arg: string | undefined, data: any[]): void {
    this._browseSection = section;
    this._browsePage = 0;
    this._browseAlpha = '';
    this._browseReqToken++;
    this._browseData = { section, arg, data };
    this._renderBrowseList(data);
  }

  private async _browseInto(kind: 'playlist' | 'album' | 'artist', id: string): Promise<void> {
    this._pushBrowseContext();
    // Ensure HA gets a prefixed content id when one is not provided
    const prefixedId = id && id.includes(':') ? id : `${kind}:${id}`;

    if (kind === 'artist') {
      let res = await this._wsBrowse(prefixedId, 'artist');
      let children = Array.isArray(res?.children) ? res.children : (Array.isArray(res?.items) ? res.items : []);
      let items = this._flattenChildren(children).map((c: any) => ({ id: c?.media_content_id, title: c?.title })).filter((it) => it.id || it.title);

      // Fallback: try unprefixed id if empty
      if (!Array.isArray(items) || items.length === 0) {
        const altId = id && id.includes(':') ? id.split(':', 2)[1] : id;
        res = await this._wsBrowse(altId, 'artist');
        children = Array.isArray(res?.children) ? res.children : (Array.isArray(res?.items) ? res.items : []);
        items = this._flattenChildren(children).map((c: any) => ({ id: c?.media_content_id, title: c?.title })).filter((it) => it.id || it.title);
      }

      this._setBrowseData('artist_albums', prefixedId, items);
    } else if (kind === 'album') {
      let res = await this._wsBrowse(prefixedId, 'album');
      let children = Array.isArray(res?.children) ? res.children : (Array.isArray(res?.items) ? res.items : []);
      let tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c: any) => ({ id: c?.media_content_id, title: c?.title })).filter((it) => it.id || it.title);

      // Fallback: try unprefixed id if empty
      if (!Array.isArray(tracks) || tracks.length === 0) {
        const altId = id && id.includes(':') ? id.split(':', 2)[1] : id;
        res = await this._wsBrowse(altId, 'album');
        children = Array.isArray(res?.children) ? res.children : (Array.isArray(res?.items) ? res.items : []);
        tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c: any) => ({ id: c?.media_content_id, title: c?.title })).filter((it) => it.id || it.title);
      }

      this._setBrowseData('album_tracks', prefixedId, tracks);
    } else if (kind === 'playlist') {
      let res = await this._wsBrowse(prefixedId, 'playlist');
      let children = Array.isArray(res?.children) ? res.children : (Array.isArray(res?.items) ? res.items : []);
      let tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c: any) => ({ id: c?.media_content_id, title: c?.title })).filter((it) => it.id || it.title);

      // Fallback: try unprefixed id if empty
      if (!Array.isArray(tracks) || tracks.length === 0) {
        const altId = id && id.includes(':') ? id.split(':', 2)[1] : id;
        res = await this._wsBrowse(altId, 'playlist');
        children = Array.isArray(res?.children) ? res.children : (Array.isArray(res?.items) ? res.items : []);
        tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c: any) => ({ id: c?.media_content_id, title: c?.title })).filter((it) => it.id || it.title);
      }

      this._setBrowseData('playlist_tracks', prefixedId, tracks);
    }
  }

  private _browseBack(): void {
    if (!this._browseStack || !this._browseStack.length) return;
    const prev = this._browseStack.pop();
    if (!prev) return;
    // If navigating back to a top section, reload from cache/api
    if (prev.section === 'playlists' || prev.section === 'albums' || prev.section === 'artists' || prev.section === 'search') {
      this._browseSection = prev.section;
      this._browsePage = 0;
      this._browseAlpha = '';
      this._browseReqToken++;
      // Use cache if available for top sections
      const cached = (this as any)._browseCache && (this as any)._browseCache[prev.section];
      if (Array.isArray(cached)) {
        this._browseData = { section: prev.section, data: cached };
        this._renderBrowseList(cached);
      } else {
        this._loadBrowseData();
      }
      return;
    }
    // Otherwise, reload children for previous context
    const arg = prev.arg || '';
    if (prev.section === 'artist_albums') {
      // previous context was artist view; show artists list again
      this._browseSection = 'artists';
      this._loadBrowseData();
    } else if (prev.section === 'album_tracks') {
      this._browseSection = 'albums';
      this._loadBrowseData();
    } else if (prev.section === 'playlist_tracks') {
      this._browseSection = 'playlists';
      this._loadBrowseData();
    } else {
      this._browseSection = prev.section;
      this._loadBrowseData();
    }
  }

  // Continue adding all methods
}

// Define the custom element once, if not already registered
if (!customElements.get('music-controller-panel')) {
  customElements.define('music-controller-panel', MusicControllerPanel);
}
