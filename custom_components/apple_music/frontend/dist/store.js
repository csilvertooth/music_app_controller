// store.ts
import { API_BASE } from './constants';
(() => {
    const g = (typeof window !== 'undefined' ? window : globalThis);
    if (g.__appleMusicStore)
        return; // singleton
    const listeners = new Set();
    const notify = (event, data) => {
        for (const fn of Array.from(listeners)) {
            try {
                fn({ event, data });
            }
            catch (_a) { }
        }
    };
    const setLS = (k, v) => { try {
        localStorage.setItem(k, JSON.stringify(v));
    }
    catch (_a) { } };
    const getLS = (k, dflt) => { try {
        const v = localStorage.getItem(k);
        return v ? JSON.parse(v) : dflt;
    }
    catch (_a) {
        return dflt;
    } };
    const state = {
        devices: getLS('apple_music_store_devices', []),
        current: new Set(getLS('apple_music_store_current', [])),
        vols: getLS('apple_music_store_vols', {}),
        now: getLS('apple_music_store_now', { title: '', artist: '', album: '', artwork_token: '' }),
        shuffle: getLS('apple_music_store_shuffle', false),
        master: getLS('apple_music_store_master', null),
        sseHealthy: false,
        playerState: getLS('apple_music_store_state', ''),
        nowTs: getLS('apple_music_store_now_ts', 0),
    };
    const persist = () => {
        setLS('apple_music_store_devices', state.devices);
        setLS('apple_music_store_current', Array.from(state.current));
        setLS('apple_music_store_vols', state.vols);
        setLS('apple_music_store_now', state.now);
        setLS('apple_music_store_shuffle', !!state.shuffle);
        setLS('apple_music_store_master', state.master);
        setLS('apple_music_store_state', state.playerState || '');
        setLS('apple_music_store_now_ts', state.nowTs || 0);
    };
    let es = null;
    let backoff = 1000; // ms
    let pollFast = null;
    let pollSlow = null;
    const applyEvent = (event, data) => {
        var _a, _b;
        try {
            if (event === 'snapshot') {
                const now = (data === null || data === void 0 ? void 0 : data.now) || {};
                state.now = {
                    title: now.title || state.now.title || '',
                    artist: now.artist || state.now.artist || '',
                    album: now.album || state.now.album || '',
                    artwork_token: (data === null || data === void 0 ? void 0 : data.artwork_token) || now.artwork_token || state.now.artwork_token || '',
                };
                if (typeof now.state === 'string' && now.state)
                    state.playerState = String(now.state).toLowerCase();
                state.nowTs = Date.now();
                if (typeof (data === null || data === void 0 ? void 0 : data.master) === 'number')
                    state.master = data.master;
                const air = Array.isArray(data === null || data === void 0 ? void 0 : data.airplay) ? data.airplay : null;
                if (air) {
                    state.devices = air.map((d) => d === null || d === void 0 ? void 0 : d.name).filter(Boolean);
                    state.current = new Set(air.filter((d) => d === null || d === void 0 ? void 0 : d.active).map((d) => d.name));
                    const nv = {};
                    air.forEach((d) => { if (d && typeof d.volume === 'number')
                        nv[d.name] = Math.max(0, Math.min(1, d.volume / 100)); });
                    state.vols = nv;
                }
                persist();
                notify('snapshot', data);
                return;
            }
            if (event === 'now' || event === 'status' || event === 'now_playing' || event === 'now-playing') {
                state.now = {
                    title: (data === null || data === void 0 ? void 0 : data.title) || state.now.title || '',
                    artist: (data === null || data === void 0 ? void 0 : data.artist) || state.now.artist || '',
                    album: (data === null || data === void 0 ? void 0 : data.album) || state.now.album || '',
                    artwork_token: (data === null || data === void 0 ? void 0 : data.artwork_token) || (data === null || data === void 0 ? void 0 : data.token) || state.now.artwork_token || '',
                };
                if (data && typeof data.state === 'string')
                    state.playerState = String(data.state).toLowerCase();
                state.nowTs = Date.now();
                if (Object.prototype.hasOwnProperty.call(data || {}, 'shuffle'))
                    state.shuffle = !!data.shuffle;
                persist();
                notify('now', data);
                return;
            }
            if (event === 'shuffle') {
                state.shuffle = !!(data === null || data === void 0 ? void 0 : data.enabled);
                persist();
                notify('shuffle', data);
                return;
            }
            if (event === 'master_volume') {
                if (typeof data === 'number')
                    state.master = data;
                persist();
                notify('master_volume', data);
                return;
            }
            if (event === 'airplay_full') {
                const list = Array.isArray(data) ? data : [];
                state.devices = list.map((d) => d === null || d === void 0 ? void 0 : d.name).filter(Boolean);
                state.current = new Set(list.filter((d) => d === null || d === void 0 ? void 0 : d.active).map((d) => d.name));
                const nv = {};
                list.forEach((d) => { if (d && typeof d.volume === 'number')
                    nv[d.name] = Math.max(0, Math.min(1, d.volume / 100)); });
                state.vols = nv;
                persist();
                notify('airplay_full', data);
                return;
            }
            if (event === 'current_devices' || event === 'selected_devices') {
                let arr = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
                const names = arr.map((d) => (typeof d === 'string') ? d : ((d === null || d === void 0 ? void 0 : d.name) || (d === null || d === void 0 ? void 0 : d.device))).filter(Boolean);
                state.current = new Set(names);
                persist();
                notify(event, data);
                return;
            }
            if (event === 'device_volumes' || event === 'devices_volume' || event === 'per_device_volume') {
                const norm = {};
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    for (const [k, v] of Object.entries(data)) {
                        let val = Number(v);
                        if (!isFinite(val))
                            continue;
                        if (val > 1.5)
                            val = val / 100;
                        if (val < 0)
                            val = 0;
                        if (val > 1)
                            val = 1;
                        norm[k] = val;
                    }
                }
                else if (Array.isArray(data)) {
                    for (const it of data) {
                        const name = (it === null || it === void 0 ? void 0 : it.name) || (it === null || it === void 0 ? void 0 : it.device);
                        let val = Number((_b = (_a = it === null || it === void 0 ? void 0 : it.volume) !== null && _a !== void 0 ? _a : it === null || it === void 0 ? void 0 : it.level) !== null && _b !== void 0 ? _b : NaN);
                        if (!name || !isFinite(val))
                            continue;
                        if (val > 1.5)
                            val = val / 100;
                        if (val < 0)
                            val = 0;
                        if (val > 1)
                            val = 1;
                        norm[name] = val;
                    }
                }
                if (Object.keys(norm).length) {
                    state.vols = Object.assign(Object.assign({}, state.vols), norm);
                    persist();
                    notify('device_volumes', norm);
                }
                return;
            }
            if (event === 'devices' || event === 'airplay_devices') {
                const list = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
                const names = list.map((d) => (typeof d === 'string') ? d : d === null || d === void 0 ? void 0 : d.name).filter(Boolean);
                if (names.length) {
                    state.devices = names;
                    persist();
                    notify(event, names);
                }
                return;
            }
            if (event === 'artwork_saved') {
                notify('artwork_saved', data);
                return;
            }
        }
        catch (_c) { }
    };
    const openSSE = () => {
        if (es) {
            try {
                es.close();
            }
            catch (_a) { }
            es = null;
        }
        const getSigned = async () => {
            var _a, _b;
            try {
                const hass = (_b = (_a = g.hassConnection) === null || _a === void 0 ? void 0 : _a.hass) !== null && _b !== void 0 ? _b : g.hass;
                if (hass && hass.callWS) {
                    const resp = await hass.callWS({ type: 'auth/sign_path', path: API_BASE + 'events', expires: 60 });
                    if (resp && resp.path)
                        return resp.path;
                }
            }
            catch (_c) { }
            return API_BASE + 'events';
        };
        (async () => {
            const path = await getSigned();
            const src = new EventSource(path);
            es = src;
            src.onopen = () => {
                backoff = 1000;
                state.sseHealthy = true;
                if (pollFast) {
                    clearInterval(pollFast);
                    pollFast = null;
                }
                if (!pollSlow)
                    pollSlow = setInterval(() => prefetch(false), 60000);
                prefetch(true);
            };
            src.onmessage = (ev) => {
                try {
                    const msg = JSON.parse(ev.data);
                    applyEvent(msg.event, msg.data);
                    state.sseHealthy = true;
                }
                catch (_a) { }
            };
            src.onerror = () => {
                try {
                    src.close();
                }
                catch (_a) { }
                es = null;
                state.sseHealthy = false;
                if (pollSlow) {
                    clearInterval(pollSlow);
                    pollSlow = null;
                }
                if (!pollFast)
                    pollFast = setInterval(() => prefetch(false), 5000);
                const wait = Math.min(30000, backoff);
                backoff = Math.min(30000, Math.floor(backoff * 1.7));
                setTimeout(openSSE, wait);
            };
        })();
    };
    const prefetch = async (force = false) => {
        var _a, _b;
        try {
            let hass = (_b = (_a = g.hassConnection) === null || _a === void 0 ? void 0 : _a.hass) !== null && _b !== void 0 ? _b : g.hass;
            try {
                if (!hass) {
                    const el = document.querySelector('home-assistant');
                    if (el && el.hass)
                        hass = el.hass;
                }
            }
            catch (_c) { }
            const call = async (m, p, b) => {
                try {
                    if (hass && hass.callApi)
                        return await hass.callApi(m || 'GET', p, b);
                    if (!hass)
                        return null;
                    const up = p.startsWith('/api/') ? p : `/api/${p}`;
                    const opts = { method: m || 'GET', credentials: 'same-origin' };
                    if (b) {
                        opts.body = JSON.stringify(b);
                        opts.headers = { 'Content-Type': 'application/json' };
                    }
                    const r = await fetch(up, opts);
                    if (!r || !r.ok)
                        return null;
                    return await r.json().catch(() => null);
                }
                catch (_a) {
                    return null;
                }
            };
            const [devs, cur, vols, st] = await Promise.all([
                call('GET', 'apple_music/devices'),
                call('GET', 'apple_music/current_devices'),
                call('GET', 'apple_music/device_volumes'),
                call('GET', 'apple_music/status'),
            ]);
            let names = [];
            if (devs) {
                const list = Array.isArray(devs) ? devs : (Array.isArray(devs.devices) ? devs.devices : []);
                names = list.map((d) => (typeof d === 'string') ? d : (d && d.name)).filter(Boolean);
                state.devices = names;
            }
            let currentNames = [];
            if (cur) {
                const arr = Array.isArray(cur) ? cur : (cur.devices || []);
                currentNames = arr.map((d) => (typeof d === 'string') ? d : (d && d.name || d.device)).filter(Boolean);
                state.current = new Set(currentNames);
            }
            let volMap = {};
            if (vols && typeof vols === 'object') {
                const n = {};
                for (const [k, v] of Object.entries(vols)) {
                    let val = Number(v);
                    if (!isFinite(val))
                        continue;
                    if (val > 1.5)
                        val = val / 100;
                    if (val < 0)
                        val = 0;
                    if (val > 1)
                        val = 1;
                    n[k] = val;
                }
                volMap = n;
                state.vols = n;
            }
            if (st) {
                const now = st.now || st;
                state.now = {
                    title: now.title || state.now.title || '',
                    artist: now.artist || state.now.artist || '',
                    album: now.album || state.now.album || '',
                    artwork_token: (now.artwork_token || now.token || state.now.artwork_token || ''),
                };
                if (Object.prototype.hasOwnProperty.call(now, 'shuffle'))
                    state.shuffle = !!now.shuffle;
                try {
                    const stState = (now && typeof now.state === 'string') ? now.state : (now && now.player && typeof now.player.state === 'string' ? now.player.state : '');
                    if (stState)
                        state.playerState = String(stState).toLowerCase();
                }
                catch (_d) { }
                try {
                    state.nowTs = Date.now();
                }
                catch (_e) { }
            }
            persist();
            try {
                const payload = (names.length ? names : state.devices).map((nm) => {
                    var _a, _b;
                    return ({
                        name: nm,
                        active: state.current.has(nm),
                        volume: Math.round((((_b = (_a = volMap[nm]) !== null && _a !== void 0 ? _a : state.vols[nm]) !== null && _b !== void 0 ? _b : 0) * 100)),
                    });
                });
                notify('airplay_full', payload);
            }
            catch (_f) { }
            try {
                notify('devices', state.devices);
            }
            catch (_g) { }
            try {
                notify('current_devices', Array.from(state.current));
            }
            catch (_h) { }
            try {
                notify('device_volumes', state.vols);
            }
            catch (_j) { }
            try {
                notify('now', state.now);
            }
            catch (_k) { }
        }
        catch (_l) { }
    };
    prefetch(true);
    openSSE();
    if (!pollFast)
        pollFast = setInterval(() => prefetch(false), 5000);
    window.__appleMusicStore = {
        subscribe(fn) { if (typeof fn === 'function') {
            listeners.add(fn);
            return () => { try {
                listeners.delete(fn);
            }
            catch (_a) { } };
        } return () => { }; },
        snapshot() { return { devices: state.devices.slice(), current: new Set(state.current), vols: Object.assign({}, state.vols), now: Object.assign({}, state.now), shuffle: !!state.shuffle, master: state.master, sseHealthy: !!state.sseHealthy, playerState: state.playerState || '', nowTs: state.nowTs || 0 }; },
        prefetch,
    };
})();
export const appleMusicStore = window.__appleMusicStore;
