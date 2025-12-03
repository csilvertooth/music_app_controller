// music-now-playing-card.ts
import { HomeAssistant } from 'custom-card-helpers';

interface Config {
  title?: string;
  entity?: string;
}

class MusicNowPlayingCard extends HTMLElement {
  private _hass: HomeAssistant | null = null;
  private _config: Config = {};
  private _holdUntil = 0;
  private _lastNPKey = '';
  private _currentArtTok = '';
  private _pendingArtFetch = false;
  private _lastStatusFetchAt = 0;
  private _lastArtTokCached = '';
  private _storeUnsub: (() => void) | null = null;
  private _usingStore = false;
  private _root: HTMLElement;

  // Global throttling for artwork API calls
  private static _lastArtworkFetch = 0;
  private static readonly ARTWORK_THROTTLE_MS = 500;

  constructor() {
    super();
    this._root = document.createElement('div');
    this._root.innerHTML = `
      <style>
        ha-card { position: relative; }
        .card-header.np-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 16px 0; }
        .media { display:flex; align-items:center; justify-content:center; text-align:center; gap:16px; padding:14px 16px 18px; flex-wrap: wrap; }
        .art { width: min(100%, 360px); max-width: 100%; aspect-ratio: 1 / 1; height: auto; border-radius:8px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 8%, transparent)); object-fit:cover; }
        .meta { min-width: 360px; text-align:center; flex: 1 1 360px; }
        .track { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .artist, .album { opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .controls { display:flex; gap:12px; margin-top:12px; align-items:center; justify-content:center; flex-wrap: nowrap; }
        .controls button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-width:72px; }
        .controls button ha-icon { --mdc-icon-size: 26px; }
        .volrow { display:flex; gap:12px; margin-top:12px; align-items:center; }
        #playpause { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
        #playpause.pp-playing { background: var(--primary-color); color: #fff; }
        #playpause.pp-paused { background: #FB8C00; color: #1b1b1b; }
        #playpause.pp-idle { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
        #shuffle { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
        #shuffle.active { background: var(--primary-color); color: #fff; }
        .track, .artist, .album { margin-bottom:6px; }
        button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
        button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
        input[type="range"] { width: 100%; max-width: 560px; }
        .modal { position: fixed; inset: 0; display:none; align-items:center; justify-content:center; z-index: 1000; }
        .modal.show { display:flex; }
        .modal .backdrop { position:absolute; inset:0; background: var(--dialog-backdrop-color, color-mix(in srgb, var(--primary-text-color) 50%, transparent)); }
        .modal .sheet { position:relative; width: min(92vw, 860px); max-width: 860px; max-height: 80vh; margin: 0 16px; }
        .modal .close { position:absolute; top:8px; right:12px; z-index:1; }
      </style>
      <ha-card>
        <div class="card-header np-header">
          <div class="np-title">${this._config.title || 'Music Player'}</div>
          <button id="openBrowseNP" class="secondary">Browse</button>
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
              <input id="masterVol" type="range" min="0" max="1" step="0.01" />
              <button id="mvUp" class="secondary" title="Volume up">+</button>
            </div>
            <div class="devices" style="display:flex; gap:12px; margin-top:12px; align-items:center; justify-content:center; flex-wrap:wrap;">
              <span style="opacity:.8">AirPlay</span>
              <div id="deviceList" style="display:flex; gap:8px; flex-wrap:wrap;"></div>
            </div>
          </div>
        </div>
        <div id="browseModalNP" class="modal" aria-hidden="true">
          <div class="backdrop"></div>
          <div class="sheet">
            <button id="browseCloseNP" class="secondary close">✕</button>
            <music-browse-card id="embeddedBrowse"></music-browse-card>
          </div>
        </div>
      </ha-card>
    `;
    this.appendChild(this._root);
  }

  setConfig(config: Config) {
    this._config = { ...config };
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    this._update();
  }

