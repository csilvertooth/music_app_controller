export class MusicControllerPanel extends HTMLElement {
    constructor() {
        super(...arguments);
        this._ready = false;
        this._hass = null;
        this._pollHandle = null;
        this._devices = [];
        this._currentDevices = new Set();
        this._deviceVolumes = {};
        this._debouncers = new Map();
        this._pendingApply = false;
        this._showDisabled = false;
        this._browseSection = '';
        this._browseStack = [];
        this._browseData = null;
        this._browseCache = { playlists: null, albums: null, artists: null };
        this._browsePage = 0;
        this._pageSize = 5;
        this._browseAlpha = '';
        this._browseReqToken = 0;
        this._preferWS = true;
        this._marqTimers = new WeakMap();
        this._es = null;
        this._sseBackoff = 1000;
        this._sseHealthy = false;
        this._healthHandle = null;
        this._storeUnsub = null;
        this._masterHoldUntil = 0;
        this._devHold = new Map();
        this._lastNPKey = '';
        this._masterVolDragging = false;
        this._deviceVolDragging = new Set();
        this._status = {};
        this._wakeHandlersBound = false;
        // Continue adding all methods
    }
    // Methods will be implemented below
    // Implement the missing methods
    _connectSSE() {
        try {
            if (this._es) {
                try {
                    this._es.close();
                }
                catch (_) { }
                this._es = null;
            }
            const open = async () => {
                const base = '/api/apple_music/events';
                let url = base;
                try {
                    url = await this._signedPath(base);
                }
                catch (_) {
                    url = base;
                }
                const src = new EventSource(url);
                this._es = src;
                src.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleSSEEvent(data);
                        this._sseHealthy = true;
                    }
                    catch (e) {
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
                    try {
                        src.close();
                    }
                    catch (_) { }
                    if (this._es === src)
                        this._es = null;
                    const wait = this._sseBackoff;
                    this._sseBackoff = Math.min(this._sseBackoff * 2, 30000);
                    setTimeout(() => {
                        if (!this._es)
                            this._connectSSE();
                    }, wait);
                };
            };
            open();
        }
        catch (_) { }
    }
    _handleSSEEvent(data) {
        var _a;
        const event = data.event;
        const payload = data.data;
        switch (event) {
            case 'now':
                this._updateFromSSE(payload);
                break;
            case 'snapshot':
                if (payload.now)
                    this._updateFromSSE(payload.now);
                if (payload.airplay)
                    this._updateDevicesFromSSE(payload.airplay);
                if (typeof payload.master === 'number')
                    this._updateVolumeFromSSE(payload.master);
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
                    const enabled = !!(payload === null || payload === void 0 ? void 0 : payload.enabled);
                    this._status = Object.assign(Object.assign({}, (this._status || {})), { shuffle: enabled });
                    (_a = this._updateShuffleButtonVisual) === null || _a === void 0 ? void 0 : _a.call(this);
                }
                catch (_) { }
                break;
        }
    }
    _updateFromSSE(now) {
        var _a, _b, _c, _d, _e, _f, _g;
        if (!now || typeof now !== 'object')
            return;
        const mp = this._mpEntity();
        const attrs = (mp === null || mp === void 0 ? void 0 : mp.attributes) || {};
        const nextTitle = now.title || attrs.media_title || (((_a = this.querySelector('#track')) === null || _a === void 0 ? void 0 : _a.textContent) || '—');
        const nextArtist = now.artist || attrs.media_artist || (((_b = this.querySelector('#artist')) === null || _b === void 0 ? void 0 : _b.textContent) || '—');
        const nextAlbum = now.album || attrs.media_album_name || (((_c = this.querySelector('#album')) === null || _c === void 0 ? void 0 : _c.textContent) || '—');
        const prevKey = this._lastNPKey || '';
        const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
        this._lastNPKey = nextKey;
        const trackEl = this.querySelector('#track');
        const artistEl = this.querySelector('#artist');
        const albumEl = this.querySelector('#album');
        if (trackEl)
            trackEl.textContent = nextTitle;
        if (artistEl)
            artistEl.textContent = nextArtist;
        if (albumEl)
            albumEl.textContent = nextAlbum;
        // Update volume if provided and user is not actively dragging
        if (typeof now.volume === 'number' && Date.now() >= this._masterHoldUntil && !this._masterVolDragging) {
            const masterVol = this.querySelector('#masterVol');
            if (masterVol)
                masterVol.value = String(now.volume / 100);
        }
        // Update artwork if token provided
        const token = now.artwork_token;
        if (token) {
            try {
                (_d = this._setArtwork) === null || _d === void 0 ? void 0 : _d.call(this, token);
            }
            catch (_) { }
        }
        else if (nextKey !== prevKey) {
            try {
                (_e = this._refreshCurrentArtworkNoToken) === null || _e === void 0 ? void 0 : _e.call(this);
            }
            catch (_) { }
        }
        // Update play/pause state from SSE if provided
        try {
            const s = (typeof now.state === 'string' && now.state) ? String(now.state).toLowerCase() : '';
            if (s) {
                this._status = Object.assign(Object.assign({}, (this._status || {})), { state: s });
            }
        }
        catch (_) { }
        (_f = this._applyNowPlayingMarquee) === null || _f === void 0 ? void 0 : _f.call(this);
        (_g = this._updatePlayPauseVisual) === null || _g === void 0 ? void 0 : _g.call(this);
    }
    _updateDevicesFromSSE(devices) {
        var _a;
        if (!Array.isArray(devices))
            return;
        const names = devices.map((d) => d.name).filter((n) => n);
        this._devices = names;
        const active = devices.filter(d => d.active).map(d => d.name);
        this._currentDevices = new Set(active);
        // Update device volumes
        devices.forEach((d) => {
            if (d.name && typeof d.volume === 'number') {
                this._deviceVolumes[d.name] = d.volume;
            }
        });
        (_a = this._renderDevices) === null || _a === void 0 ? void 0 : _a.call(this);
    }
    _updateVolumeFromSSE(volume) {
        if (typeof volume !== 'number')
            return;
        const masterVol = this.querySelector('#masterVol');
        if (masterVol && Date.now() >= this._masterHoldUntil) {
            masterVol.value = String(volume / 100);
        }
    }
    // Implementations for previously optional helpers
    _updateShuffleButtonVisual() {
        try {
            const btn = this.querySelector('#shuffle');
            if (!btn)
                return;
            const on = !!(this._status && this._status.shuffle);
            btn.classList.toggle('active', on);
        }
        catch (_) { }
    }
    _updatePlayPauseVisual() {
        var _a, _b;
        try {
            const mp = this._mpEntity();
            const sseState = String(((_a = this._status) === null || _a === void 0 ? void 0 : _a.state) || ((_b = this._status) === null || _b === void 0 ? void 0 : _b.playerState) || '').toLowerCase();
            const state = sseState || ((mp && typeof mp.state === 'string') ? String(mp.state).toLowerCase() : '');
            const btn = this.querySelector('#playpause');
            if (!btn)
                return;
            btn.classList.remove('pp-playing', 'pp-paused', 'pp-idle');
            if (state === 'playing')
                btn.classList.add('pp-playing');
            else if (state === 'paused')
                btn.classList.add('pp-paused');
            else
                btn.classList.add('pp-idle');
        }
        catch (_) { }
    }
    _applyNowPlayingMarquee() {
        try {
            const apply = (el) => {
                if (!el)
                    return;
                el.style.willChange = 'transform';
                // simple reset - do not animate continuously to avoid motion sickness
            };
            apply(this.querySelector('#track'));
            apply(this.querySelector('#artist'));
            apply(this.querySelector('#album'));
        }
        catch (_) { }
    }
    async _signedPath(path) {
        try {
            if (this._hass && this._hass.callWS) {
                const resp = await this._hass.callWS({ type: 'auth/sign_path', path, expires: 60 });
                if (resp && typeof resp.path === 'string' && resp.path)
                    return resp.path;
            }
        }
        catch (_) { }
        return path;
    }
    async _setArtwork(token) {
        var _a;
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
            if (!r || !r.ok)
                return;
            const blob = await r.blob();
            const artEl = this.querySelector('#art');
            if (!artEl)
                return;
            const obj = URL.createObjectURL(blob);
            const prev = (_a = artEl.dataset) === null || _a === void 0 ? void 0 : _a.blobUrl;
            artEl.src = obj;
            artEl.dataset = Object.assign(Object.assign({}, artEl.dataset), { blobUrl: obj, artworkToken: token });
            if (prev && prev !== obj) {
                try {
                    URL.revokeObjectURL(prev);
                }
                catch (_) { }
            }
        }
        catch (_) { }
    }
    async _refreshCurrentArtworkNoToken() {
        var _a;
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
            if (!r || !r.ok)
                return;
            const blob = await r.blob();
            const artEl = this.querySelector('#art');
            if (!artEl)
                return;
            const obj = URL.createObjectURL(blob);
            const prev = (_a = artEl.dataset) === null || _a === void 0 ? void 0 : _a.blobUrl;
            artEl.src = obj;
            artEl.dataset = Object.assign(Object.assign({}, artEl.dataset), { blobUrl: obj });
            if (prev && prev !== obj) {
                try {
                    URL.revokeObjectURL(prev);
                }
                catch (_) { }
            }
        }
        catch (_) { }
    }
    _updateNowPlayingAux() {
        // Sync shuffle button state from backend when possible
        try {
            if (!this._hass || !this._hass.callApi)
                return;
            this._hass.callApi('GET', 'apple_music/shuffle').then((res) => {
                const on = !!(res && (res.enabled === true));
                this._status = Object.assign(Object.assign({}, (this._status || {})), { shuffle: on });
                this._updateShuffleButtonVisual();
            }).catch(() => { });
        }
        catch (_) { }
    }
    _renderDevices() {
        try {
            const grid = this.querySelector('#devices');
            if (!grid)
                return;
            const names = Array.isArray(this._devices) ? [...this._devices] : [];
            names.sort((a, b) => {
                const ax = this._currentDevices.has(a) ? 0 : 1;
                const bx = this._currentDevices.has(b) ? 0 : 1;
                if (ax !== bx)
                    return ax - bx;
                return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' });
            });
            const list = this._showDisabled ? names : names.filter(n => this._currentDevices.has(n));
            const html = list.map((nm) => {
                var _a;
                const vol = Math.max(0, Math.min(100, Math.round((_a = this._deviceVolumes[nm]) !== null && _a !== void 0 ? _a : 0)));
                const checked = this._currentDevices.has(nm) ? 'checked' : '';
                const esc = (s) => String(s).replace(/&/g, '&').replace(/"/g, '"').replace(/</g, '<');
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
                    const t = e.target;
                    const name = t.getAttribute('data-dev') || '';
                    if (!name)
                        return;
                    if (t.checked)
                        this._currentDevices.add(name);
                    else
                        this._currentDevices.delete(name);
                    this._applyDevices();
                });
            });
            const bump = (name, delta) => {
                var _a;
                const cur = Math.max(0, Math.min(100, Math.round((_a = this._deviceVolumes[name]) !== null && _a !== void 0 ? _a : 0)));
                const next = Math.max(0, Math.min(100, cur + delta));
                const slider = grid.querySelector(`input[type="range"][data-dev-vol="${CSS.escape(name)}"]`);
                if (slider)
                    slider.value = String(next);
                this._deviceVolumes[name] = next;
                this._debounceDevVol(name, next);
            };
            grid.querySelectorAll('button[data-vol-down]').forEach((el) => {
                el.addEventListener('click', (e) => {
                    const name = e.currentTarget.getAttribute('data-vol-down') || '';
                    if (name)
                        bump(name, -5);
                });
            });
            grid.querySelectorAll('button[data-vol-up]').forEach((el) => {
                el.addEventListener('click', (e) => {
                    const name = e.currentTarget.getAttribute('data-vol-up') || '';
                    if (name)
                        bump(name, +5);
                });
            });
            grid.querySelectorAll('input[type="range"][data-dev-vol]').forEach((el) => {
                el.addEventListener('input', (e) => {
                    const t = e.target;
                    const name = t.getAttribute('data-dev-vol') || '';
                    const v = Math.max(0, Math.min(100, Math.round(Number(t.value) || 0)));
                    this._deviceVolumes[name] = v;
                    // Update chip
                    try {
                        const card = t.closest('.device');
                        const chip = card === null || card === void 0 ? void 0 : card.querySelector('.chip');
                        if (chip)
                            chip.textContent = `${v}%`;
                    }
                    catch (_) { }
                    this._debounceDevVol(name, v);
                });
            });
        }
        catch (_) { }
    }
    _debounceDevVol(name, level) {
        const key = `dev:${name}`;
        if (this._debouncers.has(key)) {
            clearTimeout(this._debouncers.get(key));
        }
        this._debouncers.set(key, setTimeout(() => {
            var _a;
            try {
                (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/set_device_volume', { device: name, level: level }).catch(() => { });
            }
            catch (_) { }
        }, 200));
    }
    _applyDevices() {
        var _a;
        try {
            const payload = { devices: Array.from(this._currentDevices).join(',') };
            (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/set_devices', payload).then(() => {
                // best-effort refresh of live state
                this._poll(true);
            }).catch(() => { });
        }
        catch (_) { }
    }
    connectedCallback() {
        // Reconnect/poll when returning from sleep or navigating back
        if (!this._wakeHandlersBound) {
            const refreshFromWake = () => {
                var _a, _b;
                try {
                    (_a = this._ensureUI) === null || _a === void 0 ? void 0 : _a.call(this);
                    (_b = this._restoreUIFromCache) === null || _b === void 0 ? void 0 : _b.call(this);
                }
                catch (_) { }
            };
            this._onVis = () => { var _a; if (document.visibilityState === 'visible') {
                refreshFromWake();
                try {
                    (_a = this._connectSSE) === null || _a === void 0 ? void 0 : _a.call(this);
                }
                catch (_) { }
                this._poll(true);
            } };
            this._onPageShow = () => { var _a; refreshFromWake(); try {
                (_a = this._connectSSE) === null || _a === void 0 ? void 0 : _a.call(this);
            }
            catch (_) { } this._poll(true); };
            this._onFocus = () => { refreshFromWake(); this._poll(true); };
            this._onOnline = () => { var _a; refreshFromWake(); try {
                (_a = this._connectSSE) === null || _a === void 0 ? void 0 : _a.call(this);
            }
            catch (_) { } this._poll(true); };
            if (this._onVis)
                document.addEventListener('visibilitychange', this._onVis);
            if (this._onPageShow)
                window.addEventListener('pageshow', this._onPageShow);
            if (this._onFocus)
                window.addEventListener('focus', this._onFocus);
            if (this._onOnline)
                window.addEventListener('online', this._onOnline);
            this._wakeHandlersBound = true;
        }
        // If we were detached and reattached, make sure polling resumes
        if (this._ready && !this._pollHandle)
            this._startPolling();
    }
    // Ensure the panel DOM exists after a suspension or HA hot-reload
    _ensureUI() {
        var _a;
        try {
            // If the main sections container is missing but we were previously ready, re-render the shell
            const hasSections = !!this.querySelector('#sections');
            if (!hasSections) {
                this._renderSkeleton();
                this._wireStaticHandlers();
                try {
                    (_a = this._applyLayout) === null || _a === void 0 ? void 0 : _a.call(this);
                }
                catch (_) { }
            }
        }
        catch (_) { /* ignore */ }
    }
    // Quickly paint last-known state so the UI isn't blank while waking
    _restoreUIFromCache() {
        var _a, _b, _c, _d, _e, _f;
        try {
            // Seed from shared store snapshot to avoid blank UI on wake
            try {
                const store = (typeof window !== 'undefined') ? window.__appleMusicStore : null;
                if (store) {
                    const snap = store.snapshot();
                    // Now Playing
                    const now = snap.now || {};
                    const nowTs = Number(snap.nowTs || 0);
                    const t = this.querySelector('#track');
                    const ar = this.querySelector('#artist');
                    const al = this.querySelector('#album');
                    if (t && now.title)
                        t.textContent = now.title;
                    if (ar && now.artist)
                        ar.textContent = now.artist;
                    if (al && now.album)
                        al.textContent = now.album;
                    const tok = now.artwork_token || '';
                    if (tok && (!nowTs || (Date.now() - nowTs) < 10000)) {
                        try {
                            this._setArtwork(tok);
                        }
                        catch (_) { }
                    }
                    // Shuffle + play/pause
                    try {
                        this._status = Object.assign(Object.assign({}, (this._status || {})), { shuffle: !!snap.shuffle });
                        (_a = this._updateShuffleButtonVisual) === null || _a === void 0 ? void 0 : _a.call(this);
                    }
                    catch (_) { }
                    try {
                        if (snap.playerState)
                            (_b = this._updatePlayPauseVisual) === null || _b === void 0 ? void 0 : _b.call(this);
                    }
                    catch (_) { }
                    // Devices snapshot
                    try {
                        const names = Array.isArray(snap.devices) ? snap.devices : [];
                        this._devices = names;
                        if (snap.current && typeof snap.current.has === 'function') {
                            this._currentDevices = new Set(names.filter(n => snap.current.has(n)));
                        }
                        this._deviceVolumes = Object.assign({}, (snap.vols || {}));
                        // Master volume from snapshot if present
                        try {
                            const mEl = this.querySelector('#masterVol');
                            const mv = Number(snap.master);
                            if (mEl && isFinite(mv))
                                mEl.value = String(mv / 100);
                        }
                        catch (_) { }
                    }
                    catch (_) { }
                }
            }
            catch (_) { }
            // If still missing now-playing metadata (e.g. fresh load and no store yet), fetch once
            try {
                const trackEl = this.querySelector('#track');
                const artistEl = this.querySelector('#artist');
                const albumEl = this.querySelector('#album');
                const missing = !(trackEl && trackEl.textContent && trackEl.textContent.trim())
                    || !(artistEl && artistEl.textContent && artistEl.textContent.trim())
                    || !(albumEl && albumEl.textContent && albumEl.textContent.trim());
                if (missing && this._hass && this._hass.callApi) {
                    this._hass.callApi('GET', 'apple_music/now_playing').then((np) => {
                        var _a;
                        try {
                            if (!np || typeof np !== 'object')
                                return;
                            if (np.title && trackEl)
                                trackEl.textContent = np.title;
                            if (np.artist && artistEl)
                                artistEl.textContent = np.artist;
                            if (np.album && albumEl)
                                albumEl.textContent = np.album;
                            // If token present, set artwork
                            const tok = (np.artwork_token || np.token || '');
                            if (tok) {
                                try {
                                    this._setArtwork(tok);
                                }
                                catch (_) { }
                            }
                            (_a = this._applyNowPlayingMarquee) === null || _a === void 0 ? void 0 : _a.call(this);
                        }
                        catch (_) { }
                    }).catch(() => { });
                }
            }
            catch (_) { }
            // Devices/outputs from last poll
            (_c = this._renderDevices) === null || _c === void 0 ? void 0 : _c.call(this);
            // Now playing from HA state and/or cached /status
            (_d = this._updateFromHass) === null || _d === void 0 ? void 0 : _d.call(this);
            (_e = this._updateNowPlayingAux) === null || _e === void 0 ? void 0 : _e.call(this);
            // Keep layout consistent
            (_f = this._applyLayout) === null || _f === void 0 ? void 0 : _f.call(this);
        }
        catch (_) { /* ignore */ }
    }
    set hass(hass) {
        var _a, _b, _c;
        this._hass = hass;
        if (!this._ready) {
            this._ready = true;
            this._renderSkeleton();
            this._wireStaticHandlers();
            // Apply saved layout immediately to avoid flash of defaults
            try {
                (_a = this._applyLayout) === null || _a === void 0 ? void 0 : _a.call(this);
            }
            catch (_d) { }
            this._startPolling();
            // Connect SSE early so live updates apply without waiting for user interaction
            try {
                (_b = this._connectSSE) === null || _b === void 0 ? void 0 : _b.call(this);
            }
            catch (_) { }
            // Prime state immediately
            try {
                this._poll(true);
            }
            catch (_) { }
        }
        (_c = this._updateFromHass) === null || _c === void 0 ? void 0 : _c.call(this);
    }
    disconnectedCallback() {
        if (this._pollHandle) {
            clearInterval(this._pollHandle);
            this._pollHandle = null;
        }
        for (const t of this._debouncers.values())
            clearTimeout(t);
        this._debouncers.clear();
        if (this._storeUnsub) {
            try {
                this._storeUnsub();
            }
            catch (_) { }
            this._storeUnsub = null;
        }
        // Close SSE connection to avoid long-running work during unload
        if (this._es) {
            try {
                this._es.close();
            }
            catch (_) { }
            this._es = null;
        }
        if (this._healthHandle) {
            try {
                clearTimeout(this._healthHandle);
            }
            catch (_) { }
            this._healthHandle = null;
        }
        // Remove wake handlers to avoid leaks
        if (this._wakeHandlersBound) {
            try {
                document.removeEventListener('visibilitychange', this._onVis);
            }
            catch (_) { }
            try {
                window.removeEventListener('pageshow', this._onPageShow);
            }
            catch (_) { }
            try {
                window.removeEventListener('focus', this._onFocus);
            }
            catch (_) { }
            try {
                window.removeEventListener('online', this._onOnline);
            }
            catch (_) { }
            this._wakeHandlersBound = false;
        }
    }
    // ====== Render ======
    _renderSkeleton() {
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
        try {
            this.querySelectorAll('a.link').forEach(a => a.remove());
        }
        catch (_) { }
    }
    _wireStaticHandlers() {
        var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y;
        // Add the event handlers from the original JS
        // Now Playing controls
        (_a = this.querySelector('#prev')) === null || _a === void 0 ? void 0 : _a.addEventListener('click', () => this._mpService('media_previous_track'));
        (_b = this.querySelector('#playpause')) === null || _b === void 0 ? void 0 : _b.addEventListener('click', () => this._mpService('media_play_pause'));
        (_c = this.querySelector('#shuffle')) === null || _c === void 0 ? void 0 : _c.addEventListener('click', () => this._toggleShuffle());
        (_d = this.querySelector('#next')) === null || _d === void 0 ? void 0 : _d.addEventListener('click', () => this._mpService('media_next_track'));
        (_e = this.querySelector('#mvDown')) === null || _e === void 0 ? void 0 : _e.addEventListener('click', () => this._bumpVol(-0.05));
        (_f = this.querySelector('#mvUp')) === null || _f === void 0 ? void 0 : _f.addEventListener('click', () => this._bumpVol(0.05));
        const masterVolEl = this.querySelector('#masterVol');
        if (masterVolEl) {
            masterVolEl.addEventListener('input', (e) => this._setVol(Number(e.target.value)));
            masterVolEl.addEventListener('mousedown', () => { this._masterVolDragging = true; });
            masterVolEl.addEventListener('mouseup', () => { this._masterVolDragging = false; });
            masterVolEl.addEventListener('mouseleave', () => { this._masterVolDragging = false; });
        }
        (_g = this.querySelector('#openBrowse')) === null || _g === void 0 ? void 0 : _g.addEventListener('click', () => this._showBrowse());
        // AirPlay Outputs
        (_h = this.querySelector('#refreshOutputs')) === null || _h === void 0 ? void 0 : _h.addEventListener('click', () => this._poll(true));
        (_j = this.querySelector('#toggleDisabled')) === null || _j === void 0 ? void 0 : _j.addEventListener('click', () => {
            var _a;
            this._showDisabled = !this._showDisabled;
            const btn = this.querySelector('#toggleDisabled');
            if (btn)
                btn.textContent = this._showDisabled ? 'Hide Disabled' : 'Show Disabled';
            (_a = this._renderDevices) === null || _a === void 0 ? void 0 : _a.call(this);
        });
        // Browse controls
        (_k = this.querySelector('#browsePlaylists')) === null || _k === void 0 ? void 0 : _k.addEventListener('click', () => this._setBrowseSection('playlists'));
        (_l = this.querySelector('#browseAlbums')) === null || _l === void 0 ? void 0 : _l.addEventListener('click', () => this._setBrowseSection('albums'));
        (_m = this.querySelector('#browseArtists')) === null || _m === void 0 ? void 0 : _m.addEventListener('click', () => this._setBrowseSection('artists'));
        (_o = this.querySelector('#browseSearch')) === null || _o === void 0 ? void 0 : _o.addEventListener('input', (e) => this._setBrowseSearch(e.target.value));
        (_p = this.querySelector('#browsePrev')) === null || _p === void 0 ? void 0 : _p.addEventListener('click', () => this._browsePrev());
        (_q = this.querySelector('#browseNext')) === null || _q === void 0 ? void 0 : _q.addEventListener('click', () => this._browseNext());
        // Letter buttons
        this.querySelectorAll('.letterbtn').forEach(btn => {
            btn.addEventListener('click', (e) => this._setBrowseAlpha(e.target.dataset.letter || ''));
        });
        // Settings menu
        (_r = this.querySelector('#settingsBtn')) === null || _r === void 0 ? void 0 : _r.addEventListener('click', () => this._toggleSettingsMenu());
        (_s = this.querySelector('#menuCustomize')) === null || _s === void 0 ? void 0 : _s.addEventListener('click', () => this._showLayoutBar());
        (_t = this.querySelector('#menuReset')) === null || _t === void 0 ? void 0 : _t.addEventListener('click', () => this._resetLayout());
        // Sidebar toggle (HA drawer)
        (_u = this.querySelector('#menu')) === null || _u === void 0 ? void 0 : _u.addEventListener('click', () => {
            try {
                // Dispatch from this component so the event bubbles up through HA's DOM
                this.dispatchEvent(new CustomEvent('hass-toggle-menu', { bubbles: true, composed: true }));
            }
            catch (_) { }
        });
        // Settings submenus: About and Services
        const toggleSubmenu = (btnSel, menuSel, otherSel) => {
            const btn = this.querySelector(btnSel);
            const menu = this.querySelector(menuSel);
            const other = otherSel ? this.querySelector(otherSel) : null;
            if (btn && menu) {
                btn.addEventListener('click', (e) => {
                    var _a;
                    e.stopPropagation();
                    if (other)
                        other.style.display = 'none';
                    const show = menu.style.display !== 'block';
                    menu.style.display = show ? 'block' : 'none';
                    // Populate About submenu on open
                    if (show && menuSel === '#aboutMenu') {
                        try {
                            (_a = this._populateAboutMenu) === null || _a === void 0 ? void 0 : _a.call(this);
                        }
                        catch (_) { }
                    }
                });
            }
        };
        toggleSubmenu('#menuAbout', '#aboutMenu', '#servicesMenu');
        toggleSubmenu('#menuServices', '#servicesMenu', '#aboutMenu');
        // Close submenus when clicking outside settings
        document.addEventListener('click', (ev) => {
            try {
                const settings = this.querySelector('#settingsMenu');
                if (!settings)
                    return;
                const t = ev.target;
                if (settings && !settings.contains(t)) {
                    const aboutMenu = this.querySelector('#aboutMenu');
                    const servicesMenu = this.querySelector('#servicesMenu');
                    if (aboutMenu)
                        aboutMenu.style.display = 'none';
                    if (servicesMenu)
                        servicesMenu.style.display = 'none';
                }
            }
            catch (_) { }
        });
        // Settings actions
        (_v = this.querySelector('#menuRestart')) === null || _v === void 0 ? void 0 : _v.addEventListener('click', () => {
            var _a;
            try {
                // Call macOS server restart via HA proxy
                (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/restart').catch(() => { });
                // Hide menu
                const menu = this.querySelector('#settingsMenu');
                if (menu)
                    menu.style.display = 'none';
            }
            catch (_) { }
        });
        (_w = this.querySelector('#menuPurgeAlbumServer')) === null || _w === void 0 ? void 0 : _w.addEventListener('click', () => {
            var _a;
            try {
                // Prefer HA service which proxies to backend purge
                (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callService('apple_music', 'purge_album_cache', {});
            }
            catch (_) { }
        });
        (_x = this.querySelector('#menuPurgeAlbumHA')) === null || _x === void 0 ? void 0 : _x.addEventListener('click', () => {
            var _a;
            try {
                (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callService('apple_music', 'purge_ha_album_cache', {});
            }
            catch (_) { }
        });
        (_y = this.querySelector('#menuRefreshArtwork')) === null || _y === void 0 ? void 0 : _y.addEventListener('click', () => {
            var _a;
            try {
                (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callService('apple_music', 'refresh_current_artwork', {});
            }
            catch (_) { }
        });
    }
    // Add all other methods from the original class, converted to TS
    _entityId() {
        var _a;
        const s = ((_a = this._hass) === null || _a === void 0 ? void 0 : _a.states) || {};
        return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
    }
    _mpEntity() {
        var _a, _b;
        const id = this._entityId();
        return (_b = (_a = this._hass) === null || _a === void 0 ? void 0 : _a.states) === null || _b === void 0 ? void 0 : _b[id];
    }
    _mpService(service, data = {}) {
        if (!this._hass)
            return;
        this._hass.callService('media_player', service, Object.assign({ entity_id: this._entityId() }, data));
    }
    _updateFromHass() {
        var _a, _b, _c, _d, _e, _f, _g;
        const mp = this._mpEntity();
        const art = this.querySelector('#art');
        const track = this.querySelector('#track');
        const artist = this.querySelector('#artist');
        const album = this.querySelector('#album');
        const masterVol = this.querySelector('#masterVol');
        if (!mp)
            return;
        const attrs = mp.attributes || {};
        const nextTitle = attrs.media_title || ((track === null || track === void 0 ? void 0 : track.textContent) || '—');
        const nextArtist = attrs.media_artist || ((artist === null || artist === void 0 ? void 0 : artist.textContent) || '—');
        const nextAlbum = attrs.media_album_name || ((album === null || album === void 0 ? void 0 : album.textContent) || '—');
        const prevKey = this._lastNPKey || '';
        const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
        this._lastNPKey = nextKey;
        if (track)
            track.textContent = nextTitle;
        if (artist)
            artist.textContent = nextArtist;
        if (album)
            album.textContent = nextAlbum;
        if (typeof attrs.volume_level === 'number' && Date.now() >= this._masterHoldUntil) {
            if (masterVol)
                masterVol.value = String(attrs.volume_level);
        }
        const tok = (_a = this._status) === null || _a === void 0 ? void 0 : _a.artwork_token;
        if (tok) {
            try {
                (_b = this._setArtwork) === null || _b === void 0 ? void 0 : _b.call(this, tok);
            }
            catch (_) { }
        }
        else {
            if (nextKey !== prevKey) {
                try {
                    (_c = this._refreshCurrentArtworkNoToken) === null || _c === void 0 ? void 0 : _c.call(this);
                }
                catch (_) { }
            }
            const imgEl = this.querySelector('#art');
            const hasBlob = !!((_d = imgEl === null || imgEl === void 0 ? void 0 : imgEl.dataset) === null || _d === void 0 ? void 0 : _d.blobUrl);
            if (!hasBlob) {
                // Use direct artwork API instead of entity_picture to avoid media player proxy
                try {
                    (_e = this._refreshCurrentArtworkNoToken) === null || _e === void 0 ? void 0 : _e.call(this);
                }
                catch (_) { }
            }
        }
        (_f = this._applyNowPlayingMarquee) === null || _f === void 0 ? void 0 : _f.call(this);
        (_g = this._updatePlayPauseVisual) === null || _g === void 0 ? void 0 : _g.call(this);
    }
    _startPolling() {
        if (this._pollHandle)
            clearInterval(this._pollHandle);
        this._pollHandle = setInterval(() => {
            var _a;
            try {
                (_a = this._poll) === null || _a === void 0 ? void 0 : _a.call(this);
            }
            catch (_) { }
        }, 5000);
    }
    _poll(force = false) {
        if (!this._hass)
            return;
        const calls = [];
        // Always try to keep shuffle/state fresh
        calls.push(this._hass.callApi('GET', 'apple_music/status').then((st) => {
            var _a, _b;
            this._status = st || {};
            (_a = this._updateShuffleButtonVisual) === null || _a === void 0 ? void 0 : _a.call(this);
            (_b = this._updateFromHass) === null || _b === void 0 ? void 0 : _b.call(this);
            try {
                if (typeof (st === null || st === void 0 ? void 0 : st.master) === 'number')
                    this._updateVolumeFromSSE(st.master);
            }
            catch (_) { }
        }).catch(() => { }));
        // If forcing or SSE isn't healthy, fetch AirPlay snapshot
        if (force || !this._sseHealthy || !this._preferWS) {
            calls.push(this._hass.callApi('GET', 'apple_music/airplay_full').then((list) => {
                if (Array.isArray(list))
                    this._updateDevicesFromSSE(list);
            }).catch(() => { }));
        }
        // No need to wait; fire-and-forget
        Promise.all(calls).catch(() => { });
    }
    _toggleShuffle() {
        var _a;
        if (!this._hass)
            return;
        const currentShuffle = !!((_a = this._status) === null || _a === void 0 ? void 0 : _a.shuffle);
        const newShuffle = !currentShuffle;
        this._hass.callApi('POST', 'apple_music/shuffle', { enabled: newShuffle })
            .then((_response) => {
            var _a;
            this._status = Object.assign(Object.assign({}, (this._status || {})), { shuffle: newShuffle });
            (_a = this._updateShuffleButtonVisual) === null || _a === void 0 ? void 0 : _a.call(this);
        })
            .catch((error) => {
            console.warn('Failed to toggle shuffle:', error);
        });
    }
    _bumpVol(delta) {
        if (!this._hass)
            return;
        const masterVol = this.querySelector('#masterVol');
        if (!masterVol)
            return;
        const currentVol = parseFloat(masterVol.value) || 0;
        const newVol = Math.max(0, Math.min(1, currentVol + delta));
        const key = 'master_vol';
        if (this._debouncers.has(key)) {
            clearTimeout(this._debouncers.get(key));
        }
        this._debouncers.set(key, setTimeout(() => {
            var _a;
            (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/master_volume', {
                level: Math.round(newVol * 100)
            }).catch((error) => {
                console.warn('Failed to set master volume:', error);
            });
        }, 150));
        masterVol.value = String(newVol);
        this._masterHoldUntil = Date.now() + 1000;
    }
    _setVol(level) {
        if (!this._hass)
            return;
        const clampedLevel = Math.max(0, Math.min(1, level));
        const key = 'master_vol';
        if (this._debouncers.has(key)) {
            clearTimeout(this._debouncers.get(key));
        }
        this._debouncers.set(key, setTimeout(() => {
            var _a;
            (_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('POST', 'apple_music/master_volume', {
                level: Math.round(clampedLevel * 100)
            }).catch((error) => {
                console.warn('Failed to set master volume:', error);
            });
        }, 150));
        this._masterHoldUntil = Date.now() + 1000;
    }
    _showBrowse() {
        const browseCard = this.querySelector('#browse');
        if (browseCard) {
            browseCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }
    _setBrowseSection(section) {
        if (this._browseSection === section)
            return;
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
    _setBrowseSearch(query) {
        this._browseAlpha = '';
        this._browsePage = 0;
        this._browseReqToken++;
        if (query.trim()) {
            this._searchBrowseData(query.trim());
        }
        else {
            this._loadBrowseData();
        }
    }
    _browsePrev() {
        var _a;
        if (this._browsePage > 0) {
            this._browsePage--;
            // For drill-down views (tracks/albums), page locally without hitting HA HTTP endpoints
            const sec = this._browseSection;
            if (sec === 'album_tracks' || sec === 'playlist_tracks' || sec === 'artist_albums') {
                this._renderBrowseList(Array.isArray((_a = this._browseData) === null || _a === void 0 ? void 0 : _a.data) ? this._browseData.data : []);
            }
            else {
                this._loadBrowseData();
            }
        }
    }
    _browseNext() {
        var _a;
        this._browsePage++;
        // For drill-down views (tracks/albums), page locally without hitting HA HTTP endpoints
        const sec = this._browseSection;
        if (sec === 'album_tracks' || sec === 'playlist_tracks' || sec === 'artist_albums') {
            this._renderBrowseList(Array.isArray((_a = this._browseData) === null || _a === void 0 ? void 0 : _a.data) ? this._browseData.data : []);
        }
        else {
            this._loadBrowseData();
        }
    }
    _setBrowseAlpha(alpha) {
        var _a;
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
        }
        else {
            this._renderBrowseList(Array.isArray((_a = this._browseData) === null || _a === void 0 ? void 0 : _a.data) ? this._browseData.data : []);
        }
    }
    _loadBrowseData() {
        if (!this._hass)
            return;
        const token = ++this._browseReqToken;
        const section = this._browseSection;
        const page = this._browsePage;
        const alpha = this._browseAlpha;
        const endpoint = `/${section}`;
        // Fetch full list (client-side pagination) so we can compute total pages reliably
        const params = {};
        if (alpha)
            params.starts_with = alpha;
        try {
            const qs = new URLSearchParams(params).toString();
            this._hass.callApi('GET', `apple_music${endpoint}${qs ? `?${qs}` : ''}`)
                .then((data) => {
                if (token !== this._browseReqToken)
                    return;
                if (Array.isArray(data)) {
                    // Cache full list for top-level sections
                    if (section === 'playlists' || section === 'albums' || section === 'artists') {
                        this._browseCache = this._browseCache || { playlists: null, albums: null, artists: null };
                        this._browseCache[section] = data;
                    }
                    this._browseData = { section, data };
                    // Keep current page; render will slice and compute totals
                    this._renderBrowseList(data);
                }
                else {
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
        }
        catch (_error) {
            if (token === this._browseReqToken) {
                this._renderBrowseList([]);
                this._updateBrowsePager(false, 1);
            }
        }
    }
    _searchBrowseData(query) {
        if (!this._hass)
            return;
        const token = ++this._browseReqToken;
        try {
            const typeMap = { playlists: 'playlist', albums: 'album', artists: 'artist' };
            const types = typeMap[this._browseSection] || 'album,artist,playlist';
            const qs = new URLSearchParams({ q: query, types }).toString();
            this._hass.callApi('GET', `apple_music/search?${qs}`)
                .then((data) => {
                if (token !== this._browseReqToken)
                    return;
                const results = (data === null || data === void 0 ? void 0 : data[this._browseSection]) || [];
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
        }
        catch (error) {
            console.warn('Search failed:', error);
            if (token === this._browseReqToken) {
                this._renderBrowseList([]);
                this._updateBrowsePager(false);
            }
        }
    }
    _renderBrowseList(items) {
        var _a;
        const listEl = this.querySelector('#browseList');
        if (!listEl)
            return;
        // Normalize names for filtering and rendering
        const nameOf = (it) => typeof it === 'string' ? it : ((it === null || it === void 0 ? void 0 : it.title) || (it === null || it === void 0 ? void 0 : it.name) || (it === null || it === void 0 ? void 0 : it.id) || 'Unknown');
        // Basic escape for innerHTML usage
        const esc = (s) => String(s).replace(/&/g, '&').replace(/"/g, '"').replace(/</g, '<');
        // Build available-letters set based on full unfiltered list (respecting search results when applicable)
        const all = Array.isArray(items) ? items.slice() : [];
        const letters = new Set();
        for (const it of all) {
            const nm = String(nameOf(it) || '').trim();
            if (!nm)
                continue;
            const stripped = nm.replace(/^[^A-Za-z0-9]+/, '');
            const ch = (stripped[0] || '').toUpperCase();
            if (/[A-Z]/.test(ch))
                letters.add(ch);
            else
                letters.add('#');
        }
        // Show only letters that have matches; hide others
        try {
            this.querySelectorAll('.letterbtn').forEach((btn) => {
                const l = btn.dataset.letter || '';
                const has = letters.has(l);
                btn.style.display = has ? '' : 'none';
                // If current alpha is now hidden, clear it
                if (!has && this._browseAlpha === l) {
                    this._browseAlpha = '';
                    btn.classList.remove('active');
                }
            });
        }
        catch (_) { }
        // Apply client-side alpha filter when server doesn't support it
        const alpha = (this._browseAlpha || '').toUpperCase();
        let base = Array.isArray(items) ? items.slice() : [];
        if (alpha) {
            base = base.filter((it) => {
                const nm = String(nameOf(it) || '').trim();
                if (!nm)
                    return false;
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
        if (((_a = this._browseData) === null || _a === void 0 ? void 0 : _a.section) === 'artist_albums') {
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
            const idVal = typeof it === 'string' ? it : ((it === null || it === void 0 ? void 0 : it.id) || nm);
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
                    var _a, _b, _c, _d, _e, _f, _g;
                    const row = ev.currentTarget;
                    // Handle back navigation
                    if (row.hasAttribute('data-back')) {
                        try {
                            (_a = this._browseBack) === null || _a === void 0 ? void 0 : _a.call(this);
                        }
                        catch (_) { }
                        return;
                    }
                    // Skip play-all header
                    if (row.hasAttribute('data-play-all-header'))
                        return;
                    const id = (row === null || row === void 0 ? void 0 : row.getAttribute('data-id')) || '';
                    if (!id)
                        return;
                    // Drill into contents based on current section
                    const sec = String(((((_b = this._browseData) === null || _b === void 0 ? void 0 : _b.section) === 'search') ? this._browseSection : (_c = this._browseData) === null || _c === void 0 ? void 0 : _c.section) || this._browseSection || '').toLowerCase();
                    try {
                        if (sec === 'playlists')
                            (_d = this._browseInto) === null || _d === void 0 ? void 0 : _d.call(this, 'playlist', id);
                        else if (sec === 'albums')
                            (_e = this._browseInto) === null || _e === void 0 ? void 0 : _e.call(this, 'album', id);
                        else if (sec === 'artists')
                            (_f = this._browseInto) === null || _f === void 0 ? void 0 : _f.call(this, 'artist', id);
                        else if (sec === 'artist_albums')
                            (_g = this._browseInto) === null || _g === void 0 ? void 0 : _g.call(this, 'album', id);
                        // For tracks (album_tracks/playlist_tracks), no further drill-down
                    }
                    catch (_) { /* ignore */ }
                });
            });
            // Wire Play/Shuffle action buttons
            listEl.querySelectorAll('button[data-play]').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const id = ev.currentTarget.getAttribute('data-play') || '';
                    const name = ev.currentTarget.getAttribute('data-name') || '';
                    const type = ev.currentTarget.getAttribute('data-type') || 'album';
                    if (id || name)
                        this._playBrowseItem(id || name, false, type);
                });
            });
            listEl.querySelectorAll('button[data-shuffle]').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const id = ev.currentTarget.getAttribute('data-shuffle') || '';
                    const name = ev.currentTarget.getAttribute('data-name') || '';
                    const type = ev.currentTarget.getAttribute('data-type') || 'album';
                    if (id || name)
                        this._playBrowseItem(id || name, true, type);
                });
            });
            // Wire Play All/Shuffle All for artists
            listEl.querySelectorAll('button[data-play-all]').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const artistId = ev.currentTarget.getAttribute('data-play-all') || '';
                    if (artistId)
                        this._playAllArtist(artistId, false);
                });
            });
            listEl.querySelectorAll('button[data-shuffle-all]').forEach((btn) => {
                btn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    const artistId = ev.currentTarget.getAttribute('data-shuffle-all') || '';
                    if (artistId)
                        this._playAllArtist(artistId, true);
                });
            });
        }
        catch (_) { }
    }
    _playBrowseItem(name, shuffle, type) {
        if (!this._hass)
            return;
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
        if (section === 'artist_albums')
            contentType = 'album';
        else
            contentType = section.slice(0, -1); // Remove 's' from plural
        // Extract clean name from ID if needed
        let cleanName = name;
        if (name.startsWith(`${contentType}:`)) {
            try {
                cleanName = decodeURIComponent(name.slice(contentType.length + 1));
            }
            catch (_a) {
                cleanName = name.slice(contentType.length + 1);
            }
        }
        // Build the correct media content ID based on type and shuffle
        let mediaContentId = '';
        if (shuffle) {
            if (contentType === 'playlist') {
                mediaContentId = `shuffle_playlist:${cleanName}`;
            }
            else if (contentType === 'album') {
                mediaContentId = `shuffle_album:${cleanName}`;
            }
            else if (contentType === 'artist') {
                // For artist shuffle, use the special queue_artist_shuffled API
                try {
                    this._hass.callApi('POST', 'apple_music/queue_artist_shuffled', { artist: cleanName });
                    return;
                }
                catch (error) {
                    console.warn('Failed to shuffle artist:', error);
                    return;
                }
            }
        }
        else {
            if (contentType === 'playlist') {
                mediaContentId = `play_playlist:${cleanName}`;
            }
            else if (contentType === 'album') {
                mediaContentId = `play_album:${cleanName}`;
            }
            else if (contentType === 'artist') {
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
    _playAllArtist(artistId, shuffle) {
        if (!this._hass)
            return;
        // Extract artist name from ID if it's prefixed
        let artistName = artistId;
        if (artistId.startsWith('artist:')) {
            try {
                artistName = decodeURIComponent(artistId.slice(7));
            }
            catch (_a) {
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
        }
        else {
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
    _updateBrowsePager(hasMore, totalPages) {
        try {
            const pager = this.querySelector('.pager');
            const letters = this.querySelector('.letters');
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
                const prevBtn = this.querySelector('#browsePrev');
                const nextBtn = this.querySelector('#browseNext');
                const infoEl = this.querySelector('.pager .info');
                const pageNum = this._browsePage + 1;
                if (prevBtn)
                    prevBtn.disabled = this._browsePage === 0;
                if (nextBtn)
                    nextBtn.disabled = !hasMore;
                if (infoEl) {
                    if (typeof totalPages === 'number' && totalPages > 0) {
                        infoEl.textContent = hasMore ? `Page ${pageNum} of ${totalPages}` : `Page ${pageNum} of ${totalPages} (last)`;
                    }
                    else {
                        infoEl.textContent = hasMore ? `Page ${pageNum}` : `Page ${pageNum} (last)`;
                    }
                }
            }
        }
        catch (_) { /* ignore */ }
    }
    _toggleSettingsMenu() {
        const menu = this.querySelector('#settingsMenu');
        if (!menu)
            return;
        const isVisible = menu.style.display !== 'none';
        menu.style.display = isVisible ? 'none' : 'block';
        // Close submenu when main menu closes
        if (isVisible) {
            const aboutMenu = this.querySelector('#aboutMenu');
            const servicesMenu = this.querySelector('#servicesMenu');
            if (aboutMenu)
                aboutMenu.style.display = 'none';
            if (servicesMenu)
                servicesMenu.style.display = 'none';
        }
    }
    _showLayoutBar() {
        const layoutBar = this.querySelector('#layoutBar');
        const settingsMenu = this.querySelector('#settingsMenu');
        if (layoutBar) {
            layoutBar.style.display = 'block';
        }
        if (settingsMenu) {
            settingsMenu.style.display = 'none';
        }
        // Add event listeners for layout controls
        this._setupLayoutHandlers();
    }
    _resetLayout() {
        // Reset to default layout and order
        const sections = this.querySelector('#sections');
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
                const el = this.querySelector(`#${id}`);
                if (el)
                    sections.appendChild(el);
            });
        }
        // Reset layout bar control
        const linkSizes = this.querySelector('#linkSizes');
        if (linkSizes)
            linkSizes.checked = false;
        // Close settings and layout bar
        const settingsMenu = this.querySelector('#settingsMenu');
        if (settingsMenu)
            settingsMenu.style.display = 'none';
        this._hideLayoutBar();
    }
    _setupLayoutHandlers() {
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
                const target = e.target;
                const key = target.dataset.key;
                const action = target.dataset.act;
                if (key && action) {
                    this._handleLayoutAction(key, action);
                }
            });
        });
    }
    _handleLayoutAction(key, action) {
        const card = this.querySelector(`#${key}`);
        if (!card)
            return;
        if (action === 'up' || action === 'down') {
            // Move card up/down in order
            const sections = this.querySelector('#sections');
            if (!sections)
                return;
            const cards = Array.from(sections.children);
            const currentIndex = cards.indexOf(card);
            if (action === 'up' && currentIndex > 0) {
                sections.insertBefore(card, cards[currentIndex - 1]);
            }
            else if (action === 'down' && currentIndex < cards.length - 1) {
                sections.insertBefore(cards[currentIndex + 1], card);
            }
        }
    }
    _saveLayout() {
        // Save current layout preferences
        const layout = {
            order: [],
            sizes: {},
            link_sizes: false
        };
        const sections = this.querySelector('#sections');
        const linkSizes = this.querySelector('#linkSizes');
        if (sections) {
            const cards = sections.querySelectorAll('ha-card');
            cards.forEach(card => {
                var _a;
                const id = card.id;
                if (id) {
                    (_a = layout.order) === null || _a === void 0 ? void 0 : _a.push(id);
                    if (card.classList.contains('size-s')) {
                        layout.sizes[id] = 's';
                    }
                    else if (card.classList.contains('size-m')) {
                        layout.sizes[id] = 'm';
                    }
                    else {
                        layout.sizes[id] = 'l';
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
    _hideLayoutBar() {
        const layoutBar = this.querySelector('#layoutBar');
        if (layoutBar) {
            layoutBar.style.display = 'none';
        }
    }
    _applyLayout() {
        if (!this._layout)
            return;
        const sections = this.querySelector('#sections');
        if (!sections)
            return;
        // Apply saved sizes
        if (this._layout.sizes) {
            Object.entries(this._layout.sizes).forEach(([cardId, size]) => {
                const card = this.querySelector(`#${cardId}`);
                if (card) {
                    card.classList.remove('size-s', 'size-m', 'size-l');
                    card.classList.add(`size-${size}`);
                }
            });
        }
        // Apply linked sizes
        if (this._layout.link_sizes) {
            const linkSizes = this.querySelector('#linkSizes');
            if (linkSizes)
                linkSizes.checked = true;
        }
    }
    // Fetch and populate About submenu versions
    async _populateAboutMenu() {
        var _a;
        try {
            const panelEl = this.querySelector('#aboutPanelVer');
            const jsEl = this.querySelector('#aboutJsVer');
            // If DOM not present, nothing to do
            if (!panelEl && !jsEl)
                return;
            const info = await ((_a = this._hass) === null || _a === void 0 ? void 0 : _a.callApi('GET', 'apple_music/panel_info').catch(() => null));
            const panelVer = info && typeof info.panel_version === 'string' ? info.panel_version : 'unknown';
            const assetVer = info && typeof info.asset_version === 'string' ? info.asset_version : 'unknown';
            if (panelEl)
                panelEl.textContent = panelVer;
            if (jsEl)
                jsEl.textContent = assetVer;
        }
        catch (_) { /* ignore */ }
    }
    // Drill-down navigation helpers
    async _wsBrowse(id, overrideType) {
        var _a;
        try {
            const entity_id = this._entityId();
            const type = overrideType || (id.startsWith('album:') ? 'album'
                : id.startsWith('artist:') ? 'artist'
                    : id.startsWith('playlist:') ? 'playlist'
                        : 'library');
            // Pass full id (including prefix) to HA browse API along with explicit type
            return await ((_a = this._hass) === null || _a === void 0 ? void 0 : _a.callWS({ type: 'media_player/browse_media', entity_id, media_content_id: id, media_content_type: type }));
        }
        catch (_) {
            return null;
        }
    }
    _flattenChildren(arr) {
        const out = [];
        const stack = Array.isArray(arr) ? [...arr] : [];
        while (stack.length) {
            const n = stack.shift();
            if (!n)
                continue;
            if (Array.isArray(n.children) && n.children.length)
                stack.push(...n.children);
            else
                out.push(n);
        }
        return out;
    }
    _isTrackNode(c) {
        const cid = String((c === null || c === void 0 ? void 0 : c.media_content_id) || '');
        const mc = String((c === null || c === void 0 ? void 0 : c.media_class) || '').toLowerCase();
        const title = String((c === null || c === void 0 ? void 0 : c.title) || '').toLowerCase();
        if (cid.startsWith('song:'))
            return true;
        if (mc === 'track')
            return true;
        if (mc.includes('music') || mc.includes('audio')) {
            if (cid.startsWith('play_') || cid.startsWith('shuffle_'))
                return false;
            if (title.includes('play album') || title.includes('shuffle'))
                return false;
            return true;
        }
        return false;
    }
    _pushBrowseContext() {
        var _a, _b;
        try {
            const cur = { section: String(((_a = this._browseData) === null || _a === void 0 ? void 0 : _a.section) || this._browseSection || ''), arg: (_b = this._browseData) === null || _b === void 0 ? void 0 : _b.arg };
            if (!this._browseStack)
                this._browseStack = [];
            this._browseStack.push(cur);
        }
        catch (_) { }
    }
    _setBrowseData(section, arg, data) {
        this._browseSection = section;
        this._browsePage = 0;
        this._browseAlpha = '';
        this._browseReqToken++;
        this._browseData = { section, arg, data };
        this._renderBrowseList(data);
    }
    async _browseInto(kind, id) {
        this._pushBrowseContext();
        // Ensure HA gets a prefixed content id when one is not provided
        const prefixedId = id && id.includes(':') ? id : `${kind}:${id}`;
        if (kind === 'artist') {
            let res = await this._wsBrowse(prefixedId, 'artist');
            let children = Array.isArray(res === null || res === void 0 ? void 0 : res.children) ? res.children : (Array.isArray(res === null || res === void 0 ? void 0 : res.items) ? res.items : []);
            let items = this._flattenChildren(children).map((c) => ({ id: c === null || c === void 0 ? void 0 : c.media_content_id, title: c === null || c === void 0 ? void 0 : c.title })).filter((it) => it.id || it.title);
            // Fallback: try unprefixed id if empty
            if (!Array.isArray(items) || items.length === 0) {
                const altId = id && id.includes(':') ? id.split(':', 2)[1] : id;
                res = await this._wsBrowse(altId, 'artist');
                children = Array.isArray(res === null || res === void 0 ? void 0 : res.children) ? res.children : (Array.isArray(res === null || res === void 0 ? void 0 : res.items) ? res.items : []);
                items = this._flattenChildren(children).map((c) => ({ id: c === null || c === void 0 ? void 0 : c.media_content_id, title: c === null || c === void 0 ? void 0 : c.title })).filter((it) => it.id || it.title);
            }
            this._setBrowseData('artist_albums', prefixedId, items);
        }
        else if (kind === 'album') {
            let res = await this._wsBrowse(prefixedId, 'album');
            let children = Array.isArray(res === null || res === void 0 ? void 0 : res.children) ? res.children : (Array.isArray(res === null || res === void 0 ? void 0 : res.items) ? res.items : []);
            let tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c) => ({ id: c === null || c === void 0 ? void 0 : c.media_content_id, title: c === null || c === void 0 ? void 0 : c.title })).filter((it) => it.id || it.title);
            // Fallback: try unprefixed id if empty
            if (!Array.isArray(tracks) || tracks.length === 0) {
                const altId = id && id.includes(':') ? id.split(':', 2)[1] : id;
                res = await this._wsBrowse(altId, 'album');
                children = Array.isArray(res === null || res === void 0 ? void 0 : res.children) ? res.children : (Array.isArray(res === null || res === void 0 ? void 0 : res.items) ? res.items : []);
                tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c) => ({ id: c === null || c === void 0 ? void 0 : c.media_content_id, title: c === null || c === void 0 ? void 0 : c.title })).filter((it) => it.id || it.title);
            }
            this._setBrowseData('album_tracks', prefixedId, tracks);
        }
        else if (kind === 'playlist') {
            let res = await this._wsBrowse(prefixedId, 'playlist');
            let children = Array.isArray(res === null || res === void 0 ? void 0 : res.children) ? res.children : (Array.isArray(res === null || res === void 0 ? void 0 : res.items) ? res.items : []);
            let tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c) => ({ id: c === null || c === void 0 ? void 0 : c.media_content_id, title: c === null || c === void 0 ? void 0 : c.title })).filter((it) => it.id || it.title);
            // Fallback: try unprefixed id if empty
            if (!Array.isArray(tracks) || tracks.length === 0) {
                const altId = id && id.includes(':') ? id.split(':', 2)[1] : id;
                res = await this._wsBrowse(altId, 'playlist');
                children = Array.isArray(res === null || res === void 0 ? void 0 : res.children) ? res.children : (Array.isArray(res === null || res === void 0 ? void 0 : res.items) ? res.items : []);
                tracks = this._flattenChildren(children).filter(this._isTrackNode.bind(this)).map((c) => ({ id: c === null || c === void 0 ? void 0 : c.media_content_id, title: c === null || c === void 0 ? void 0 : c.title })).filter((it) => it.id || it.title);
            }
            this._setBrowseData('playlist_tracks', prefixedId, tracks);
        }
    }
    _browseBack() {
        if (!this._browseStack || !this._browseStack.length)
            return;
        const prev = this._browseStack.pop();
        if (!prev)
            return;
        // If navigating back to a top section, reload from cache/api
        if (prev.section === 'playlists' || prev.section === 'albums' || prev.section === 'artists' || prev.section === 'search') {
            this._browseSection = prev.section;
            this._browsePage = 0;
            this._browseAlpha = '';
            this._browseReqToken++;
            // Use cache if available for top sections
            const cached = this._browseCache && this._browseCache[prev.section];
            if (Array.isArray(cached)) {
                this._browseData = { section: prev.section, data: cached };
                this._renderBrowseList(cached);
            }
            else {
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
        }
        else if (prev.section === 'album_tracks') {
            this._browseSection = 'albums';
            this._loadBrowseData();
        }
        else if (prev.section === 'playlist_tracks') {
            this._browseSection = 'playlists';
            this._loadBrowseData();
        }
        else {
            this._browseSection = prev.section;
            this._loadBrowseData();
        }
    }
}
// Global throttling for artwork API calls (shared with now-playing card)
MusicControllerPanel._lastArtworkFetch = 0;
MusicControllerPanel.ARTWORK_THROTTLE_MS = 500;
// Define the custom element once, if not already registered
if (!customElements.get('music-controller-panel')) {
    customElements.define('music-controller-panel', MusicControllerPanel);
}
