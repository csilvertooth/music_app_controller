class MusicNowPlayingCard extends HTMLElement {
    constructor() {
        super();
        this._hass = null;
        this._config = {};
        this._holdUntil = 0;
        this._lastNPKey = '';
        this._currentArtTok = '';
        this._pendingArtFetch = false;
        this._lastStatusFetchAt = 0;
        this._lastArtTokCached = '';
        this._storeUnsub = null;
        this._usingStore = false;
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
    setConfig(config) {
        this._config = Object.assign({}, config);
    }
    set hass(hass) {
        this._hass = hass;
        this._update();
    }
    connectedCallback() {
        var _a;
        // Wire event listeners here
        (_a = this._root.querySelector('#prev')) === null || _a === void 0 ? void 0 : _a.addEventListener('click', () => this._svc('media_previous_track'));
        // Add all other event listeners from the original code
    }
    // Add all methods from the original MusicNowPlayingCard, typed appropriately.
    _entityId() {
        var _a;
        if (this._config.entity)
            return this._config.entity;
        const s = (_a = this._hass) === null || _a === void 0 ? void 0 : _a.states;
        return (s === null || s === void 0 ? void 0 : s['media_player.music_control_player']) ? 'media_player.music_control_player' : 'media_player.apple_music_player';
    }
    _svc(service, data = {}) {
        if (!this._hass)
            return;
        this._hass.callService('media_player', service, Object.assign({ entity_id: this._entityId() }, data));
    }
    _setVol(level) {
        this._svc('volume_set', { volume_level: level });
    }
    _bumpVol(delta) {
        var _a, _b, _c;
        const ent = (_b = (_a = this._hass) === null || _a === void 0 ? void 0 : _a.states) === null || _b === void 0 ? void 0 : _b[this._entityId()];
        let cur = (typeof ((_c = ent === null || ent === void 0 ? void 0 : ent.attributes) === null || _c === void 0 ? void 0 : _c.volume_level) === 'number') ? ent.attributes.volume_level : 0;
        cur = Math.max(0, Math.min(1, cur + delta));
        const slider = this._root.querySelector('#masterVol');
        if (slider)
            slider.value = String(cur);
        this._holdUntil = Date.now() + 900;
        this._setVol(cur);
    }
    async _update() {
        var _a, _b;
        const ent = (_b = (_a = this._hass) === null || _a === void 0 ? void 0 : _a.states) === null || _b === void 0 ? void 0 : _b[this._entityId()];
        if (!ent)
            return;
        const attrs = ent.attributes || {};
        const trackEl = this._root.querySelector('#track');
        const artistEl = this._root.querySelector('#artist');
        const albumEl = this._root.querySelector('#album');
        const nextTitle = attrs.media_title || ((trackEl === null || trackEl === void 0 ? void 0 : trackEl.textContent) || '—');
        const nextArtist = attrs.media_artist || ((artistEl === null || artistEl === void 0 ? void 0 : artistEl.textContent) || '—');
        const nextAlbum = attrs.media_album_name || ((albumEl === null || albumEl === void 0 ? void 0 : albumEl.textContent) || '—');
        const prevKey = this._lastNPKey || '';
        const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
        this._lastNPKey = nextKey;
        if (trackEl)
            trackEl.textContent = nextTitle;
        if (artistEl)
            artistEl.textContent = nextArtist;
        if (albumEl)
            albumEl.textContent = nextAlbum;
        const vol = (typeof attrs.volume_level === 'number') ? attrs.volume_level : 0;
        const volEl = this._root.querySelector('#masterVol');
        if (volEl && Date.now() >= this._holdUntil)
            volEl.value = String(vol);
        // Always use direct artwork API, never fall back to entity_picture which might use media player proxy
        try {
            const tok = await this._fetchArtworkTokenThrottled();
            if (tok) {
                await this._setArtworkToken(tok);
            }
            else {
                // If no token available, always refresh current artwork directly on track change
                if (nextKey !== prevKey) {
                    await this._refreshCurrentArtworkNoToken();
                }
                // For initial load or when no track change, ensure we have artwork displayed
                const artEl = this._root.querySelector('#art');
                const hasBlob = !!(artEl && artEl.dataset && artEl.dataset.blobUrl);
                if (!hasBlob && artEl) {
                    // Use direct artwork API instead of entity_picture to avoid media player proxy
                    await this._refreshCurrentArtworkNoToken();
                }
            }
        }
        catch (_) {
            // On any error, try to fetch artwork directly instead of using entity_picture
            const artEl = this._root.querySelector('#art');
            const hasBlob = !!(artEl && artEl.dataset && artEl.dataset.blobUrl);
            if (!hasBlob && artEl) {
                try {
                    await this._refreshCurrentArtworkNoToken();
                }
                catch (_) {
                    // Last resort: set a placeholder or keep existing image
                }
            }
        }
        await this._syncShuffleButton();
        try {
            const st = (ent && ent.state) ? String(ent.state).toLowerCase() : '';
            const btn = this._root.querySelector('#playpause');
            if (btn) {
                btn.classList.remove('pp-playing', 'pp-paused', 'pp-idle');
                if (st === 'playing')
                    btn.classList.add('pp-playing');
                else if (st === 'paused')
                    btn.classList.add('pp-paused');
                else
                    btn.classList.add('pp-idle');
            }
        }
        catch (_) { }
    }
    async _toggleShuffle() {
        var _a, _b, _c, _d, _e;
        try {
            const st = await ((_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('GET', 'apple_music/status'));
            const cur = !!((_c = (_b = st === null || st === void 0 ? void 0 : st.shuffle) !== null && _b !== void 0 ? _b : st === null || st === void 0 ? void 0 : st.is_shuffle) !== null && _c !== void 0 ? _c : (_d = st === null || st === void 0 ? void 0 : st.player) === null || _d === void 0 ? void 0 : _d.shuffle);
            await ((_e = this._hass) === null || _e === void 0 ? void 0 : _e.callApi('POST', 'apple_music/shuffle', { enabled: !cur }));
        }
        catch (_) { /* ignore */ }
        await this._syncShuffleButton();
    }
    async _syncShuffleButton() {
        var _a, _b, _c, _d;
        const btn = this._root.querySelector('#shuffle');
        if (!btn)
            return;
        try {
            const st = await ((_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('GET', 'apple_music/status'));
            const isShuffle = !!((_c = (_b = st === null || st === void 0 ? void 0 : st.shuffle) !== null && _b !== void 0 ? _b : st === null || st === void 0 ? void 0 : st.is_shuffle) !== null && _c !== void 0 ? _c : (_d = st === null || st === void 0 ? void 0 : st.player) === null || _d === void 0 ? void 0 : _d.shuffle);
            btn.classList.toggle('active', !!isShuffle);
        }
        catch (e) { /* ignore */ }
    }
    _showBrowseNP() {
        const modal = this._root.querySelector('#browseModalNP');
        if (!modal)
            return;
        // lazily configure embedded browse card once
        const bc = this._root.querySelector('#embeddedBrowse');
        if (bc && !bc._configured) {
            try {
                bc.setConfig({ title: 'Browse & Search' });
                bc._configured = true;
            }
            catch (_) { }
            if (this._hass) {
                try {
                    bc.hass = this._hass;
                }
                catch (_) { }
            }
        }
        modal.classList.add('show');
    }
    _hideBrowseNP() {
        const modal = this._root.querySelector('#browseModalNP');
        if (!modal)
            return;
        modal.classList.remove('show');
    }
    // Artwork helpers
    _signedPath(path) {
        try {
            if (this._hass && this._hass.callWS) {
                return this._hass
                    .callWS({ type: 'auth/sign_path', path, expires: 60 })
                    .then((resp) => (resp && typeof resp.path === 'string' && resp.path) ? resp.path : path)
                    .catch(() => path);
            }
        }
        catch (_) { }
        return Promise.resolve(path);
    }
    _artCacheKey(tok) {
        // Always use token-based cache key to avoid stale artwork
        const cacheKey = tok ? `https://am-art.local/art/token/${encodeURIComponent(tok)}` : `https://am-art.local/art/current/${Date.now()}`;
        return cacheKey;
    }
    async _getArtCache() {
        try {
            return await caches.open('apple_music_artwork');
        }
        catch (_) {
            return null;
        }
    }
    async _loadArtFromCache(tok) {
        try {
            const cache = await this._getArtCache();
            if (!cache)
                return null;
            const req = new Request(this._artCacheKey(tok));
            const resp = await cache.match(req);
            return resp || null;
        }
        catch (_) {
            return null;
        }
    }
    async _fetchAndCacheArt(tok) {
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
        }
        catch (_) {
            resp = null;
        }
        if (resp && resp.ok) {
            try {
                const cache = await this._getArtCache();
                if (cache) {
                    // Clear old cache entries for this token first
                    await this._clearTokenFromCache(tok);
                    await cache.put(new Request(this._artCacheKey(tok)), resp.clone());
                }
            }
            catch (_) { }
            return resp;
        }
        return null;
    }
    async _setArtworkToken(tok) {
        try {
            if (!tok)
                return;
            // Clear any existing artwork if token changed
            if (this._currentArtTok && this._currentArtTok !== tok) {
                await this._clearArtworkCache();
            }
            this._currentArtTok = tok;
            const artEl = this._root.querySelector('#art');
            if (!artEl)
                return;
            // Always fetch fresh artwork for new tokens, bypass cache for now
            const resp = await this._fetchAndCacheArt(tok);
            if (!resp)
                return;
            const blob = await resp.blob();
            const url = URL.createObjectURL(blob);
            const tmp = new Image();
            tmp.onload = () => {
                if (this._currentArtTok === tok) {
                    const prev = artEl.dataset.blobUrl;
                    artEl.src = url;
                    artEl.dataset.blobUrl = url;
                    artEl.dataset.artworkToken = tok; // Store token for reference
                    if (prev && prev !== url) {
                        try {
                            URL.revokeObjectURL(prev);
                        }
                        catch (_) { }
                    }
                }
                else {
                    try {
                        URL.revokeObjectURL(url);
                    }
                    catch (_) { }
                }
            };
            tmp.onerror = () => { try {
                URL.revokeObjectURL(url);
            }
            catch (_) { } };
            tmp.src = url;
        }
        catch (_) { /* ignore */ }
    }
    async _refreshCurrentArtworkNoToken() {
        if (this._pendingArtFetch)
            return;
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
            if (!r || !r.ok)
                throw new Error('artwork fetch failed');
            const blob = await r.blob();
            const artEl = this._root.querySelector('#art');
            if (artEl && blob) {
                const objUrl = URL.createObjectURL(blob);
                const prev = artEl.dataset.blobUrl;
                artEl.src = objUrl;
                artEl.dataset.blobUrl = objUrl;
                if (prev && prev !== objUrl) {
                    try {
                        URL.revokeObjectURL(prev);
                    }
                    catch (_) { }
                }
            }
        }
        catch (_) { /* ignore */ }
        finally {
            this._pendingArtFetch = false;
        }
    }
    async _fetchArtworkTokenThrottled() {
        var _a;
        const now = Date.now();
        if ((now - this._lastStatusFetchAt) < 1200 && this._lastArtTokCached !== undefined) {
            return this._lastArtTokCached || '';
        }
        this._lastStatusFetchAt = now;
        try {
            const st = await ((_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('GET', 'apple_music/status'));
            const tok = (st && (st.artwork_token || st.token)) ? String(st.artwork_token || st.token) : '';
            this._lastArtTokCached = tok;
            return tok;
        }
        catch (_) {
            this._lastArtTokCached = '';
            return '';
        }
    }
    async _clearTokenFromCache(tok) {
        try {
            const cache = await this._getArtCache();
            if (!cache)
                return;
            const cacheKey = this._artCacheKey(tok);
            await cache.delete(new Request(cacheKey));
        }
        catch (_) { /* ignore */ }
    }
    async _clearArtworkCache() {
        try {
            const cache = await this._getArtCache();
            if (!cache)
                return;
            // Clear all artwork cache entries
            const keys = await cache.keys();
            for (const key of keys) {
                if (key.url.includes('am-art.local')) {
                    await cache.delete(key);
                }
            }
        }
        catch (_) { /* ignore */ }
    }
    // Continue adding the rest of the methods with types.
    disconnectedCallback() {
        if (this._storeUnsub) {
            this._storeUnsub();
            this._storeUnsub = null;
        }
    }
}
// Global throttling for artwork API calls
MusicNowPlayingCard._lastArtworkFetch = 0;
MusicNowPlayingCard.ARTWORK_THROTTLE_MS = 500;
customElements.define('music-now-playing-card', MusicNowPlayingCard);
export {};