  connectedCallback() {
    this._root.querySelector('#prev')?.addEventListener('click', () => this._svc('media_previous_track'));
    this._root.querySelector('#playpause')?.addEventListener('click', () => this._svc('media_play_pause'));
    this._root.querySelector('#next')?.addEventListener('click', () => this._svc('media_next_track'));
    this._root.querySelector('#shuffle')?.addEventListener('click', () => this._toggleShuffle());
    this._root.querySelector('#mvDown')?.addEventListener('click', () => this._bumpVol(-0.1));
    this._root.querySelector('#mvUp')?.addEventListener('click', () => this._bumpVol(0.1));
    this._root.querySelector('#masterVol')?.addEventListener('input', (e) => this._setVol(parseFloat((e.target as any).value)));
    this._root.querySelector('#openBrowseNP')?.addEventListener('click', () => this._showBrowseNP());
    this._root.querySelector('#browseCloseNP')?.addEventListener('click', () => this._hideBrowseNP());
  }

  // Add all methods from the original MusicNowPlayingCard, typed appropriately.

  private _entityId(): string {
    if (this._config.entity) return this._config.entity;
    const s = this._hass?.states;
    return s?.['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }

  private _svc(service: string, data: any = {}) {
    if (!this._hass) return;
    this._hass.callService('media_player', service, { entity_id: this._entityId(), ...data });
  }

  private _setVol(level: number): void {
    this._svc('volume_set', { volume_level: level });
  }

  private _bumpVol(delta: number): void {
    const ent = this._hass?.states?.[this._entityId()];
    let cur = (typeof ent?.attributes?.volume_level === 'number') ? ent.attributes.volume_level : 0;
    cur = Math.max(0, Math.min(1, cur + delta));
    const slider = this._root.querySelector('#masterVol') as HTMLInputElement;
    if (slider) slider.value = String(cur);
    this._holdUntil = Date.now() + 900;
    this._setVol(cur);
  }

  private async _update(): Promise<void> {
    const ent = this._hass?.states?.[this._entityId()];
    if (!ent) return;
    const attrs = ent.attributes || {};
    const trackEl = this._root.querySelector('#track') as HTMLElement;
    const artistEl = this._root.querySelector('#artist') as HTMLElement;
    const albumEl = this._root.querySelector('#album') as HTMLElement;
    const nextTitle = attrs.media_title || (trackEl?.textContent || '—');
    const nextArtist = attrs.media_artist || (artistEl?.textContent || '—');
    const nextAlbum = attrs.media_album_name || (albumEl?.textContent || '—');
    const prevKey = this._lastNPKey || '';
    const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
    this._lastNPKey = nextKey;
    if (trackEl) trackEl.textContent = nextTitle;
    if (artistEl) artistEl.textContent = nextArtist;
    if (albumEl) albumEl.textContent = nextAlbum;
    const vol = (typeof attrs.volume_level === 'number') ? attrs.volume_level : 0;
    const volEl = this._root.querySelector('#masterVol') as HTMLInputElement;
    if (volEl && Date.now() >= this._holdUntil) volEl.value = String(vol);
    // Always use direct artwork API, never fall back to entity_picture which might use media player proxy
    try {
      const tok = await this._fetchArtworkTokenThrottled();
      if (tok) {
        await this._setArtworkToken(tok);
      } else {
        // If no token available, always refresh current artwork directly on track change
        if (nextKey !== prevKey) {
          await this._refreshCurrentArtworkNoToken();
        }
        // For initial load or when no track change, ensure we have artwork displayed
        const artEl = this._root.querySelector('#art') as HTMLImageElement;
        const hasBlob = !!(artEl && artEl.dataset && artEl.dataset.blobUrl);
        if (!hasBlob && artEl) {
          // Use direct artwork API instead of entity_picture to avoid media player proxy
          await this._refreshCurrentArtworkNoToken();
        }
      }
    } catch (_) {
      // On any error, try to fetch artwork directly instead of using entity_picture
      const artEl = this._root.querySelector('#art') as HTMLImageElement;
      const hasBlob = !!(artEl && artEl.dataset && artEl.dataset.blobUrl);
      if (!hasBlob && artEl) {
        try {
          await this._refreshCurrentArtworkNoToken();
        } catch (_) {
          // Last resort: set a placeholder or keep existing image
        }
      }
    }
    await this._syncShuffleButton();
    try {
      const st = (ent && ent.state) ? String(ent.state).toLowerCase() : '';
      const btn = this._root.querySelector('#playpause') as HTMLElement;
      if (btn) { btn.classList.remove('pp-playing', 'pp-paused', 'pp-idle'); if (st === 'playing') btn.classList.add('pp-playing'); else if (st === 'paused') btn.classList.add('pp-paused'); else btn.classList.add('pp-idle'); }
    } catch (_) { }
    await this._updateDeviceSelection(attrs);
  }

  private async _toggleShuffle(): Promise<void> {
    try {
      const st: any = await this._hass?.callApi('GET', 'apple_music/status');
      const cur = !!(st?.shuffle ?? st?.is_shuffle ?? st?.player?.shuffle);
      await this._hass?.callApi('POST', 'apple_music/shuffle', { enabled: !cur });
    } catch (_) { /* ignore */ }
    await this._syncShuffleButton();
  }

  private async _syncShuffleButton(): Promise<void> {
    const btn = this._root.querySelector('#shuffle') as HTMLElement;
    if (!btn) return;
    try {
      const st: any = await this._hass?.callApi('GET', 'apple_music/status');
      const isShuffle = !!(st?.shuffle ?? st?.is_shuffle ?? st?.player?.shuffle);
      btn.classList.toggle('active', !!isShuffle);
    } catch (e) { /* ignore */ }
  }

  private _showBrowseNP(): void {
    const modal = this._root.querySelector('#browseModalNP') as HTMLElement;
    if (!modal) return;
    // lazily configure embedded browse card once
    const bc = this._root.querySelector('#embeddedBrowse') as any;
    if (bc && !bc._configured) {
      try { bc.setConfig({ title: 'Browse & Search' }); bc._configured = true; } catch (_) { }
      if (this._hass) { try { bc.hass = this._hass; } catch (_) { } }
    }
    modal.classList.add('show');
  }

  private _hideBrowseNP(): void {
    const modal = this._root.querySelector('#browseModalNP') as HTMLElement;
    if (!modal) return;
    modal.classList.remove('show');
  }

  // Artwork helpers
  private _signedPath(path: string): Promise<string> {
    try {
      if (this._hass && this._hass.callWS) {
        return this._hass
          .callWS({ type: 'auth/sign_path', path, expires: 60 })
          .then((resp: any) => (resp && typeof resp.path === 'string' && resp.path) ? resp.path : path)
          .catch(() => path);
      }
    } catch (_) { }
    return Promise.resolve(path);
  }

  private _artCacheKey(tok: string): string {
    // Always use token-based cache key to avoid stale artwork
    const cacheKey = tok ? `https://am-art.local/art/token/${encodeURIComponent(tok)}` : `https://am-art.local/art/current/${Date.now()}`;
    return cacheKey;
  }

  private async _getArtCache(): Promise<Cache | null> {
    try { return await caches.open('apple_music_artwork'); } catch (_) { return null; }
  }

  private async _loadArtFromCache(tok: string): Promise<Response | null> {
    try { const cache = await this._getArtCache(); if (!cache) return null; const req = new Request(this._artCacheKey(tok)); const resp = await cache.match(req); return resp || null; } catch (_) { return null; }
  }

  private async _fetchAndCacheArt(tok: string): Promise<Response | null> {
    const path = `/api/apple_music/artwork?tok=${encodeURIComponent(tok)}&size=256&t=${Date.now()}`;
    const url = await this._signedPath(path).catch(() => path);
    let resp = null;
    try {
      resp = await fetch(url, {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache'
        }
      });
    } catch (_) { resp = null; }
    if (resp && resp.ok) {
      try {
        const cache = await this._getArtCache();
        if (cache) {
          // Clear old cache entries for this token first
          await this._clearTokenFromCache(tok);
          await cache.put(new Request(this._artCacheKey(tok)), resp.clone());
        }
      } catch (_) { }
      return resp;
    }
    return null;
  }

  private async _setArtworkToken(tok: string): Promise<void> {
    try {
      if (!tok) return;

      // Clear any existing artwork if token changed
      if (this._currentArtTok && this._currentArtTok !== tok) {
        await this._clearArtworkCache();
      }

      this._currentArtTok = tok;
      const artEl = this._root.querySelector('#art') as HTMLImageElement;
      if (!artEl) return;

      // Always fetch fresh artwork for new tokens, bypass cache for now
      const resp = await this._fetchAndCacheArt(tok);
      if (!resp) return;

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const tmp = new Image();
      tmp.onload = () => {
        if (this._currentArtTok === tok) {
          const prev = artEl.dataset.blobUrl;
          artEl.src = url;
          artEl.dataset.blobUrl = url;
          artEl.dataset.artworkToken = tok; // Store token for reference
          if (prev && prev !== url) { try { URL.revokeObjectURL(prev); } catch (_) { } }
        } else {
          try { URL.revokeObjectURL(url); } catch (_) { }
        }
      };
      tmp.onerror = () => { try { URL.revokeObjectURL(url); } catch (_) { } };
      tmp.src = url;
    } catch (_) { /* ignore */ }
  }

  private async _refreshCurrentArtworkNoToken(): Promise<void> {
    if (this._pendingArtFetch) return;

    // Global throttling to prevent excessive API calls
    const now = Date.now();
    if (now - MusicNowPlayingCard._lastArtworkFetch < MusicNowPlayingCard.ARTWORK_THROTTLE_MS) {
      return;
    }
    MusicNowPlayingCard._lastArtworkFetch = now;

    this._pendingArtFetch = true;
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
      if (!r || !r.ok) throw new Error('artwork fetch failed');
      const blob = await r.blob();
      const artEl = this._root.querySelector('#art') as HTMLImageElement;
      if (artEl && blob) {
        const objUrl = URL.createObjectURL(blob);
        const prev = artEl.dataset.blobUrl;
        artEl.src = objUrl;
        artEl.dataset.blobUrl = objUrl;
        if (prev && prev !== objUrl) { try { URL.revokeObjectURL(prev); } catch (_) { } }
      }
    } catch (_) { /* ignore */ }
    finally { this._pendingArtFetch = false; }
  }

