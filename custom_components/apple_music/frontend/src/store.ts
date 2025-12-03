// store.ts
import { API_BASE } from './constants';

declare global {
    interface Window {
        __appleMusicStore?: Store;
        hassConnection?: { hass: Hass };
        hass?: Hass;
    }
}

interface Hass {
    callApi: (method: string, path: string, body?: unknown) => Promise<any>;
    callWS: (msg: { type: string;[key: string]: any }) => Promise<any>;
    // Add more properties as needed
}

interface StoreState {
    devices: string[];
    current: Set<string>;
    vols: { [key: string]: number };
    now: { title: string; artist: string; album: string; artwork_token: string };
    shuffle: boolean;
    master: number | null;
    sseHealthy: boolean;
    playerState: string;
    nowTs: number;
}

interface Store {
    subscribe: (fn: (event: { event: string; data: any }) => void) => () => void;
    snapshot: () => StoreState;
    prefetch: (force?: boolean) => Promise<void>;
}

(() => {
    const g = (typeof window !== 'undefined' ? window : globalThis) as Window & typeof globalThis;
    if (g.__appleMusicStore) return; // singleton

    const listeners = new Set<(event: { event: string; data: any }) => void>();

    const notify = (event: string, data: any) => {
        for (const fn of Array.from(listeners)) {
            try { fn({ event, data }); } catch { }
        }
    };

    const setLS = (k: string, v: any) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } };
    const getLS = <T>(k: string, dflt: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : dflt; } catch { return dflt; } };

    const state: StoreState = {
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

    let es: EventSource | null = null;
    let backoff = 1000; // ms
    let pollFast: number | null = null;
    let pollSlow: number | null = null;

    const applyEvent = (event: string, data: unknown) => {
        try {
            if (event === 'snapshot') {
                const now = (data as any)?.now || {};
                state.now = {
                    title: now.title || state.now.title || '',
                    artist: now.artist || state.now.artist || '',
                    album: now.album || state.now.album || '',
                    artwork_token: (data as any)?.artwork_token || now.artwork_token || state.now.artwork_token || '',
                };
                if (typeof now.state === 'string' && now.state) state.playerState = String(now.state).toLowerCase();
                state.nowTs = Date.now();
                if (typeof (data as any)?.master === 'number') state.master = (data as any).master;
                const air = Array.isArray((data as any)?.airplay) ? (data as any).airplay : null;
                if (air) {
                    state.devices = air.map((d: any) => d?.name).filter(Boolean) as string[];
                    state.current = new Set(air.filter((d: any) => d?.active).map((d: any) => d.name));
                    const nv: { [key: string]: number } = {};
                    air.forEach((d: any) => { if (d && typeof d.volume === 'number') nv[d.name] = Math.max(0, Math.min(1, d.volume / 100)); });
                    state.vols = nv;
                }
                persist();
                notify('snapshot', data);
                return;
            }
            if (event === 'now' || event === 'status' || event === 'now_playing' || event === 'now-playing') {
                state.now = {
                    title: (data as any)?.title || state.now.title || '',
                    artist: (data as any)?.artist || state.now.artist || '',
                    album: (data as any)?.album || state.now.album || '',
                    artwork_token: (data as any)?.artwork_token || (data as any)?.token || state.now.artwork_token || '',
                };
                if ((data as any) && typeof (data as any).state === 'string') state.playerState = String((data as any).state).toLowerCase();
                state.nowTs = Date.now();
                if (Object.prototype.hasOwnProperty.call(data || {}, 'shuffle')) state.shuffle = !!(data as any).shuffle;
                persist();
                notify('now', data);
                return;
            }
            if (event === 'shuffle') {
                state.shuffle = !!((data as any)?.enabled);
                persist();
                notify('shuffle', data);
                return;
            }
            if (event === 'master_volume') {
                if (typeof data === 'number') state.master = data;
                persist();
                notify('master_volume', data);
                return;
            }
            if (event === 'airplay_full') {
                const list = Array.isArray(data) ? data as any[] : [];
                state.devices = list.map((d: any) => d?.name).filter(Boolean) as string[];
                state.current = new Set(list.filter((d: any) => d?.active).map((d: any) => d.name));
                const nv: { [key: string]: number } = {};
                list.forEach((d: any) => { if (d && typeof d.volume === 'number') nv[d.name] = Math.max(0, Math.min(1, d.volume / 100)); });
                state.vols = nv;
                persist();
                notify('airplay_full', data);
                return;
            }
            if (event === 'current_devices' || event === 'selected_devices') {
                let arr = Array.isArray(data) ? data as any[] : ((data as any) && Array.isArray((data as any).devices) ? (data as any).devices : []);
                const names = arr.map((d: any) => (typeof d === 'string') ? d : (d?.name || d?.device)).filter(Boolean) as string[];
                state.current = new Set(names);
                persist();
                notify(event, data);
                return;
            }
            if (event === 'device_volumes' || event === 'devices_volume' || event === 'per_device_volume') {
                const norm: { [key: string]: number } = {};
                if (data && typeof data === 'object' && !Array.isArray(data)) {
                    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
                        let val = Number(v); if (!isFinite(val)) continue; if (val > 1.5) val = val / 100; if (val < 0) val = 0; if (val > 1) val = 1; norm[k] = val;
                    }
                } else if (Array.isArray(data)) {
                    for (const it of data as any[]) {
                        const name = it?.name || it?.device;
                        let val = Number(it?.volume ?? it?.level ?? NaN);
                        if (!name || !isFinite(val)) continue; if (val > 1.5) val = val / 100; if (val < 0) val = 0; if (val > 1) val = 1; norm[name] = val;
                    }
                }
                if (Object.keys(norm).length) {
                    state.vols = { ...state.vols, ...norm };
                    persist();
                    notify('device_volumes', norm);
                }
                return;
            }
            if (event === 'devices' || event === 'airplay_devices') {
                const list = Array.isArray(data) ? data as any[] : ((data as any) && Array.isArray((data as any).devices) ? (data as any).devices : []);
                const names = list.map((d: any) => (typeof d === 'string') ? d : d?.name).filter(Boolean) as string[];
                if (names.length) { state.devices = names; persist(); notify(event, names); }
                return;
            }
            if (event === 'artwork_saved') {
                notify('artwork_saved', data);
                return;
            }
        } catch { }
    };

    const openSSE = () => {
        if (es) { try { es.close(); } catch { } es = null; }
        const getSigned = async () => {
            try {
                const hass = g.hassConnection?.hass ?? g.hass;
                if (hass && hass.callWS) {
                    const resp = await hass.callWS({ type: 'auth/sign_path', path: API_BASE + 'events', expires: 60 });
                    if (resp && resp.path) return resp.path;
                }
            } catch { }
            return API_BASE + 'events';
        };
        (async () => {
            const path = await getSigned();
            const src = new EventSource(path);
            es = src;
            src.onopen = () => {
                backoff = 1000;
                state.sseHealthy = true;
                if (pollFast) { clearInterval(pollFast); pollFast = null; }
                if (!pollSlow) pollSlow = setInterval(() => prefetch(false), 60000);
                prefetch(true);
            };
            src.onmessage = (ev) => {
                try { const msg = JSON.parse(ev.data); applyEvent(msg.event, msg.data); state.sseHealthy = true; } catch { }
            };
            src.onerror = () => {
                try { src.close(); } catch { }
                es = null;
                state.sseHealthy = false;
                if (pollSlow) { clearInterval(pollSlow); pollSlow = null; }
                if (!pollFast) pollFast = setInterval(() => prefetch(false), 5000);
                const wait = Math.min(30000, backoff); backoff = Math.min(30000, Math.floor(backoff * 1.7));
                setTimeout(openSSE, wait);
            };
        })();
    };

    const prefetch = async (force = false) => {
        try {
            let hass: Hass | undefined = g.hassConnection?.hass ?? g.hass;
            try { if (!hass) { const el = document.querySelector('home-assistant'); if (el && (el as any).hass) hass = (el as any).hass; } } catch { }
            const call = async (m: string, p: string, b?: unknown) => {
                try {
                    if (hass && hass.callApi) return await hass.callApi(m || 'GET', p, b);
                    if (!hass) return null;
                    const up = p.startsWith('/api/') ? p : `/api/${p}`;
                    const opts: RequestInit = { method: m || 'GET', credentials: 'same-origin' };
                    if (b) { opts.body = JSON.stringify(b); opts.headers = { 'Content-Type': 'application/json' }; }
                    const r = await fetch(up, opts);
                    if (!r || !r.ok) return null;
                    return await r.json().catch(() => null);
                } catch { return null; }
            };
            const [devs, cur, vols, st] = await Promise.all([
                call('GET', 'apple_music/devices'),
                call('GET', 'apple_music/current_devices'),
                call('GET', 'apple_music/device_volumes'),
                call('GET', 'apple_music/status'),
            ]);
            let names: string[] = [];
            if (devs) {
                const list = Array.isArray(devs) ? devs : (Array.isArray((devs as any).devices) ? (devs as any).devices : []);
                names = list.map((d: any) => (typeof d === 'string') ? d : (d && d.name)).filter(Boolean) as string[];
                state.devices = names;
            }
            let currentNames: string[] = [];
            if (cur) {
                const arr = Array.isArray(cur) ? cur : ((cur as any).devices || []);
                currentNames = arr.map((d: any) => (typeof d === 'string') ? d : (d && d.name || d.device)).filter(Boolean) as string[];
                state.current = new Set(currentNames);
            }
            let volMap: { [key: string]: number } = {};
            if (vols && typeof vols === 'object') {
                const n: { [key: string]: number } = {};
                for (const [k, v] of Object.entries(vols as Record<string, number>)) {
                    let val = Number(v); if (!isFinite(val)) continue; if (val > 1.5) val = val / 100; if (val < 0) val = 0; if (val > 1) val = 1; n[k] = val;
                }
                volMap = n; state.vols = n;
            }
            if (st) {
                const now = (st as any).now || st;
                state.now = {
                    title: (now as any).title || state.now.title || '',
                    artist: (now as any).artist || state.now.artist || '',
                    album: (now as any).album || state.now.album || '',
                    artwork_token: ((now as any).artwork_token || (now as any).token || state.now.artwork_token || ''),
                };
                if (Object.prototype.hasOwnProperty.call(now, 'shuffle')) state.shuffle = !!(now as any).shuffle;
                try {
                    const stState = (now && typeof (now as any).state === 'string') ? (now as any).state : (now && (now as any).player && typeof (now as any).player.state === 'string' ? (now as any).player.state : '');
                    if (stState) state.playerState = String(stState).toLowerCase();
                } catch { }
                try { state.nowTs = Date.now(); } catch { }
            }
            persist();
            try {
                const payload = (names.length ? names : state.devices).map((nm: string) => ({
                    name: nm,
                    active: state.current.has(nm),
                    volume: Math.round(((volMap[nm] ?? state.vols[nm] ?? 0) * 100)),
                }));
                notify('airplay_full', payload);
            } catch { }
            try { notify('devices', state.devices); } catch { }
            try { notify('current_devices', Array.from(state.current)); } catch { }
            try { notify('device_volumes', state.vols); } catch { }
            try { notify('now', state.now); } catch { }
        } catch { }
    };

    prefetch(true);
    openSSE();
    if (!pollFast) pollFast = setInterval(() => prefetch(false), 5000);

    (window as any).__appleMusicStore = {
        subscribe(fn) { if (typeof fn === 'function') { listeners.add(fn); return () => { try { listeners.delete(fn); } catch { } }; } return () => { }; },
        snapshot() { return { devices: state.devices.slice(), current: new Set(state.current), vols: { ...state.vols }, now: { ...state.now }, shuffle: !!state.shuffle, master: state.master, sseHealthy: !!state.sseHealthy, playerState: state.playerState || '', nowTs: state.nowTs || 0 }; },
        prefetch,
    } as Store;
})();

export const appleMusicStore = (window as any).__appleMusicStore as Store;