  private async _fetchArtworkTokenThrottled(): Promise<string> {
    const now = Date.now();
    if ((now - this._lastStatusFetchAt) < 1200 && this._lastArtTokCached !== undefined) {
      return this._lastArtTokCached || '';
    }
    this._lastStatusFetchAt = now;
    try {
      const st: any = await this._hass?.callApi('GET', 'apple_music/status');
      const tok = (st && (st.artwork_token || st.token)) ? String(st.artwork_token || st.token) : '';
      this._lastArtTokCached = tok;
      return tok;
    } catch (_) {
      this._lastArtTokCached = '';
      return '';
    }
  }

  private async _clearTokenFromCache(tok: string): Promise<void> {
    try {
      const cache = await this._getArtCache();
      if (!cache) return;
      const cacheKey = this._artCacheKey(tok);
      await cache.delete(new Request(cacheKey));
    } catch (_) { /* ignore */ }
  }

  private async _clearArtworkCache(): Promise<void> {
    try {
      const cache = await this._getArtCache();
      if (!cache) return;
      // Clear all artwork cache entries
      const keys = await cache.keys();
      for (const key of keys) {
        if (key.url.includes('am-art.local')) {
          await cache.delete(key);
        }
      }
    } catch (_) { /* ignore */ }
  }

  private async _updateDeviceSelection(attrs: any): Promise<void> {
    const deviceListEl = this._root.querySelector('#deviceList') as HTMLElement;
    if (!deviceListEl || !this._hass) return;

    const available: string[] = attrs.available_devices || [];
    const selected: string[] = attrs.selected_devices || [];

    deviceListEl.innerHTML = '';

    available.forEach(device => {
      const label = document.createElement('label');
      label.style.display = 'flex';
      label.style.alignItems = 'center';
      label.style.gap = '4px';
      label.style.opacity = '0.8';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selected.includes(device);
      checkbox.addEventListener('change', (e) => {
        const checked = (e.target as any).checked;
        const newSelected = checked
          ? [...selected, device].filter(d => available.includes(d))
          : selected.filter(d => d !== device);
        this._hass?.callService('apple_music', 'set_selected_airplay_devices', { devices: newSelected });
      });

      const text = document.createElement('span');
      text.textContent = device;

      label.appendChild(checkbox);
      label.appendChild(text);
      deviceListEl.appendChild(label);
    });
  }

  disconnectedCallback() {
    if (this._storeUnsub) { this._storeUnsub(); this._storeUnsub = null; }
  }
}

customElements.define('music-now-playing-card', MusicNowPlayingCard);
