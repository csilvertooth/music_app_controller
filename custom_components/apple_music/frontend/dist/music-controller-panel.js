// Music Controller custom panel (no config.yaml required)
// Version: update this when changing the panel JS.
// This value is read by the HA integration for cache-busting and About dialog.
const MUSIC_CONTROLLER_JS_VERSION = '2025-09-05-002';
// - Reads HA state for media_player.apple_music_player
// - Talks to controller via proxied endpoints: /status, /devices, /current_devices, /device_volumes, /set_devices, /device_volume
// - Auto-refreshes while the panel is open

class MusicControllerPanel extends HTMLElement {
  constructor() {
    super();
    this._ready = false;
    this._hass = null;
    this._pollHandle = null;
    this._devices = [];          // all discovered AirPlay device names
    this._currentDevices = new Set();
    this._deviceVolumes = {};    // name -> 0..1
    this._debouncers = new Map();// device -> timeout id
    this._pendingApply = false;   // guard to avoid UI being overwritten during apply
    this._showDisabled = false;   // show disabled AirPlay devices?
    // Browse & search state
    this._browseSection = 'playlists';
    this._browseStack = [];
    this._browseData = null;
    this._browseCache = { playlists: null, albums: null, artists: null };
    this._browsePage = 0;
    this._pageSize = 5;
    this._browseAlpha = '';
    this._browseReqToken = 0; // to drop stale responses
    this._preferWS = true; // use HA WebSocket browse/search instead of REST to avoid 404s
    this._marqTimers = new WeakMap(); // element -> timeout id for marquee
    this._es = null; // EventSource instance
    this._sseBackoff = 1000; // ms, grows on errors up to 30s
    this._sseHealthy = false; // when true, suppress aggressive polling
    this._healthHandle = null; // slow watchdog poll when SSE is healthy
    // Smooth UI holds to prevent flicker/jank
    this._masterHoldUntil = 0;   // ms timestamp
    this._devHold = new Map();   // name -> hold-until ms
    this._lastNPKey = '';
  }

  connectedCallback() {
    // Reconnect/poll when returning from sleep or navigating back
    if (!this._wakeHandlersBound) {
      const refreshFromWake = () => {
        try { this._ensureUI?.(); this._restoreUIFromCache?.(); } catch(_){ }
      };
      this._onVis = () => { if (document.visibilityState === 'visible') { refreshFromWake(); try { this._connectSSE(); } catch(_){} this._poll(true); } };
      this._onPageShow = () => { refreshFromWake(); try { this._connectSSE(); } catch(_){} this._poll(true); };
      this._onFocus = () => { refreshFromWake(); this._poll(true); };
      this._onOnline = () => { refreshFromWake(); try { this._connectSSE(); } catch(_){} this._poll(true); };
      document.addEventListener('visibilitychange', this._onVis);
      window.addEventListener('pageshow', this._onPageShow);
      window.addEventListener('focus', this._onFocus);
      window.addEventListener('online', this._onOnline);
      this._wakeHandlersBound = true;
    }
    // If we were detached and reattached, make sure polling resumes
    if (this._ready && !this._pollHandle) this._startPolling();
  }

  // Ensure the panel DOM exists after a suspension or HA hot-reload
  _ensureUI() {
    try {
      // If the main sections container is missing but we were previously ready, re-render the shell
      const hasSections = !!this.querySelector('#sections');
      if (!hasSections) {
        this._renderSkeleton();
        this._wireStaticHandlers();
        try { this._applyLayout(); } catch(_){}
      }
    } catch (_) { /* ignore */ }
  }

  // Quickly paint last-known state so the UI isn't blank while waking
  _restoreUIFromCache() {
    try {
      // Devices/outputs from last poll
      this._renderDevices?.();
      // Now playing from HA state and/or cached /status
      this._updateFromHass?.();
      this._updateNowPlayingAux?.();
      // Keep layout consistent
      this._applyLayout?.();
    } catch (_) { /* ignore */ }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._ready) {
      this._ready = true;
      this._renderSkeleton();
      this._wireStaticHandlers();
      // Apply saved layout immediately to avoid flash of defaults
      try { this._applyLayout(); } catch {}
      this._startPolling();
      // Connect SSE early so live updates apply without waiting for user interaction
      try { this._connectSSE(); } catch(_){}
    }
    this._updateFromHass();
  }

  disconnectedCallback() {
    if (this._pollHandle) {
      clearInterval(this._pollHandle);
      this._pollHandle = null;
    }
    for (const t of this._debouncers.values()) clearTimeout(t);
    this._debouncers.clear();
    // Remove wake handlers to avoid leaks
    if (this._wakeHandlersBound) {
      try { document.removeEventListener('visibilitychange', this._onVis); } catch(_){}
      try { window.removeEventListener('pageshow', this._onPageShow); } catch(_){}
      try { window.removeEventListener('focus', this._onFocus); } catch(_){}
      try { window.removeEventListener('online', this._onOnline); } catch(_){}
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
                <button class="menuitem" id="menuDebug" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Debug ▾</button>
                <div id="debugMenu" class="menu" style="display:none; position:absolute; right:100%; top:0; background: var(--card-background-color, Canvas); border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:10px; box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,0.4)); min-width:220px; margin-right:8px;">
                  <button class="menuitem" id="menuForceSaveArt" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Force Save Artwork</button>
                </div>
              </div>
              <div style="position:relative;">
                <button class="menuitem" id="menuServices" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Services ▾</button>
                <div id="servicesMenu" class="menu" style="display:none; position:absolute; right:100%; top:0; background: var(--card-background-color, Canvas); border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); border-radius:10px; box-shadow: var(--ha-card-box-shadow, 0 4px 16px rgba(0,0,0,0.4)); min-width:220px; margin-right:8px;">
                  <button class="menuitem" id="menuPurgeAlbum" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Purge Album Cache</button>
                  <button class="menuitem" id="menuPurgeThumb" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Purge Thumb Cache</button>
                </div>
              </div>
              <div style="height:1px; background: var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); margin:6px 0;"></div>
              <button class="menuitem" id="menuRestart" style="display:block; width:100%; text-align:left; padding:10px 12px; background:transparent;">Restart Music App</button>
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
        <div class="sections" id="sections">
          <ha-card id="now" class="size-l">
            <div class="card-header mp-header">
              <div class="mp-title">Music Player</div>
              <button id="openBrowse" class="secondary">Browse</button>
            </div>
            <div class="constrain">
              <div class="media">
                <img id="art" class="art" alt="artwork"/>
                <div class="meta">
                  <div class="track scroll-viewport"><span id="track" class="scroll-inner">—</span></div>
                  <div class="artist scroll-viewport"><span id="artist" class="scroll-inner">—</span></div>
                  <div class="album scroll-viewport"><span id="album" class="scroll-inner">—</span></div>
                  <div class="controls">
                    <button id="prev" class="secondary"><ha-icon icon="mdi:skip-previous"></ha-icon><span class="btnlabel">Prev</span></button>
                    <button id="playpause"><ha-icon icon="mdi:play-pause"></ha-icon><span class="btnlabel">Play/Pause</span></button>
                    <button id="shuffle" class="secondary"><ha-icon icon="mdi:shuffle"></ha-icon><span class="btnlabel">Shuffle</span></button>
                    <button id="next" class="secondary"><ha-icon icon="mdi:skip-next"></ha-icon><span class="btnlabel">Next</span></button>
                  </div>
                  <div class="volrow">
                    <span style="opacity:.8">Vol</span>
                    <button id="mvDown" class="secondary" title="Volume down">−</button>
                    <input id="masterVol" class="range-compact" type="range" min="0" max="1" step="0.01" />
                    <button id="mvUp" class="secondary" title="Volume up">+</button>
                  </div>
                </div>
              </div>
            </div>
          </ha-card>

          <ha-card header="AirPlay Outputs" id="outputs" class="size-m">
            <div class="constrain">
              <div class="head">
                <div style="display:flex; gap:8px;">
                  <button id="toggleDisabled" class="secondary" style="display:none;">Show Disabled</button>
                </div>
                <div style="display:flex; gap:8px;">
                  <button id="refresh" class="secondary">Refresh</button>
                </div>
              </div>
              <div id="devices" class="grid"></div>
            </div>
          </ha-card>

          <!-- Browse Modal -->
          <div id="browseModal" class="modal" aria-hidden="true">
            <div class="backdrop"></div>
            <div class="sheet">
              <button id="browseClose" class="secondary close">✕</button>
              <ha-card header="Browse & Search">
                <div class="constrain">
                  <div class="toolbar">
                    <div class="seg">
                      <button id="segPlaylists" class="segbtn">Playlists</button>
                      <button id="segAlbums" class="segbtn">Albums</button>
                      <button id="segArtists" class="segbtn">Artists</button>
                    </div>
                    <form id="searchForm" class="search">
                      <input id="searchInput" type="search" placeholder="Search…" />
                      <button id="searchBtn" type="submit" class="secondary">Search</button>
                    </form>
                  </div>
                  <div class="browse-inner">
                    <div id="browseHint" class="hint"></div>
                    <div id="browseList" class="list"></div>
                    <div id="browsePager" class="pager" style="display:none;">
                      <div id="alphaRow" class="letters"></div>
                      <div class="pn">
                        <button id="pageFirst" class="secondary">«</button>
                        <button id="pagePrev" class="secondary">‹ Prev</button>
                        <span id="pageInfo" class="info"></span>
                        <button id="pageNext" class="secondary">Next ›</button>
                        <button id="pageLast" class="secondary">»</button>
                      </div>
                    </div>
                    <div id="browseBackRow" class="backrow" style="display:none;">
                      <button id="browseBack" class="secondary">← Back</button>
                    </div>
                  </div>
                </div>
              </ha-card>
            </div>
          </div>
        </div>
      </div>
    `;
    // Safety: ensure no leftover Overview anchors exist
    try { this.querySelectorAll('a.link').forEach(a => a.remove()); } catch(_){ }
  }

  _wireStaticHandlers() {
    this.querySelector('#prev')?.addEventListener('click', () => this._mpService('media_previous_track'));
    this.querySelector('#next')?.addEventListener('click', () => this._mpService('media_next_track'));
    this.querySelector('#playpause')?.addEventListener('click', () => this._mpService('media_play_pause'));
    this.querySelector('#shuffle')?.addEventListener('click', () => this._toggleShuffle());
    this.querySelector('#mvDown')?.addEventListener('click', () => this._bumpMasterVolume(-0.05));
    this.querySelector('#mvUp')?.addEventListener('click', () => this._bumpMasterVolume(+0.05));
    this.querySelector('#masterVol')?.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      // Hold incoming updates briefly so UI reflects drag smoothly
      this._masterHoldUntil = Date.now() + 900;
      this._setMasterVolume(v);
    });
    this.querySelector('#refresh')?.addEventListener('click', () => this._poll(true));
    this.querySelector('#toggleDisabled')?.addEventListener('click', () => {
      this._showDisabled = !this._showDisabled;
      this._renderDevices();
    });
    this.querySelector('#menu')?.addEventListener('click', () => {
      this.dispatchEvent(new CustomEvent('hass-toggle-menu', { bubbles: true, composed: true }));
    });
    // Settings menu
    const settingsBtn = this.querySelector('#settingsBtn');
    const menu = this.querySelector('#settingsMenu');
    const servicesMenu = this.querySelector('#servicesMenu');
    const aboutMenu = this.querySelector('#aboutMenu');
    const debugMenu = this.querySelector('#debugMenu');
    const toggleMenu = (show) => { if (!menu) return; menu.style.display = show ? '' : 'none'; if (!show) toggleServices(false); };
    const toggleServices = (show) => { if (!servicesMenu) return; servicesMenu.style.display = show ? '' : 'none'; };
    const toggleAbout = (show) => { if (!aboutMenu) return; aboutMenu.style.display = show ? '' : 'none'; };
    const toggleDebug = (show) => { if (!debugMenu) return; debugMenu.style.display = show ? '' : 'none'; };
    settingsBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      const vis = menu && menu.style.display !== 'none';
      toggleMenu(!vis);
    });
    document.addEventListener('click', (e)=>{
      if (!menu || !settingsBtn) return;
      if (menu.contains(e.target) || settingsBtn.contains(e.target)) return;
      toggleMenu(false); toggleAbout(false); toggleServices(false); toggleDebug(false);
    }, { passive:true });
    this.querySelector('#menuCustomize')?.addEventListener('click', () => { toggleMenu(false); this._toggleCustomize(); });
    this.querySelector('#menuReset')?.addEventListener('click', () => { toggleMenu(false); try { localStorage.removeItem('apple_music_panel_layout'); } catch(_){ } this._layout = undefined; this._applyLayout(); });
    this.querySelector('#menuAbout')?.addEventListener('click', async (e) => {
      e.stopPropagation(); const vis = aboutMenu && aboutMenu.style.display !== 'none'; toggleAbout(!vis);
      if (!vis) {
        try {
          const info = await this._apiGet('apple_music/panel_info');
          const p = (info && info.panel_version) ? String(info.panel_version) : 'unknown';
          const a = (info && info.asset_version) ? String(info.asset_version) : 'unknown';
          // Prefer in-file version constant; fall back to module query param; then server-reported asset version.
          const jsVer = (()=>{
            try { if (typeof MUSIC_CONTROLLER_JS_VERSION !== 'undefined' && MUSIC_CONTROLLER_JS_VERSION) return String(MUSIC_CONTROLLER_JS_VERSION); } catch(_) {}
            try { return new URL(import.meta.url).searchParams.get('v') || ''; } catch(_) { /* ignore */ }
            return '';
          })();
          const pv = this.querySelector('#aboutPanelVer'); if (pv) pv.textContent = p;
          const jv = this.querySelector('#aboutJsVer'); if (jv) jv.textContent = jsVer || a || 'unknown';
        } catch(_) {
          const pv = this.querySelector('#aboutPanelVer'); if (pv) pv.textContent = 'unknown';
          const jv = this.querySelector('#aboutJsVer'); if (jv) jv.textContent = 'unknown';
        }
      }
    });
    this.querySelector('#menuDebug')?.addEventListener('click', (e) => { e.stopPropagation(); const vis = debugMenu && debugMenu.style.display !== 'none'; toggleDebug(!vis); });
    this.querySelector('#menuServices')?.addEventListener('click', (e) => { e.stopPropagation(); const vis = servicesMenu && servicesMenu.style.display !== 'none'; toggleServices(!vis); });
    this.querySelector('#menuForceSaveArt')?.addEventListener('click', async () => {
      toggleMenu(false); toggleDebug(false);
      try {
        const token = (this._status && this._status.artwork_token) ? String(this._status.artwork_token) : '';
        const qs = token ? `?tok=${encodeURIComponent(token)}&debug=1&refresh=1` : `?debug=1&refresh=1`;
        await this._apiGet(`apple_music/artwork${qs}`);
        alert('Force save triggered. Check logs and cache folder.');
      } catch(_) {
        alert('Force save failed.');
      }
    });
    this.querySelector('#menuPurgeAlbum')?.addEventListener('click', async () => { toggleMenu(false); if (!confirm('Purge Album artwork cache?')) return; try { await this._purgeAlbumCache(); alert('Album cache purged.'); } catch(_) { alert('Failed to purge album cache.'); } });
    this.querySelector('#menuPurgeThumb')?.addEventListener('click', async () => { toggleMenu(false); if (!confirm('Purge Thumbnail cache?')) return; try { await this._purgeThumbCache(); alert('Thumb cache purged.'); } catch(_) { alert('Failed to purge thumb cache.'); } });
    this.querySelector('#menuRestart')?.addEventListener('click', async () => { toggleMenu(false); if (!confirm('Restart the Music app now?')) return; this._appBusy(true); try { await this._restartMusicApp(); } finally { this._appBusy(false); } });
    // Customize layout
    this.querySelector('#customize')?.addEventListener('click', () => this._toggleCustomize());
    const bar = this.querySelector('#layoutBar');
    bar?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button'); if (!btn) return;
      const key = btn.getAttribute('data-key'); const act = btn.getAttribute('data-act');
      if (!key || !act) return;
      if (act === 'up') this._moveCard(key, -1);
      else if (act === 'down') this._moveCard(key, +1);
    });
    // Link widths toggle
    const link = this.querySelector('#linkSizes');
    if (link) {
      try { link.checked = !!(this._layout && this._layout.link_sizes); } catch(_){}
      link.addEventListener('change', () => {
        this._layout = this._layout || this._loadLayout() || {};
        this._layout.link_sizes = !!link.checked;
        this._saveLayout(this._layout);
        this._applyLayout();
      });
    }
    const saveBtn = this.querySelector('#saveLayout');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        // Settings are saved as you go; this just closes customize mode
        this._toggleCustomize();
      });
    }
    const resetBtn = this.querySelector('#resetLayout');
    resetBtn?.addEventListener('click', () => {
      try { localStorage.removeItem('apple_music_panel_layout'); } catch(_){ }
      this._layout = undefined;
      this._applyLayout();
    });
    // Attach drag/resize listeners once
    this._enableEditInteractions?.() || this._enableEditInteractions();

    // Generic click/tap feedback on buttons and actionable list rows
    this.addEventListener('click', (ev) => {
      const t = ev.target.closest('button, .item[data-act]');
      if (!t) return;
      t.classList.add('pulse');
      if (t.tagName === 'BUTTON') { t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 180); }
      setTimeout(() => t.classList.remove('pulse'), 200);
    });

    // Browse segment switches
    this.querySelector('#segPlaylists')?.addEventListener('click', () => this._browseSwitch('playlists'));
    this.querySelector('#segAlbums')?.addEventListener('click', () => this._browseSwitch('albums'));
    this.querySelector('#segArtists')?.addEventListener('click', () => this._browseSwitch('artists'));

    // Search submit
    this.querySelector('#searchForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const term = this.querySelector('#searchInput')?.value?.trim() || '';
      if (term) this._browseSearch(term);
    });

    // Back
    this.querySelector('#browseBack')?.addEventListener('click', () => this._browseBack());

    // Open/close Browse modal
    this.querySelector('#openBrowse')?.addEventListener('click', () => this._showBrowse());
    this.querySelector('#browseClose')?.addEventListener('click', () => this._hideBrowse());
    this.querySelector('#browseModal .backdrop')?.addEventListener('click', () => this._hideBrowse());

    // Delegate clicks in list
    this.querySelector('#browseList')?.addEventListener('click', (ev) => this._browseListClick(ev));

    // Pager controls (delegate to handle dynamic content reliably)
    const pager = this.querySelector('#browsePager');
    pager?.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      const id = b.id;
      if (id === 'pageFirst') this._pageSet(0);
      else if (id === 'pagePrev') this._pageSet(this._browsePage - 1);
      else if (id === 'pageNext') this._pageSet(this._browsePage + 1);
      else if (id === 'pageLast') this._pageSet(Number.POSITIVE_INFINITY);
    });

    // Letters (delegate)
    this.querySelector('#alphaRow')?.addEventListener('click', (ev) => {
      const b = ev.target.closest('.letterbtn');
      if (!b || b.hasAttribute('disabled')) return;
      const letter = b.dataset.letter || '';
      this._alphaSet(letter);
    });
  }

  async _toggleShuffle() {
    try {
      const isShuffle = !!(this._status?.shuffle ?? this._status?.is_shuffle ?? this._status?.player?.shuffle);
      await this._apiSend('POST', 'apple_music/shuffle', { enabled: !isShuffle });
    } catch (_) { /* ignore */ }
    await this._fetchStatus();
    this._updateNowPlayingAux();
  }

  _showBrowse() {
    const modal = this.querySelector('#browseModal');
    if (!modal) return;
    modal.classList.add('show');
    // Initialize hint if no data yet
    if (this._browseCache.playlists === null && this._browseCache.albums === null && this._browseCache.artists === null) {
      const hint = this.querySelector('#browseHint');
      if (hint) hint.textContent = 'Choose Playlists, Albums, or Artists to begin browsing';
      return;
    }
    // Re-render current view when opening
    try { this._renderBrowse(); } catch (_) {}
  }

  _hideBrowse() {
    const modal = this.querySelector('#browseModal');
    if (!modal) return;
    modal.classList.remove('show');
  }

  _updateShuffleButtonVisual() {
    const btn = this.querySelector('#shuffle');
    if (!btn) return;
    const isShuffle = !!(this._status?.shuffle ?? this._status?.is_shuffle ?? this._status?.player?.shuffle);
    btn.classList.toggle('active', !!isShuffle);
  }

  _updatePlayPauseVisual(stateOverride) {
    try {
      const btn = this.querySelector('#playpause');
      if (!btn) return;
      let st = (stateOverride || '').toString().toLowerCase();
      if (!st) {
        const ent = this._mpEntity?.() || null;
        st = (ent && ent.state) ? String(ent.state).toLowerCase() : '';
      }
      btn.classList.remove('pp-playing','pp-paused','pp-idle');
      if (st === 'playing') btn.classList.add('pp-playing');
      else if (st === 'paused') btn.classList.add('pp-paused');
      else btn.classList.add('pp-idle');
    } catch (_) {}
  }

  // ====== HA helpers ======
  _entityId() {
    const s = this._hass?.states || {};
    return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }
  _mpEntity() { const id = this._entityId(); return this._hass?.states?.[id]; }
  _mpService(service, data={}) {
    if (!this._hass) return;
    this._hass.callService('media_player', service, { entity_id: this._entityId(), ...data });
  }
  _setMasterVolume(level) { this._mpService('volume_set', { volume_level: level }); }
  _bumpMasterVolume(delta) {
    const mp = this._mpEntity();
    let cur = (typeof mp?.attributes?.volume_level === 'number') ? mp.attributes.volume_level : 0;
    cur = Math.max(0, Math.min(1, cur + delta));
    const slider = this.querySelector('#masterVol');
    if (slider) slider.value = String(cur);
    // Hold brief UI control to avoid jump from async echo
    this._masterHoldUntil = Date.now() + 900;
    this._setMasterVolume(cur);
  }

  // ====== Polling controller endpoints ======
  _startPolling() {
    // Start SSE for push; keep periodic polling only if SSE is not healthy
    this._connectSSE();
    // Clear existing timers
    if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
    if (this._healthHandle) { clearInterval(this._healthHandle); this._healthHandle = null; }
    // If SSE isn't healthy yet, use fast poll to bootstrap; otherwise run a slow watchdog.
    if (!this._sseHealthy) {
      this._pollHandle = setInterval(() => this._poll(), 3000);
    } else {
      this._healthHandle = setInterval(() => this._poll(false), 60000);
    }
    this._poll(true);
  }

  async _poll(force=false) {
    try {
      await Promise.all([
        this._fetchDevices(force),
        this._fetchCurrentDevices(),
        this._fetchDeviceVolumes(),
        this._fetchStatus(),
      ]);
      this._renderDevices();
      this._updateNowPlayingAux();
      this._applyLayout();
    } catch (e) {
      // Silent; panel should keep working even if controller is offline
    }
  }

  _loadLayout() {
    try { return JSON.parse(localStorage.getItem('apple_music_panel_layout')||'{}'); } catch { return {}; }
  }
  _saveLayout(obj) {
    try { localStorage.setItem('apple_music_panel_layout', JSON.stringify(obj||{})); } catch {}
  }
  _applyLayout() {
    this._layout = this._layout || this._loadLayout() || {};
    const order = Array.isArray(this._layout.order)?this._layout.order:['now','outputs','browse'];
    const sizes = this._layout.sizes || { now:'l', outputs:'m', browse:'l' };
    if (this._layout.link_sizes) {
      sizes.outputs = sizes.now;
    }
    const cont = this.querySelector('#sections'); if (!cont) return;
    const nodes = { now: this.querySelector('#now'), outputs: this.querySelector('#outputs'), browse: this.querySelector('#browse') };
    order.forEach(k => { const n = nodes[k]; if (n && n.parentElement === cont) cont.appendChild(n); });
    Object.entries(nodes).forEach(([k,node]) => { if (!node) return; node.classList.remove('size-s','size-m','size-l'); const sz = sizes[k] || (k==='outputs'?'m':'l'); node.classList.add(`size-${sz}`); });
    // Keep the linkSizes checkbox in sync with current layout
    const linkChk = this.querySelector('#linkSizes');
    if (linkChk) { try { linkChk.checked = !!(this._layout && this._layout.link_sizes); } catch(_){} }
  }
  _toggleCustomize() {
    const bar = this.querySelector('#layoutBar'); if (!bar) return;
    const visible = bar.style.display !== 'none';
    bar.style.display = visible ? 'none' : '';
    if (!visible) { this._layout = this._layout || this._loadLayout() || {}; this._applyLayout(); }
    // Toggle edit class and handles
    const cont = this.querySelector('#sections');
    if (cont) cont.classList.toggle('edit', !visible);
    this._setCardsEditable(!visible);
  }
  _moveCard(key, dir) {
    this._layout = this._layout || this._loadLayout() || {};
    const order = Array.isArray(this._layout.order)?[...this._layout.order]:['now','outputs','browse'];
    const idx = order.indexOf(key); if (idx<0) return;
    const j = Math.max(0, Math.min(order.length-1, idx + dir));
    if (j === idx) return;
    const [item] = order.splice(idx,1); order.splice(j,0,item);
    this._layout.order = order; this._saveLayout(this._layout); this._applyLayout();
  }
  _cycleSize(key) {
    this._layout = this._layout || this._loadLayout() || {};
    const sizes = this._layout.sizes || { now:'l', outputs:'m', browse:'l' };
    const cur = sizes[key] || (key==='outputs'?'m':'l');
    const next = cur==='l'?'m':cur==='m'?'s':'l';
    sizes[key] = next; this._layout.sizes = sizes; this._saveLayout(this._layout); this._applyLayout();
  }

  _setCardsEditable(on) {
    ['now','outputs','browse'].forEach(id => {
      const card = this.querySelector(`#${id}`);
      if (!card) return;
      card.classList.toggle('editable', !!on);
      let handle = card.querySelector('.resize-handle');
      if (on && !handle) {
        handle = document.createElement('div');
        handle.className = 'resize-handle';
        handle.setAttribute('data-key', id);
        handle.addEventListener('pointerdown', (e)=> this._onResizeStart(e, id));
        card.appendChild(handle);
      }
      if (!on && handle) handle.remove();
    });
  }

  _enableEditInteractions() {
    // attach pointerdown for drag on cards (won't drag unless customize is active)
    ['now','outputs','browse'].forEach(id => {
      const card = this.querySelector(`#${id}`);
      if (!card) return;
      if (!card._dragBound) {
        card.addEventListener('pointerdown', (e)=> this._onDragPointerDown(e, id));
        card._dragBound = true;
      }
    });
  }

  _onDragPointerDown(e, key) {
    const cont = this.querySelector('#sections');
    if (!cont || !cont.classList.contains('edit')) return;
    if (e.target.closest('.resize-handle, button, input, select, textarea, a')) return;
    e.preventDefault();
    const card = this.querySelector(`#${key}`);
    if (!card) return;
    const placeholder = document.createElement('div');
    placeholder.className = 'drag-placeholder';
    let active = false;
    const startY = e.clientY;
    const onMove = (ev) => {
      const y = ev.clientY;
      if (!active) {
        // activate drag after small move
        if (Math.abs((y||0) - (startY||0)) < 4) return;
        active = true;
        card.parentElement.insertBefore(placeholder, card);
      }
      const cards = Array.from(cont.querySelectorAll('ha-card')).filter(n=> n !== card && n !== placeholder);
      let insertBefore = null;
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        if (y < r.top + r.height/2) { insertBefore = c; break; }
      }
      if (insertBefore) cont.insertBefore(placeholder, insertBefore); else cont.appendChild(placeholder);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!active) return;
      placeholder.replaceWith(card);
      // Persist order
      const order = Array.from(cont.querySelectorAll('ha-card')).map(n=> n.id).filter(Boolean);
      this._layout = this._layout || this._loadLayout() || {};
      this._layout.order = order;
      this._saveLayout(this._layout);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  _onResizeStart(e, key) {
    e.stopPropagation(); e.preventDefault();
    const cont = this.querySelector('#sections');
    const card = this.querySelector(`#${key}`);
    if (!cont || !card) return;
    const rect = cont.getBoundingClientRect();
    const onMove = (ev) => {
      const x = ev.clientX;
      const frac = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
      const sz = frac < 0.33 ? 's' : (frac < 0.66 ? 'm' : 'l');
      card.classList.remove('size-s','size-m','size-l');
      card.classList.add(`size-${sz}`);
    };
  const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const sizes = (this._layout && this._layout.sizes) || {};
      const sz = card.classList.contains('size-l') ? 'l' : card.classList.contains('size-m') ? 'm' : 's';
      this._layout = this._layout || this._loadLayout() || {};
      this._layout.sizes = { now:'l', outputs:'m', browse:'l', ...(this._layout.sizes||{}) };
      this._layout.sizes[key] = sz;
      if (this._layout.link_sizes && (key === 'now' || key === 'outputs')) {
        this._layout.sizes.now = sz;
        this._layout.sizes.outputs = sz;
      }
      this._saveLayout(this._layout);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }

  async _apiGet(path) {
    if (!this._hass || !this._hass.callApi) throw new Error('hass.callApi unavailable');
    return await this._hass.callApi('GET', path);
  }

  async _apiSend(method, path, body) {
    if (!this._hass || !this._hass.callApi) throw new Error('hass.callApi unavailable');
    return await this._hass.callApi(method, path, body);
  }

  _appBusy(on) { const b = this.querySelector('#settingsBtn'); if (b) b.disabled = !!on; }

  async _tryPaths(method, paths, body={}) {
    for (const p of paths) {
      try { await this._apiSend(method, `apple_music/${p}`, body); return true; } catch (_) { /* try next */ }
    }
    return false;
  }

  async _restartMusicApp() {
    // Try common endpoints first
    const ok = await this._tryPaths('POST', [
      'restart', 'music/restart', 'restart_music', 'music_app/restart', 'save_restart', 'save_and_restart'
    ], {});
    if (ok) return true;
    // Fallback: ask app to quit; supervisor should relaunch it, or user can start from host
    await this._tryPaths('POST', ['quit','music/quit','quit_music'], {});
    return false;
  }

  // no separate Quit in UI

  async _fetchJSON(url, options) {
    // Use hass.callApi for authenticated requests to /api/apple_music/*
    if (!options) {
      return await this._apiGet(url);
    }
    // For non-GET with a body, go through _apiSend below
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? JSON.parse(options.body) : undefined;
    return await this._apiSend(method, url, body);
  }

  async _fetchDevices(force=false) {
    if (this._devices.length && !force) return;
    try {
      const list = await this._fetchJSON('apple_music/devices');
      if (Array.isArray(list)) this._devices = list;
      else if (list && Array.isArray(list.devices)) this._devices = list.devices;
    } catch (e) { /* ignore */ }
  }

  async _fetchCurrentDevices() {
    try {
      const cur = await this._fetchJSON('apple_music/current_devices');
      const arr = Array.isArray(cur) ? cur : (cur?.devices || []);
      if (!this._pendingApply) {
        this._currentDevices = new Set(arr);
      }
    } catch (e) { /* ignore */ }
  }

  async _fetchDeviceVolumes() {
    try {
      const vols = await this._fetchJSON('apple_music/device_volumes');
      if (vols && typeof vols === 'object') {
        const norm = {};
        for (const [k, v] of Object.entries(vols)) {
          let val = Number(v);
          if (!isFinite(val)) continue;
          if (val > 1.5) val = val / 100; // normalize 0-100 → 0..1
          if (val < 0) val = 0; if (val > 1) val = 1;
          norm[k] = val;
        }
        this._deviceVolumes = norm;
      }
    } catch (e) { /* ignore */ }
  }

  async _fetchStatus() {
    try {
      // Some servers provide /status with now-playing info
      const st = await this._fetchJSON('apple_music/status');
      // Not strictly required; we primarily read hass state
      this._status = st || {};
      this._updateShuffleButtonVisual?.();
    } catch (e) { /* ignore */ }
  }

  // ====== Render runtime data ======
  _updateFromHass() {
    const mp = this._mpEntity();
    const art = this.querySelector('#art');
    const track = this.querySelector('#track');
    const artist = this.querySelector('#artist');
    const album = this.querySelector('#album');
    const masterVol = this.querySelector('#masterVol');

    if (!mp) return;

    const attrs = mp.attributes || {};
    // Preserve last-known fields to avoid blanking during refresh
    const nextTitle  = attrs.media_title       || (track.textContent  || '—');
    const nextArtist = attrs.media_artist      || (artist.textContent || '—');
    const nextAlbum  = attrs.media_album_name  || (album.textContent  || '—');
    const prevKey = this._lastNPKey || '';
    const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
    this._lastNPKey = nextKey;
    track.textContent  = nextTitle;
    artist.textContent = nextArtist;
    album.textContent  = nextAlbum;
    if (typeof attrs.volume_level === 'number' && Date.now() >= this._masterHoldUntil) {
      masterVol.value = String(attrs.volume_level);
    }
    // Prefer artwork token path with caching to avoid flashes
    const tok = this._status?.artwork_token;
    if (tok) {
      try { this._setArtwork(tok); } catch(_){}
    } else {
      // If no token, fetch current artwork whenever track metadata changes
      if (nextKey !== prevKey) {
        try { this._refreshCurrentArtworkNoToken?.(); } catch(_){}
      }
      // If we don't have a blob yet, fall back to entity_picture
      const imgEl = this.querySelector('#art');
      const hasBlob = !!(imgEl?.dataset?.blobUrl);
      if (!hasBlob) {
        const artUrl = attrs.entity_picture_local || attrs.entity_picture;
        if (artUrl && art.src !== artUrl) art.src = artUrl;
      }
    }
    this._applyNowPlayingMarquee?.();
    this._updatePlayPauseVisual?.();
  }

  _updateNowPlayingAux() {
    // Optionally merge information from /status if media_player lacks it
    const mp = this._mpEntity();
    if (!mp || !this._status) return;
    const attrs = mp.attributes || {};
    if (!attrs.media_title && this._status.title) this.querySelector('#track').textContent = this._status.title;
    if (!attrs.media_artist && this._status.artist) this.querySelector('#artist').textContent = this._status.artist;
    if (!attrs.media_album_name && this._status.album) this.querySelector('#album').textContent = this._status.album;
    this._updateShuffleButtonVisual?.();
    this._applyNowPlayingMarquee?.();
  }

  _renderDevices() {
    const cont = this.querySelector('#devices');
    if (!cont) return;

    const enabled = this._devices.filter(n => this._currentDevices.has(n));
    const disabled = this._devices.filter(n => !this._currentDevices.has(n));
    const showAll = (enabled.length === 0) || this._showDisabled;
    const order = showAll ? [...enabled, ...disabled] : enabled;

    // If user is actively adjusting any device volume, update in-place and skip full re-render
    const now = Date.now();
    const anyHeld = Array.from(this._devHold.values()).some(t => now < t) || this._pendingApply;
    if (anyHeld) {
      // Update existing sliders/toggles in place
      cont.querySelectorAll('.dev-volume').forEach(sl => {
        const name = sl.dataset.dev;
        const holdUntil = this._devHold.get(name) || 0;
        if (now >= holdUntil) {
          const vol = typeof this._deviceVolumes[name] === 'number' ? this._deviceVolumes[name] : 0;
          sl.value = String(vol);
          const pct = sl.nextElementSibling; if (pct) pct.textContent = `${Math.round(vol*100)}%`;
        }
      });
      cont.querySelectorAll('.dev-toggle').forEach(sw => {
        const name = sw.dataset.dev;
        const should = this._currentDevices.has(name);
        if (Boolean(sw.checked) !== Boolean(should)) sw.checked = should;
      });
      return;
    }

    // Update toggle button label/visibility
    const tbtn = this.querySelector('#toggleDisabled');
    if (tbtn) {
      if (enabled.length === 0 || disabled.length === 0) {
        tbtn.style.display = 'none';
      } else {
        tbtn.style.display = '';
        tbtn.textContent = this._showDisabled ? 'Hide Disabled' : `Show Disabled (${disabled.length})`;
      }
    }

    const prevTop = cont.scrollTop, prevLeft = cont.scrollLeft;
    const frag = document.createDocumentFragment();
    for (const name of order) {
      const on = this._currentDevices.has(name);
      const vol = typeof this._deviceVolumes[name] === 'number' ? this._deviceVolumes[name] : 0;
      const el = document.createElement('div');
      el.className = 'card device';
      el.innerHTML = `
        <header>
          <div>${name}</div>
          <label class="switch" style="gap:12px;">
            <span>Enabled</span>
            <ha-switch data-dev="${name}" class="dev-toggle" ${on ? 'checked' : ''}></ha-switch>
          </label>
        </header>
        <div>
          <div class="dev-volrow">
            <button class="secondary devVolDown" data-dev="${name}" title="Volume down">−</button>
            <input type="range" min="0" max="1" step="0.01" value="${vol}" data-dev="${name}" class="dev-volume range-compact" />
            <button class="secondary devVolUp" data-dev="${name}" title="Volume up">+</button>
            <span style="margin-left:8px; opacity:.8; min-width:36px; text-align:right;">${Math.round(vol * 100)}%</span>
          </div>
        </div>`;
      frag.appendChild(el);
    }
    cont.innerHTML = '';
    cont.appendChild(frag);
    // Restore scroll position to avoid jumping to top on refresh
    try { cont.scrollTo({ left: prevLeft, top: prevTop, behavior: 'instant' }); } catch (_) { cont.scrollTop = prevTop; cont.scrollLeft = prevLeft; }

    // bind handlers
    cont.querySelectorAll('.dev-toggle').forEach(sw => {
      sw.addEventListener('change', async () => {
        try {
          sw.disabled = true;
          this._toggleDevice(sw.dataset.dev, sw.checked);
          await this._applyDevicesImmediate();
        } finally {
          sw.disabled = false;
        }
      });
    });
    cont.querySelectorAll('.dev-volume').forEach(sl => {
      sl.addEventListener('input', () => {
        const val = parseFloat(sl.value);
        const pct = sl.parentElement?.querySelector('span'); if (pct) pct.textContent = `${Math.round(val * 100)}%`;
        const name = sl.dataset.dev;
        // Set hold for this device to keep UI smooth for a short time
        this._devHold.set(name, Date.now() + 900);
        // Update local cache immediately to avoid snapping during polls
        this._deviceVolumes[name] = Math.max(0, Math.min(1, val));
        this._setDeviceVolume(name, val);
      });
    });
    cont.querySelectorAll('.devVolDown').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.dev;
        const input = btn.parentElement?.querySelector('input.dev-volume');
        if (!input) return;
        const cur = Math.max(0, Math.min(1, parseFloat(input.value) || 0));
        const next = Math.max(0, cur - 0.05);
        input.value = String(next);
        const pct = btn.parentElement?.querySelector('span'); if (pct) pct.textContent = `${Math.round(next*100)}%`;
        this._devHold.set(name, Date.now() + 900);
        this._deviceVolumes[name] = next;
        this._setDeviceVolume(name, next);
      });
    });
    cont.querySelectorAll('.devVolUp').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.dev;
        const input = btn.parentElement?.querySelector('input.dev-volume');
        if (!input) return;
        const cur = Math.max(0, Math.min(1, parseFloat(input.value) || 0));
        const next = Math.min(1, cur + 0.05);
        input.value = String(next);
        const pct = btn.parentElement?.querySelector('span'); if (pct) pct.textContent = `${Math.round(next*100)}%`;
        this._devHold.set(name, Date.now() + 900);
        this._deviceVolumes[name] = next;
        this._setDeviceVolume(name, next);
      });
    });
  }

  // ====== Browse & Search UI ======
  _setActiveSeg(id) {
    ['#segPlaylists','#segAlbums','#segArtists'].forEach(sel => {
      const el = this.querySelector(sel);
      if (!el) return;
      if (('#'+el.id) === id) el.classList.add('active'); else el.classList.remove('active');
    });
  }

  async _browseSwitch(section) {
    this._browseStack = [];
    this._browseSection = section;
    this._browsePage = 0;
    this._browseAlpha = '';
    this._setActiveSeg('#seg' + section.charAt(0).toUpperCase() + section.slice(1));
    await this._browseLoad(section);
  }

  async _browseLoad(section, arg) {
    // Update current section and reset page when transitioning
    const prevSection = this._browseSection;
    this._browseSection = section;
    if (prevSection !== section) { this._browsePage = 0; this._browseAlpha = ''; }
    const hint = this.querySelector('#browseHint');
    const list = this.querySelector('#browseList');
    const back = this.querySelector('#browseBackRow');
    if (hint) hint.textContent = '';
    if (back) back.style.display = this._browseStack.length ? '' : 'none';
    if (!list) return;
    list.innerHTML = '<div class="item"><div class="label">Loading…</div></div>';
    const token = ++this._browseReqToken;

    // Always use Home Assistant WebSocket browse/search; do not fall back to REST to avoid 404s on names with spaces
    try {
      await this._browseLoadViaHA(section, arg);
      return;
    } catch (e) {
      list.innerHTML = '<div class="item"><div class="label">Failed to load</div></div>';
      return;
    }
  }

  async _browseLoadViaHA(section, arg) {
    // Map our sections to media_player.browse_media calls
    const token = this._browseReqToken;
    const entity_id = this._entityId();
    const typeFor = (idOrSection) => {
      if (!idOrSection) return 'library';
      const s = String(idOrSection).toLowerCase();
      if (s === 'playlists' || s === 'albums' || s === 'artists') return 'library';
      if (s.startsWith('album:')) return 'album';
      if (s.startsWith('artist:')) return 'artist';
      if (s.startsWith('playlist:')) return 'playlist';
      if (s.startsWith('song:')) return 'music';
      return 'library';
    };
    const browse = async (media_content_id, overrideType) => {
      return await this._hass.callWS({
        type: 'media_player/browse_media',
        entity_id,
        media_content_id,
        media_content_type: overrideType || typeFor(media_content_id),
      });
    };

    const strip = (s, p) => s && s.startsWith(p) ? decodeURIComponent(s.slice(p.length)) : s;
    const parseSongName = (cid) => {
      if (!cid) return '';
      if (cid.startsWith('song:')) {
        let s = cid.slice(5);
        const i = s.indexOf('||');
        if (i >= 0) s = s.slice(0, i);
        try { return decodeURIComponent(s); } catch { return s; }
      }
      return cid;
    };

    // Helpers to flatten children and detect tracks
    const flattenChildren = (arr) => {
      const out = [];
      const stack = Array.isArray(arr) ? [...arr] : [];
      while (stack.length) {
        const n = stack.shift();
        if (!n) continue;
        if (Array.isArray(n.children) && n.children.length) {
          stack.push(...n.children);
        } else {
          out.push(n);
        }
      }
      return out;
    };

    const isTrack = (c) => {
      const cid = c.media_content_id || '';
      const mc = (c.media_class || '').toLowerCase();
      const title = (c.title || '').toLowerCase();
      // Real tracks should either have a song: id or explicit track class.
      if (cid.startsWith('song:')) return true;
      if (mc === 'track') return true;
      // Sometimes backends label tracks as 'music'; filter out action rows.
      if (mc.includes('music') || mc.includes('audio')) {
        if (cid.startsWith('play_') || cid.startsWith('shuffle_')) return false;
        if (title.includes('play album') || title.includes('shuffle')) return false;
        return true;
      }
      return false;
    };

    let data = null;
    if (section === 'playlists') {
      const res = await browse('playlists', 'library');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map(c => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'playlist:') }));
      this._browseCache[section] = Array.isArray(data) ? data : [];
    } else if (section === 'albums') {
      const res = await browse('albums', 'library');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map(c => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'album:') }));
      this._browseCache[section] = Array.isArray(data) ? data : [];
    } else if (section === 'artists') {
      const res = await browse('artists', 'library');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map(c => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'artist:') }));
      this._browseCache[section] = Array.isArray(data) ? data : [];
    } else if (section === 'artist_albums' && arg) {
      const res = await browse(arg, 'artist');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      children = flattenChildren(children);
      data = children.map(c => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'album:') }));
    } else if (section === 'album_tracks' && arg) {
      const res = await browse(arg, 'album');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      children = flattenChildren(children);
      data = children
        .filter(isTrack)
        .map(c => ({ id: c.media_content_id || '', name: c.title || parseSongName(c.media_content_id || '') }));
    } else if (section === 'playlist_tracks' && arg) {
      const res = await browse(arg, 'playlist');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      children = flattenChildren(children);
      data = children
        .filter(isTrack)
        .map(c => ({ id: c.media_content_id || '', name: c.title || parseSongName(c.media_content_id || '') }));
    } else if (section === 'search' && arg) {
      const res = await this._hass.callWS({
        type: 'media_player/search_media',
        entity_id,
        search_query: arg,
      });
      const result = Array.isArray(res?.result) ? res.result : [];
      const albums = [], artists = [], playlists = [], songs = [];
      for (const it of result) {
        const mc = (it.media_class || '').toLowerCase();
        const cid = it.media_content_id || '';
        if (mc === 'album') albums.push({ id: cid, name: it.title || strip(cid, 'album:') });
        else if (mc === 'artist') artists.push({ id: cid, name: it.title || strip(cid, 'artist:') });
        else if (mc === 'playlist') playlists.push({ id: cid, name: it.title || strip(cid, 'playlist:') });
        else if (mc === 'track' || mc === 'music') songs.push({ id: cid, name: it.title || parseSongName(cid) });
      }
      data = { albums, artists, playlists, songs };
      if (token !== this._browseReqToken) return; // stale
      this._browseData = { section, arg, data };
      this._renderBrowse();
      return;
    }

    if (data == null) {
      data = Array.isArray(this._browseCache[section]) ? this._browseCache[section] : [];
    }
    if (token !== this._browseReqToken) return; // stale
    this._browseData = { section, arg, data };
    this._renderBrowse();
  }

  _renderBrowse() {
    const list = this.querySelector('#browseList');
    const hint = this.querySelector('#browseHint');
    const back = this.querySelector('#browseBackRow');
    if (!list || !this._browseData) return;
    const { section, arg, data } = this._browseData;
    if (back) back.style.display = this._browseStack.length ? '' : 'none';

    // If nothing selected yet for a top category, show gentle hint and hide pager
    if (this._isTop(section) && this._browseCache[section] === null) {
      list.innerHTML = '';
      if (hint) hint.textContent = 'Choose Playlists, Albums, or Artists to begin browsing';
      const pager = this.querySelector('#browsePager'); if (pager) pager.style.display = 'none';
      return;
    }

    const mkItem = (primary, actionsHtml='', attrs='') => `
      <div class="item" ${attrs}>
        <div class="label"><span class="label-inner">${primary}</span></div>
        <div class="actions">${actionsHtml}</div>
      </div>`;

    const attr = (s) => String(s ?? '').replace(/"/g, '&quot;');
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    // Strip leading replacement char / variation selectors / zero-width / spaces / legacy emojis
    const cleanTypeIcon = (s) => String(s ?? '').replace(/^[\uFFFD\uFE0F\u200B-\u200F\u2060\s🎧💿👤📀]+\s*/u, '');
    const iconFor = (kind) => kind === 'playlist' ? 'mdi:playlist-music' : kind === 'album' ? 'mdi:album' : kind === 'artist' ? 'mdi:account-music' : '';
    const iconize = (kind, name) => {
      const n = esc(cleanTypeIcon(name));
      const ic = iconFor(kind);
      return ic ? `<ha-icon icon="${ic}" style="--mdc-icon-size:18px; margin-right:6px; vertical-align:-4px;"></ha-icon>${n}` : n;
    };
    const stripPrefix = (s, p) =>
      s && s.startsWith(p)
        ? (() => { try { return decodeURIComponent(s.slice(p.length)); } catch { return s.slice(p.length); } })()
        : s;

    const trackLabel = (idx, name) => {
      const n = esc(String(name || ''));
      if (/^\s*\d+(?:[\.)-])\s/.test(n)) return n;
      return `${String(idx).padStart(2,'0')}. ${n}`;
    };

    let html = '';
    if (section === 'playlists') {
      const items = this._getFilteredTopItems();
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach(it => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        html += mkItem(
          `${iconize('playlist', name)}`,
          `<button data-act="play" data-type="playlist" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>
           <button data-act="shuffle" data-type="playlist" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle</button>`,
          `data-act="open-playlist" data-id="${attr(id)}" data-name="${attr(name)}"`
        );
      });
      if (hint) hint.textContent = 'Play or open playlists';
      this._renderPager(items.length);
    } else if (section === 'albums') {
      const items = this._getFilteredTopItems();
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach(it => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        html += mkItem(
          `${iconize('album', name)}`,
          `<button data-act="play" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>
           <button data-act="shuffle" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle</button>`,
          `data-act="open-album" data-id="${attr(id)}" data-name="${attr(name)}"`
        );
      });
      if (hint) hint.textContent = 'Play or open albums';
      this._renderPager(items.length);
    } else if (section === 'artists') {
      const items = this._getFilteredTopItems();
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach(it => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        html += mkItem(
          `${iconize('artist', name)}`,
          `<button data-act="play" data-type="artist" data-id="${attr(id)}" data-name="${attr(name)}">Play All</button>
           <button data-act="shuffle" data-type="artist" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle All</button>`,
          `data-act="open-artist" data-id="${attr(id)}" data-name="${attr(name)}"`
        );
      });
      if (hint) hint.textContent = 'Open artist to view albums, or play whole catalog';
      this._renderPager(items.length);
    } else if (section === 'artist_albums') {
      const artistName = (arg && arg.startsWith('artist:')) ? (()=>{try{return decodeURIComponent(arg.slice(7));}catch{return arg.slice(7);}})() : (arg||'');
      html += mkItem(
        `Albums by ${artistName}`,
        `<button data-act="play" data-type="artist" data-id="${attr(arg)}" data-name="${attr(artistName)}">Play All</button>
         <button data-act="shuffle" data-type="artist" data-id="${attr(arg)}" data-name="${attr(artistName)}" class="secondary">Shuffle All</button>`
      );
      const start = this._browsePage * this._pageSize;
      const slice = (data || []).slice(start, start + this._pageSize);
      slice.forEach(it => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        html += mkItem(
          `${iconize('album', name)}`,
          `<button data-act="play" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>
           <button data-act="shuffle" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle</button>`,
          `data-act="open-album" data-id="${attr(id)}" data-name="${attr(name)}"`
        );
      });
      if (hint) hint.textContent = `Albums by ${artistName}`;
      this._renderPager((data || []).length);
    } else if (section === 'album_tracks') {
      let idx = 0;
      const albumName = (arg && arg.startsWith('album:')) ? (()=>{try{return decodeURIComponent(arg.slice(6));}catch{return arg.slice(6);}})() : (arg||'');
      html += mkItem(
        'Play album',
        `<button data-act="play" data-type="album" data-id="${attr(arg)}" data-name="${attr(albumName)}">Play</button>
         <button data-act="shuffle" data-type="album" data-id="${attr(arg)}" data-name="${attr(albumName)}" class="secondary">Shuffle</button>`
      );
      const start = this._browsePage * this._pageSize;
      const slice = (data || []).slice(start, start + this._pageSize);
      slice.forEach(it => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        idx += 1;
        const tlabel = trackLabel(idx, name);
        html += mkItem(
          `${tlabel}`,
          `<button data-act="play-track" data-id="${attr(id)}" data-kind="album" data-container="${attr(arg)}" data-name="${attr(name)}" data-idx="${idx}">Play</button>`
        );
      });
      if (hint) hint.textContent = `Tracks on ${albumName}`;
      this._renderPager((data || []).length);
    } else if (section === 'playlist_tracks') {
      let idx = 0;
      const plName = (arg && arg.startsWith('playlist:')) ? (()=>{try{return decodeURIComponent(arg.slice(9));}catch{return arg.slice(9);}})() : (arg||'');
      html += mkItem(
        'Play playlist',
        `<button data-act="play" data-type="playlist" data-id="${attr(arg)}" data-name="${attr(plName)}">Play</button>
         <button data-act="shuffle" data-type="playlist" data-id="${attr(arg)}" data-name="${attr(plName)}" class="secondary">Shuffle</button>`
      );
      const start = this._browsePage * this._pageSize;
      const slice = (data || []).slice(start, start + this._pageSize);
      slice.forEach(it => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        idx += 1;
        const tlabel = trackLabel(idx, name);
        html += mkItem(
          `${tlabel}`,
          `<button data-act="play-track" data-id="${attr(id)}" data-kind="playlist" data-container="${attr(arg)}" data-name="${attr(name)}" data-idx="${idx}">Play</button>`
        );
      });
      if (hint) hint.textContent = `Tracks in ${plName}`;
      this._renderPager((data || []).length);
    } else if (section === 'search') {
      const albums = Array.isArray(data?.albums) ? data.albums : [];
      const artists = Array.isArray(data?.artists) ? data.artists : [];
      const playlists = Array.isArray(data?.playlists) ? data.playlists : [];
      const songs = Array.isArray(data?.songs || data?.tracks) ? (data.songs || data.tracks) : [];
      const total = albums.length + artists.length + playlists.length + songs.length;
      const start = this._browsePage * this._pageSize;
      const end = start + this._pageSize;
      let shown = 0; let idx = 0;
      const addGroup = (arr, kind, heading) => {
        let addedInGroup = false;
        for (let j=0; j<arr.length; j++) {
          if (idx >= start && idx < end) {
            if (!addedInGroup && heading) { html += `<div class="hint" style="padding-top:8px;">${heading}</div>`; addedInGroup = true; }
            const it = arr[j];
            const name = typeof it === 'string' ? it : it.name;
            const id = typeof it === 'string' ? '' : it.id;
            if (kind === 'album') {
              html += mkItem(`${iconize('album', name)}`, `<button data-act="play" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>`, `data-act="open-album" data-id="${attr(id)}" data-name="${attr(name)}"`);
            } else if (kind === 'artist') {
              html += mkItem(`${iconize('artist', name)}`, `<button data-act="play" data-type="artist" data-id="${attr(id)}" data-name="${attr(name)}">Play All</button>`, `data-act="open-artist" data-id="${attr(id)}" data-name="${attr(name)}"`);
            } else if (kind === 'playlist') {
              html += mkItem(`${iconize('playlist', name)}`, `<button data-act="play" data-type="playlist" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>`, `data-act="open-playlist" data-id="${attr(id)}" data-name="${attr(name)}"`);
            } else if (kind === 'song') {
              const tlabel = trackLabel((j+1), name);
              html += mkItem(`${tlabel}`, `<button data-act="play-track" data-id="${attr(id)}" data-kind="song" data-container="" data-name="${attr(name)}" data-idx="${j+1}">Play</button>`);
            }
            shown++;
            if (shown >= this._pageSize) break;
          }
          idx++;
          if (shown >= this._pageSize) break;
        }
      };
      addGroup(albums, 'album', albums.length ? 'Albums' : ''); if (shown < this._pageSize) addGroup(artists,'artist', artists.length ? 'Artists' : '');
      if (shown < this._pageSize) addGroup(playlists,'playlist', playlists.length ? 'Playlists' : '');
      if (shown < this._pageSize) addGroup(songs,'song', songs.length ? 'Songs' : '');
      if (hint) hint.textContent = 'Search results';
      this._renderPager(total);
    }


    if (!html) {
      if (this._isTop(section)) {
        const f = this._getFilteredTopItems();
        if (!f.length) {
          list.innerHTML = '<div class="item"><div class="label">No items. Try another letter or section.</div></div>';
        } else {
          list.innerHTML = '<div class="item"><div class="label">No items on this page.</div></div>';
        }
      } else {
        list.innerHTML = '<div class="item"><div class="label">No items</div></div>';
      }
    } else {
      list.innerHTML = html;
      this._initBrowseMarquee?.();
    }
  }

  _initBrowseMarquee() {
    const rows = this.querySelectorAll('#browseList .label');
    rows.forEach(vp => {
      const inner = vp.querySelector('.label-inner');
      if (inner) this._marqueeOnce(vp, inner);
    });
  }

  _applyNowPlayingMarquee() {
    const pairs = [
      [this.querySelector('.track'), this.querySelector('#track')],
      [this.querySelector('.artist'), this.querySelector('#artist')],
      [this.querySelector('.album'), this.querySelector('#album')],
    ];
    for (const [vp, inner] of pairs) {
      if (vp && inner) this._marqueeOnce(vp, inner);
    }
  }

  _marqueeOnce(viewport, inner) {
    // reset
    inner.style.transition = 'none';
    inner.style.transform = 'translateX(0)';

    const old = this._marqTimers.get(inner);
    if (old) { clearTimeout(old); this._marqTimers.delete(inner); }

    requestAnimationFrame(() => {
      const vw = viewport.clientWidth;
      const iw = inner.scrollWidth;
      const delta = Math.max(0, iw - vw);
      if (delta <= 4) return;

      const pxPerSec = 40;      // gentle pace
      const dur = Math.max(6, delta / pxPerSec);
      const delayMs = 3000;     // 3s pause

      const startTid = setTimeout(() => {
        inner.style.transition = `transform ${dur}s linear`;
        inner.style.transform = `translateX(-${delta}px)`;
        // After scroll finishes, wait 2s then reset to the start
        const resetTid = setTimeout(() => {
          inner.style.transition = 'none';
          inner.style.transform = 'translateX(0)';
        }, Math.round(dur * 1000 + 2000));
        this._marqTimers.set(inner, resetTid);
      }, delayMs);
      this._marqTimers.set(inner, startTid);
    });
  }

  _isTop(section) { return section === 'playlists' || section === 'albums' || section === 'artists'; }

  _alphaSet(letter) {
    this._browseAlpha = letter || '';
    this._browsePage = 0;
    this._renderBrowse();
  }

  _pageSet(p) {
    // Determine item count for current section (supports sub-pages and search)
    let itemsLen = 0;
    const section = this._browseSection;
    if (this._isTop(section)) {
      itemsLen = (this._getFilteredTopItems() || []).length;
    } else if (section === 'search') {
      const d = this._browseData?.data || {};
      const albums = Array.isArray(d.albums) ? d.albums.length : 0;
      const artists = Array.isArray(d.artists) ? d.artists.length : 0;
      const playlists = Array.isArray(d.playlists) ? d.playlists.length : 0;
      const songs = Array.isArray(d.songs || d.tracks) ? (d.songs || d.tracks).length : 0;
      itemsLen = albums + artists + playlists + songs;
    } else {
      // artist_albums, album_tracks, playlist_tracks
      const arr = Array.isArray(this._browseData?.data) ? this._browseData.data : [];
      itemsLen = arr.length;
    }
    const pages = Math.max(1, Math.ceil(itemsLen / this._pageSize));
    let next = p;
    if (!isFinite(next) || next > pages - 1) next = pages - 1;
    if (next < 0) next = 0;
    this._browsePage = next;
    this._renderBrowse();
  }

  _getFilteredTopItems() {
    const section = this._browseSection;
    const baseRaw = Array.isArray(this._browseCache[section]) ? [...this._browseCache[section]] : [];
    const arr = baseRaw.map(x => (typeof x === 'string' ? { id: '', name: x } : x));
    // Remove leading emoji/punctuation/spaces before sorting and filtering
    const norm = (s) => String(s || '').replace(/^[^A-Za-z0-9]+/, '');
    arr.sort((a,b) => norm(a.name).localeCompare(norm(b.name), undefined, { sensitivity:'base' }));
    const L = (this._browseAlpha || '').toUpperCase();
    if (!L) return arr;
    if (L === '#') return arr.filter(o => !/^[A-Z]/i.test(norm(o.name).charAt(0)));
    return arr.filter(o => norm(o.name).toUpperCase().startsWith(L));
  }

  _renderPager(itemsLen) {
    const pager = this.querySelector('#browsePager');
    const alphaRow = this.querySelector('#alphaRow');
    const info = this.querySelector('#pageInfo');
    const prev = this.querySelector('#pagePrev');
    const next = this.querySelector('#pageNext');
    const first = this.querySelector('#pageFirst');
    const last = this.querySelector('#pageLast');
    if (!pager || !alphaRow || !info) return;

    pager.style.display = '';
    if (this._isTop(this._browseSection)) {
      const letters = this._computeLetters?.() || this._computeLettersPanel?.() || [];
      // If current letter no longer valid, clear selection
      if (this._browseAlpha && !letters.includes(this._browseAlpha)) this._browseAlpha = '';
      alphaRow.innerHTML = letters.map(L => `<button class="letterbtn ${this._browseAlpha===L?'active':''}" data-letter="${L}">${L}</button>`).join('');
    } else {
      alphaRow.innerHTML = '';
    }

    const pages = Math.max(1, Math.ceil(itemsLen / this._pageSize));
    const page = Math.min(this._browsePage, pages - 1);
    info.textContent = `Page ${pages ? (page+1) : 0} of ${pages}`;

    const disPrev = page <= 0;
    const disNext = page >= pages - 1;
    [prev, first].forEach(b => { if (b) b.disabled = disPrev; });
    [next, last].forEach(b => { if (b) b.disabled = disNext; });
  }

  _browseBack() {
    if (!this._browseStack.length) return;
    const prev = this._browseStack.pop();
    this._browseLoad(prev.section, prev.arg);
  }

  _browseListClick(ev) {
    const btn = ev.target.closest('button');
    if (!btn) {
      const row = ev.target.closest('.item');
      if (!row) return;
      const act = row.getAttribute('data-act');
      if (!act) return;
      const id = row.getAttribute('data-id') || '';
      const name = row.getAttribute('data-name') || '';
      if (act === 'open-album') {
        this._browseStack.push({ section: this._browseData.section, arg: this._browseData.arg });
        this._browseLoad('album_tracks', id || ('album:' + name));
      } else if (act === 'open-playlist') {
        this._browseStack.push({ section: this._browseData.section, arg: this._browseData.arg });
        this._browseLoad('playlist_tracks', id || ('playlist:' + name));
      } else if (act === 'open-artist') {
        this._browseStack.push({ section: this._browseData.section, arg: this._browseData.arg });
        this._browseLoad('artist_albums', id || ('artist:' + name));
      }
      return;
    }
    const act = btn.getAttribute('data-act');
    const id = btn.getAttribute('data-id') || '';
    const name = btn.getAttribute('data-name') || '';
    if (act === 'open-album') {
      this._browseStack.push({ section: this._browseData.section, arg: this._browseData.arg });
      this._browseLoad('album_tracks', id || ('album:' + name));
    } else if (act === 'open-playlist') {
      this._browseStack.push({ section: this._browseData.section, arg: this._browseData.arg });
      this._browseLoad('playlist_tracks', id || ('playlist:' + name));
    } else if (act === 'open-artist') {
      this._browseStack.push({ section: this._browseData.section, arg: this._browseData.arg });
      this._browseLoad('artist_albums', id || ('artist:' + name));
    } else if (act === 'play' || act === 'shuffle') {
      const type = btn.getAttribute('data-type') || 'album';
      const shuffle = act === 'shuffle';
      this._playContainer(type, name, shuffle, id);
    } else if (act === 'play-track') {
      const kind = btn.getAttribute('data-kind');
      const container = btn.getAttribute('data-container') || '';
      const idx = parseInt(btn.getAttribute('data-idx') || '0', 10) || 0;
      this._playTrack(kind, container, name, idx, id);
    }
  }

  // Build dynamic A–Z based on currently cached items for the active top section
  _computeLetters() {
    const section = this._browseSection;
    if (!this._isTop(section)) return [];
    const baseRaw = Array.isArray(this._browseCache[section]) ? [...this._browseCache[section]] : [];
    const arr = baseRaw.map(x => (typeof x === 'string' ? { id: '', name: x } : x));
    const norm = (s) => String(s || '').replace(/^[^A-Za-z0-9]+/, '');
    const set = new Set();
    for (const it of arr) {
      const n = norm(it.name);
      if (!n) continue;
      const ch = n.charAt(0).toUpperCase();
      if (ch >= 'A' && ch <= 'Z') set.add(ch); else set.add('#');
    }
    const out = [];
    if (set.has('#')) out.push('#');
    for (let c = 65; c <= 90; c++) { const L = String.fromCharCode(c); if (set.has(L)) out.push(L); }
    return out;
  }

  async _browseSearch(term) {
    this._browseStack = [];
    this._browseSection = 'search';
    await this._browseLoad('search', term);
  }

  async _playContainer(type, name, shuffle=false, idArg='') {
    const entity = this._entityId();
    const playMedia = (mcid) => this._hass.callService('media_player', 'play_media', {
      entity_id: entity,
      media_content_type: 'music',
      media_content_id: mcid,
    });
    const start = () => this._hass.callService('media_player', 'media_play', { entity_id: entity });

    if (shuffle) {
      // Special-case: "Shuffle All" for artist — use server endpoint to build shuffled queue and play
      if (type === 'artist') {
        const artistId = idArg || (name ? `artist:${name}` : '');
        const artistName = (artistId && artistId.startsWith('artist:'))
          ? (()=>{ try { return decodeURIComponent(artistId.slice(7)); } catch { return artistId.slice(7); } })()
          : (name || '');
        if (artistName) {
          await this._shuffleArtistServer(artistName);
          await this._fetchStatus();
        }
        return;
      }

      // For album/playlist, use controller-native shuffle_* IDs (these already work for you)
      const nameFromId = (id) => {
        if (!id) return '';
        if (id.startsWith('album:'))    { try { return decodeURIComponent(id.slice(6)); } catch { return id.slice(6); } }
        if (id.startsWith('playlist:')) { try { return decodeURIComponent(id.slice(9)); } catch { return id.slice(9); } }
        if (id.startsWith('artist:'))   { try { return decodeURIComponent(id.slice(7)); } catch { return id.slice(7); } }
        return '';
      };
      const baseName = (idArg && nameFromId(idArg)) || name || '';
      const sid = (type === 'playlist') ? `shuffle_playlist:${baseName}`
                : (type === 'album')    ? `shuffle_album:${baseName}`
                : '';
      if (sid) { playMedia(sid); start(); }
      return;
    }

    // Normal play: prefer exact IDs when available, then fall back by name
    if (idArg) { playMedia(idArg); start(); return; }

    const pid = (type === 'playlist') ? `play_playlist:${name}`
              : (type === 'album')    ? `play_album:${name}`
              : (type === 'artist')   ? `artist:${name}`
              : '';
    if (!pid) return;
    playMedia(pid); start();
  }

  async _shuffleArtistServer(artistName) {
    try {
      await this._apiSend('POST', 'apple_music/queue_artist_shuffled', { artist: artistName });
    } catch (_) { /* ignore */ }
  }


  _playTrack(kind, container, name, idx, idArg='') {
    if (idArg) {
      this._hass.callService('media_player', 'play_media', {
        entity_id: this._entityId(),
        media_content_type: 'music',
        media_content_id: idArg,
      });
      return;
    }
    let id = '';
    if (kind === 'album') {
      id = `song:${name}||album=${container}||idx=${idx}`;
    } else if (kind === 'playlist') {
      id = `song:${name}||playlist=${container}||idx=${idx}`;
    } else {
      id = `song:${name}`;
    }
    this._hass.callService('media_player', 'play_media', {
      entity_id: this._entityId(),
      media_content_type: 'music',
      media_content_id: id,
    });
  }


  // ====== Actions to controller ======
  _toggleDevice(name, on) {
    if (!name) return;
    if (!this._currentDevices) this._currentDevices = new Set();
    if (on) this._currentDevices.add(name); else this._currentDevices.delete(name);
  }

  async _applyDevicesImmediate() {
    const selected = Array.from(this.querySelectorAll('.dev-toggle'))
      .filter(sw => sw.checked)
      .map(sw => sw.dataset.dev);
    try {
      this._pendingApply = true;
      await this._hass.callService('apple_music', 'set_selected_airplay_devices', {
        entity_id: this._entityId(),
        devices: selected,
      });
      await this._fetchCurrentDevices();
      this._renderDevices();
    } catch (e) {
      // ignore error
    } finally {
      this._pendingApply = false;
    }
  }

  async _applyDevices() {
    const selected = Array.from(this.querySelectorAll('.dev-toggle'))
      .filter(cb => cb.checked)
      .map(cb => cb.dataset.dev);

    try {
      this._pendingApply = true;
      await this._apiSend('POST', 'apple_music/set_devices', { devices: selected });
      await this._fetchCurrentDevices();
      this._renderDevices();
    } catch (e) {
      // ignore error
    } finally {
      this._pendingApply = false;
    }
  }

  _setDeviceVolume(name, value) {
    if (!name) return;
    // debounce calls per device to avoid flooding
    if (this._debouncers.has(name)) clearTimeout(this._debouncers.get(name));
    const t = setTimeout(async () => {
      this._debouncers.delete(name);
      try {
        const level = Math.round(Math.max(0, Math.min(1, value)) * 100);
        // Update local cache immediately to avoid UI snapping during polls
        this._deviceVolumes[name] = level / 100;
        await this._hass.callService('apple_music', 'set_device_volume', {
          entity_id: this._entityId(),
          device: name,
          level,
        });
      } catch (e) { /* ignore */ }
    }, 250);
    this._debouncers.set(name, t);
  }
}

try {
  if (!customElements.get('music-controller-panel')) {
    customElements.define('music-controller-panel', MusicControllerPanel);
  }
} catch (_) { /* ignore define errors */ }

// =============================
// Lovelace Card: Now Playing
// usage in YAML: type: custom:music-now-playing-card
// optional: entity: media_player.apple_music_player
class MusicNowPlayingCard extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
    this._holdUntil = 0; // ms timestamp for volume hold
    // Token-backed artwork helpers/state
    this._lastNPKey = '';
    this._currentArtTok = '';
    this._pendingArtFetch = false;
    this._lastStatusFetchAt = 0;
  }
  setConfig(config) {
    this._config = config || {};
    if (!this._root) {
      this._root = document.createElement('div');
      this._root.style.padding = '0';
      this._root.innerHTML = `
        <style>
          ha-card { position: relative; }
          .card-header.np-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:8px 16px 0; }
          .media { display:flex; align-items:center; justify-content:center; text-align:center; gap:16px; padding:14px 16px 18px; flex-wrap: wrap; }
          /* Artwork scales within card bounds horizontally and vertically */
          .art { width: min(100%, 360px); max-width: 100%; aspect-ratio: 1 / 1; height: auto; border-radius:8px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 8%, transparent)); object-fit:cover; }
          .meta { min-width: 360px; text-align:center; flex: 1 1 360px; }
          .track { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .artist, .album { opacity:0.8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
          .controls { display:flex; gap:12px; margin-top:12px; align-items:center; justify-content:center; flex-wrap: nowrap; }
      .controls button { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; min-width:72px; }
      .controls button ha-icon { --mdc-icon-size: 26px; }
      .controls button:active { transform: scale(0.97); filter: brightness(0.95); transition: transform .06s ease, filter .06s ease; }
      
      .volrow { display:flex; gap:12px; margin-top:12px; align-items:center; }
      /* Play/Pause visual states */
      #playpause { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
      #playpause.pp-playing { background: var(--primary-color); color: #fff; }
      #playpause.pp-paused { background: #FB8C00; color: #1b1b1b; }
      #playpause.pp-idle { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          /* Shuffle visual states */
          #shuffle { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          #shuffle.active { background: var(--primary-color); color: #fff; }
          /* Slightly larger buttons in card */
          #now .controls button, #now .volrow button { padding:10px 14px; font-size:0.95rem; border-radius:10px; }
          /* Spacing between text rows */
          .track, .artist, .album { margin-bottom:6px; }
          button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
          button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          input[type="range"] { width: 100%; max-width: 560px; }
          /* Modal styles for Browse */
          .modal { position: fixed; inset: 0; display:none; align-items:center; justify-content:center; z-index: 1000; }
          .modal.show { display:flex; }
          .modal .backdrop { position:absolute; inset:0; background: var(--dialog-backdrop-color, color-mix(in srgb, var(--primary-text-color) 50%, transparent)); }
          .modal .sheet { position:relative; width: min(92vw, 860px); max-width: 860px; max-height: 80vh; margin: 0 16px; }
          .modal .close { position:absolute; top:8px; right:12px; z-index:1; }
          @keyframes pressPulseNP { 0% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary-text-color) 15%, transparent);} 50% { transform: scale(0.985); box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-text-color) 10%, transparent);} 100% { transform: scale(1); box-shadow: 0 0 0 0 color-mix(in srgb, var(--primary-text-color) 0%, transparent);} }
          .pulse { animation: pressPulseNP .18s ease-in-out; }
          .flash { background: var(--primary-color) !important; color:#fff !important; }
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
          <!-- Modal hosting a browse card instance -->
          <div id="browseModalNP" class="modal" aria-hidden="true">
            <div class="backdrop"></div>
            <div class="sheet">
              <button id="browseCloseNP" class="secondary close">✕</button>
              <music-browse-card id="embeddedBrowse"></music-browse-card>
            </div>
          </div>
        </ha-card>`;
      this.appendChild(this._root);
      // static handlers
      this._root.querySelector('#prev')?.addEventListener('click', () => this._svc('media_previous_track'));
      this._root.querySelector('#next')?.addEventListener('click', () => this._svc('media_next_track'));
      this._root.querySelector('#playpause')?.addEventListener('click', () => this._svc('media_play_pause'));
      this._root.querySelector('#shuffle')?.addEventListener('click', () => this._toggleShuffle());
      this._root.querySelector('#mvDown')?.addEventListener('click', () => this._bumpVol(-0.05));
      this._root.querySelector('#mvUp')?.addEventListener('click',   () => this._bumpVol(+0.05));
      this._root.querySelector('#masterVol')?.addEventListener('input', (e) => {
        const v = parseFloat(e.target.value);
        this._holdUntil = Date.now() + 900;
        this._setVol(v);
      });
      // Tap feedback on buttons
      this._root.addEventListener('click', (ev) => {
        const t = ev.target.closest('button');
        if (!t) return;
        t.classList.add('pulse');
        setTimeout(() => t.classList.remove('pulse'), 200);
      });
      // Browse open/close
      this._root.querySelector('#openBrowseNP')?.addEventListener('click', () => this._showBrowseNP());
      this._root.querySelector('#browseCloseNP')?.addEventListener('click', () => this._hideBrowseNP());
      this._root.querySelector('#browseModalNP .backdrop')?.addEventListener('click', () => this._hideBrowseNP());
    }
  }
  set hass(hass) {
    this._hass = hass;
    this._update();
    // propagate hass to embedded browse card if present
    const bc = this._root?.querySelector('#embeddedBrowse');
    if (bc) { try { bc.hass = hass; } catch(_){} }
  }
  getCardSize() { return 3; }
  _entityId() {
    if (this._config?.entity) return this._config.entity;
    const s = this._hass?.states || {};
    return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }
  _svc(service, data={}) {
    if (!this._hass) return;
    this._hass.callService('media_player', service, { entity_id: this._entityId(), ...data });
  }
  _setVol(level) { this._svc('volume_set', { volume_level: level }); }
  _bumpVol(delta) {
    const ent = this._hass?.states?.[this._entityId()];
    let cur = (typeof ent?.attributes?.volume_level === 'number') ? ent.attributes.volume_level : 0;
    cur = Math.max(0, Math.min(1, cur + delta));
    const slider = this._root.querySelector('#masterVol');
    if (slider) slider.value = String(cur);
    this._holdUntil = Date.now() + 900;
    this._setVol(cur);
  }
  async _update() {
    const ent = this._hass?.states?.[this._entityId()];
    if (!ent) return;
    const attrs = ent.attributes || {};
    const trackEl = this._root.querySelector('#track');
    const artistEl = this._root.querySelector('#artist');
    const albumEl = this._root.querySelector('#album');
    const nextTitle  = attrs.media_title      || (trackEl?.textContent  || '—');
    const nextArtist = attrs.media_artist     || (artistEl?.textContent || '—');
    const nextAlbum  = attrs.media_album_name || (albumEl?.textContent  || '—');
    const prevKey = this._lastNPKey || '';
    const nextKey = `${nextTitle}|${nextArtist}|${nextAlbum}`;
    this._lastNPKey = nextKey;
    if (trackEl) trackEl.textContent = nextTitle;
    if (artistEl) artistEl.textContent = nextArtist;
    if (albumEl) albumEl.textContent = nextAlbum;
    const vol = (typeof attrs.volume_level === 'number') ? attrs.volume_level : 0;
    const volEl = this._root.querySelector('#masterVol');
    if (volEl && Date.now() >= this._holdUntil) volEl.value = String(vol);
    // Prefer token-backed artwork like the panel does; fall back to entity_picture
    try {
      const tok = await this._fetchArtworkTokenThrottled();
      if (tok) {
        await this._setArtworkToken(tok);
      } else {
        // If no token available, refresh current artwork directly on track change,
        // otherwise use entity_picture for immediate display if provided.
        const artEl = this._root.querySelector('#art');
        const hasBlob = !!(artEl && artEl.dataset && artEl.dataset.blobUrl);
        if (nextKey !== prevKey) {
          await this._refreshCurrentArtworkNoToken();
        } else if (!hasBlob) {
          const artUrl = attrs.entity_picture_local || attrs.entity_picture;
          if (artEl && artUrl) artEl.src = artUrl;
          // If no artUrl and we already have a blob, keep current image.
        }
      }
    } catch (_) {
      // On any error, fall back to entity_picture if we don't already have a blob
      const artEl = this._root.querySelector('#art');
      const hasBlob = !!(artEl && artEl.dataset && artEl.dataset.blobUrl);
      if (!hasBlob && artEl) {
        const artUrl = attrs.entity_picture_local || attrs.entity_picture;
        if (artUrl) artEl.src = artUrl;
      }
    }
    await this._syncShuffleButton();
    try {
      const st = (ent && ent.state) ? String(ent.state).toLowerCase() : '';
      const btn = this._root.querySelector('#playpause');
      if (btn) { btn.classList.remove('pp-playing','pp-paused','pp-idle'); if (st==='playing') btn.classList.add('pp-playing'); else if (st==='paused') btn.classList.add('pp-paused'); else btn.classList.add('pp-idle'); }
    } catch (_) {}
  }

  async _toggleShuffle() {
    try {
      const st = await this._hass.callApi('GET', 'apple_music/status');
      const cur = !!(st?.shuffle ?? st?.is_shuffle ?? st?.player?.shuffle);
      await this._hass.callApi('POST', 'apple_music/shuffle', { enabled: !cur });
    } catch (_) { /* ignore */ }
    await this._syncShuffleButton();
  }

  async _syncShuffleButton() {
    const btn = this._root.querySelector('#shuffle');
    if (!btn) return;
    try {
      const st = await this._hass.callApi('GET', 'apple_music/status');
      const isShuffle = !!(st?.shuffle ?? st?.is_shuffle ?? st?.player?.shuffle);
      btn.classList.toggle('active', !!isShuffle);
    } catch (e) { /* ignore */ }
  }

  _showBrowseNP() {
    const modal = this._root.querySelector('#browseModalNP');
    if (!modal) return;
    // lazily configure embedded browse card once
    const bc = this._root.querySelector('#embeddedBrowse');
    if (bc && !bc._configured) {
      try { bc.setConfig({ title: 'Browse & Search' }); bc._configured = true; } catch(_){}
      if (this._hass) { try { bc.hass = this._hass; } catch(_){} }
    }
    modal.classList.add('show');
  }
  _hideBrowseNP() {
    const modal = this._root.querySelector('#browseModalNP');
    if (!modal) return;
    modal.classList.remove('show');
  }
}
try {
  if (!customElements.get('music-now-playing-card')) {
    customElements.define('music-now-playing-card', MusicNowPlayingCard);
  }
} catch (_) { /* ignore define errors */ }

// === Token-backed artwork helpers for MusicNowPlayingCard ===
MusicNowPlayingCard.prototype._signedPath = function(path) {
  try {
    if (this._hass && this._hass.callWS) {
      return this._hass
        .callWS({ type: 'auth/sign_path', path, expires: 60 })
        .then((resp) => (resp && typeof resp.path === 'string' && resp.path) ? resp.path : path)
        .catch(() => path);
    }
  } catch (_) {}
  return Promise.resolve(path);
};
MusicNowPlayingCard.prototype._artCacheKey = function(tok){ return `https://am-art.local/art/${encodeURIComponent(tok)}`; };
MusicNowPlayingCard.prototype._getArtCache = async function(){ try { return await caches.open('apple_music_artwork'); } catch(_) { return null; } };
MusicNowPlayingCard.prototype._loadArtFromCache = async function(tok){
  try { const cache = await this._getArtCache(); if (!cache) return null; const req = new Request(this._artCacheKey(tok)); const resp = await cache.match(req); return resp || null; } catch(_) { return null; }
};
MusicNowPlayingCard.prototype._fetchAndCacheArt = async function(tok){
  const path = `/api/apple_music/artwork?tok=${encodeURIComponent(tok)}`;
  const url = await this._signedPath(path).catch(()=>path);
  let resp = null;
  try { resp = await fetch(url, { cache: 'no-store' }); } catch(_) { resp = null; }
  if (resp && resp.ok) {
    try { const cache = await this._getArtCache(); if (cache) { await cache.put(new Request(this._artCacheKey(tok)), resp.clone()); } } catch(_){}
    return resp;
  }
  return null;
};
MusicNowPlayingCard.prototype._setArtworkToken = async function(tok) {
  try {
    if (!tok) return;
    this._currentArtTok = tok;
    const artEl = this._root?.querySelector('#art'); if (!artEl) return;
    // Try cache first
    let resp = await this._loadArtFromCache(tok);
    if (!resp) resp = await this._fetchAndCacheArt(tok);
    if (!resp) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const tmp = new Image();
    tmp.onload = () => {
      if (this._currentArtTok === tok) {
        const prev = artEl.dataset.blobUrl;
        artEl.src = url;
        artEl.dataset.blobUrl = url;
        if (prev && prev !== url) { try { URL.revokeObjectURL(prev); } catch(_){} }
      } else {
        try { URL.revokeObjectURL(url); } catch(_){}
      }
    };
    tmp.onerror = () => { try { URL.revokeObjectURL(url); } catch(_){} };
    tmp.src = url;
  } catch (_) { /* ignore */ }
};
MusicNowPlayingCard.prototype._refreshCurrentArtworkNoToken = async function() {
  if (this._pendingArtFetch) return;
  this._pendingArtFetch = true;
  try {
    const base = '/api/apple_music/artwork';
    const fetchOnce = async (u) => {
      const url = await this._signedPath(u).catch(()=>u);
      const r = await fetch(url || u, { cache: 'no-store', credentials: 'same-origin' });
      if (!r || !r.ok) throw new Error('artwork fetch failed');
      return r.blob();
    };
    let blob;
    try { blob = await fetchOnce(base); }
    catch (_) { blob = await fetchOnce(base + '?refresh=1'); }
    const artEl = this._root?.querySelector('#art');
    if (artEl && blob) {
      const url = URL.createObjectURL(blob);
      const prev = artEl.dataset.blobUrl;
      artEl.src = url;
      artEl.dataset.blobUrl = url;
      if (prev && prev !== url) { try { URL.revokeObjectURL(prev); } catch(_){} }
    }
  } catch(_) { /* ignore */ }
  finally { this._pendingArtFetch = false; }
};
MusicNowPlayingCard.prototype._fetchArtworkTokenThrottled = async function() {
  const now = Date.now();
  if ((now - this._lastStatusFetchAt) < 1200 && this._lastArtTokCached !== undefined) {
    return this._lastArtTokCached || '';
  }
  this._lastStatusFetchAt = now;
  try {
    const st = await this._hass.callApi('GET', 'apple_music/status');
    const tok = (st && (st.artwork_token || st.token)) ? String(st.artwork_token || st.token) : '';
    this._lastArtTokCached = tok;
    return tok;
  } catch(_) {
    this._lastArtTokCached = '';
    return '';
  }
};

// =============================
// Lovelace Card: AirPlay Outputs
// usage in YAML: type: custom:music-airplay-outputs-card
class MusicAirplayOutputsCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = {};
    this._devices = [];
    this._current = new Set();
    this._vols = {};
    this._deb = new Map();
    this._pending = false;
    this._poll = null;
    this._showDisabled = false;
    this._hold = new Map(); // device -> hold-until ms
    // SSE support for instant updates
    this._es = null;
    this._sseHealthy = false;
    this._sseBackoff = 1000;
  }
  setConfig(config) {
    this._config = config || {};
    if (!this._root) {
      this._root = document.createElement('div');
      this._root.style.padding = '0';
      this._root.innerHTML = `
        <style>
          .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding:0 16px; }
          .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap:16px; padding:0 16px 16px; }
          .card { border-radius:12px; background: var(--card-background-color, Canvas); box-shadow: var(--ha-card-box-shadow, none); padding:16px; }
          .device { display:flex; flex-direction:column; gap:8px; }
          .switch { display:flex; align-items:center; gap:8px; }
          input[type="range"] { width: 100%; }
          .dev-volrow { display:grid; grid-template-columns: auto 1fr auto auto; gap:8px; align-items:center; }
          button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
          button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
        </style>
        <ha-card header="${this._config.title || 'AirPlay Outputs'}">
          <div class="head">
            <div style="display:flex; gap:8px;">
              <button id="toggleDisabled" class="secondary" style="display:none;">Show Disabled</button>
            </div>
            <div style="display:flex; gap:8px;">
              <button id="refresh" class="secondary">Refresh</button>
            </div>
          </div>
          <div id="grid" class="grid"></div>
        </ha-card>`;
      this.appendChild(this._root);
      this._root.querySelector('#refresh')?.addEventListener('click', () => this._refresh(true));
      this._root.querySelector('#toggleDisabled')?.addEventListener('click', () => {
        this._showDisabled = !this._showDisabled;
        this._render();
      });
    }
  }
  connectedCallback() {
    // start polling when attached
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    // Start with a moderate poll; will slow down when SSE connects
    this._poll = setInterval(() => this._refresh(), 5000);
    // Bootstrap immediately
    this._refresh(true);
    // Connect SSE for push updates
    this._connectSSE();
  }
  disconnectedCallback() {
    if (this._poll) { clearInterval(this._poll); this._poll = null; }
    for (const t of this._deb.values()) clearTimeout(t);
    this._deb.clear();
    try { this._es && this._es.close(); } catch(_){}
    this._es = null;
  }
  set hass(hass) {
    this._hass = hass;
    // initial render happens on first refresh
  }
  getCardSize() { return 6; }

  _entityId() {
    if (this._config?.entity) return this._config.entity;
    const s = this._hass?.states || {};
    return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }

  async _apiGet(path) { return await this._hass.callApi('GET', path); }
  async _apiSend(method, path, body) { return await this._hass.callApi(method, path, body); }

  async _refresh(force=false) {
    try {
      await Promise.all([
        this._fetchDevices(force),
        this._fetchCurrent(),
        this._fetchVolumes(),
      ]);
      this._render();
    } catch (e) { /* ignore */ }
  }

  async _fetchDevices(force=false) {
    if (this._devices.length && !force) return;
    try {
      const list = await this._apiGet('apple_music/devices');
      this._devices = Array.isArray(list) ? list : (Array.isArray(list?.devices) ? list.devices : []);
    } catch (e) { /* ignore */ }
  }
  async _fetchCurrent() {
    try {
      const cur = await this._apiGet('apple_music/current_devices');
      const arr = Array.isArray(cur) ? cur : (cur?.devices || []);
      if (!this._pending) this._current = new Set(arr);
    } catch (e) { /* ignore */ }
  }
  async _fetchVolumes() {
    try {
      const vols = await this._apiGet('apple_music/device_volumes');
      if (vols && typeof vols === 'object') {
        const n = {};
        for (const [k, v] of Object.entries(vols)) {
          let val = Number(v);
          if (!isFinite(val)) continue;
          if (val > 1.5) val = val / 100;
          if (val < 0) val = 0; if (val > 1) val = 1;
          n[k] = val;
        }
        this._vols = n;
      }
    } catch (e) { /* ignore */ }
  }

  // === SSE integration for instant UI updates ===
  _connectSSE() {
    try {
      // Avoid opening when backgrounded; polling remains as backup
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const open = (path) => {
        if (this._es) { try { this._es.close(); } catch(_){} this._es = null; }
        const es = new EventSource(path || '/api/apple_music/events');
        this._es = es;
        es.onopen = () => {
          this._sseBackoff = 1000;
          this._sseHealthy = true;
          // Slow down polling to a light watchdog
          if (this._poll) { clearInterval(this._poll); this._poll = null; }
          this._poll = setInterval(() => this._refresh(), 60000);
        };
        es.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            this._handleSSE(msg);
            this._sseHealthy = true;
          } catch (_) {}
        };
        es.onerror = () => {
          try { this._es && this._es.close(); } catch(_){}
          this._es = null;
          this._sseHealthy = false;
          // Resume faster poll until SSE reconnects
          if (this._poll) { clearInterval(this._poll); this._poll = null; }
          this._poll = setInterval(() => this._refresh(), 5000);
          const wait = Math.min(30000, Math.max(1000, this._sseBackoff || 1000));
          this._sseBackoff = Math.min(30000, wait * 2);
          setTimeout(() => { try { this._connectSSE(); } catch(_){} }, wait);
        };
      };

      if (this._hass && this._hass.callWS) {
        const path = '/api/apple_music/events';
        this._hass.callWS({ type: 'auth/sign_path', path, expires: 60 })
          .then((resp) => { const p = (resp && resp.path) ? resp.path : path; open(p); })
          .catch(() => open(path));
        return;
      }
      open('/api/apple_music/events');
    } catch (_) {
      // keep polling
    }
  }

  _handleSSE(msg) {
    const ev = (msg && msg.event) || '';
    const data = msg && msg.data;
    if (ev === 'airplay_full') {
      try {
        const names = Array.isArray(data) ? data.map(d => d.name) : [];
        this._devices = names;
        this._current = new Set((data||[]).filter(d => d.active).map(d => d.name));
        const v = {};
        (data||[]).forEach(d => { if (typeof d.volume === 'number') v[d.name] = Math.max(0, Math.min(1, d.volume/100)); });
        this._vols = v;
        this._render();
      } catch(_) {}
      return;
    }
    if (ev === 'current_devices' || ev === 'selected_devices') {
      try {
        const arr = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
        const names = arr.map(d => (typeof d === 'string') ? d : (d && (d.name || d.device))).filter(Boolean);
        this._current = new Set(names);
        this._render();
      } catch(_) {}
      return;
    }
    if (ev === 'device_volumes' || ev === 'devices_volume' || ev === 'per_device_volume') {
      try {
        const norm = {};
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          for (const [k,v] of Object.entries(data)) {
            let val = Number(v);
            if (!isFinite(val)) continue; if (val > 1.5) val = val/100; if (val < 0) val = 0; if (val > 1) val = 1;
            norm[k] = val;
          }
        } else if (Array.isArray(data)) {
          for (const it of data) {
            const name = it && (it.name || it.device);
            let val = Number((it && (it.volume ?? it.level)) ?? NaN);
            if (!name || !isFinite(val)) continue; if (val > 1.5) val = val/100; if (val < 0) val = 0; if (val > 1) val = 1;
            norm[name] = val;
          }
        }
        if (Object.keys(norm).length) {
          this._vols = { ...this._vols, ...norm };
          this._render();
        }
      } catch(_) {}
      return;
    }
  }

  _render() {
    const grid = this._root.querySelector('#grid');
    if (!grid) return;
    const prevTop = grid.scrollTop, prevLeft = grid.scrollLeft;
    const now = Date.now();
    const enabled = this._devices.filter(n => this._current.has(n));
    const disabled = this._devices.filter(n => !this._current.has(n));
    const showAll = (enabled.length === 0) || this._showDisabled;
    const order = showAll ? [...enabled, ...disabled] : enabled;

    const tbtn = this._root.querySelector('#toggleDisabled');
    if (tbtn) {
      if (enabled.length === 0 || disabled.length === 0) {
        tbtn.style.display = 'none';
      } else {
        tbtn.style.display = '';
        tbtn.textContent = this._showDisabled ? 'Hide Disabled' : `Show Disabled (${disabled.length})`;
      }
    }

    // If any device is being adjusted, update in place instead of rebuilding DOM
    const anyHeld = Array.from(this._hold.values()).some(t => now < t) || this._pending;
    if (anyHeld) {
      grid.querySelectorAll('.dev-volume').forEach(sl => {
        const name = sl.dataset.dev;
        const holdUntil = this._hold.get(name) || 0;
        if (now >= holdUntil) {
          const vol = typeof this._vols[name] === 'number' ? this._vols[name] : 0;
          sl.value = String(vol);
          const pct = sl.nextElementSibling; if (pct) pct.textContent = `${Math.round(vol*100)}%`;
        }
      });
      grid.querySelectorAll('.dev-toggle').forEach(sw => {
        const name = sw.dataset.dev;
        const should = this._current.has(name);
        if (Boolean(sw.checked) !== Boolean(should)) sw.checked = should;
      });
      return;
    }

    const frag = document.createDocumentFragment();
    for (const name of order) {
      const on = this._current.has(name);
      const vol = typeof this._vols[name] === 'number' ? this._vols[name] : 0;
      const el = document.createElement('div');
      el.className = 'card device';
      el.innerHTML = `
        <header style="display:flex; align-items:center; justify-content:space-between;">
          <div>${name}</div>
          <label class="switch" style="gap:12px;">
            <span>Enabled</span>
            <ha-switch data-dev="${name}" class="dev-toggle" ${on ? 'checked' : ''}></ha-switch>
          </label>
        </header>
        <div>
          <div class="dev-volrow">
            <button class="secondary devVolDown" data-dev="${name}" title="Volume down">−</button>
            <input type="range" min="0" max="1" step="0.01" value="${vol}" data-dev="${name}" class="dev-volume range-compact" />
            <button class="secondary devVolUp" data-dev="${name}" title="Volume up">+</button>
            <span style="margin-left:8px; opacity:.8; min-width:36px; text-align:right;">${Math.round(vol * 100)}%</span>
          </div>
        </div>`;
      frag.appendChild(el);
    }
    grid.innerHTML = '';
    grid.appendChild(frag);
    try { grid.scrollTo({ left: prevLeft, top: prevTop, behavior: 'instant' }); } catch (_) { grid.scrollTop = prevTop; grid.scrollLeft = prevLeft; }

    grid.querySelectorAll('.dev-toggle').forEach(sw => {
      sw.addEventListener('change', async () => {
        try {
          sw.disabled = true;
          this._toggle(sw.dataset.dev, sw.checked);
          await this._apply();
        } finally {
          sw.disabled = false;
        }
      });
    });
    grid.querySelectorAll('.dev-volume').forEach(sl => {
      sl.addEventListener('input', () => {
        const val = parseFloat(sl.value);
        const pct = sl.parentElement?.querySelector('span'); if (pct) pct.textContent = `${Math.round(val * 100)}%`;
        const name = sl.dataset.dev;
        this._hold.set(name, Date.now() + 900);
        this._vols[name] = Math.max(0, Math.min(1, val));
        this._setVol(name, val);
      });
    });
    grid.querySelectorAll('.devVolDown').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.dev;
        const input = btn.parentElement?.querySelector('input.dev-volume');
        if (!input) return;
        const cur = Math.max(0, Math.min(1, parseFloat(input.value) || 0));
        const next = Math.max(0, cur - 0.05);
        input.value = String(next);
        const pct = btn.parentElement?.querySelector('span'); if (pct) pct.textContent = `${Math.round(next*100)}%`;
        this._hold.set(name, Date.now() + 900);
        this._vols[name] = next;
        this._setVol(name, next);
      });
    });
    grid.querySelectorAll('.devVolUp').forEach(btn => {
      btn.addEventListener('click', () => {
        const name = btn.dataset.dev;
        const input = btn.parentElement?.querySelector('input.dev-volume');
        if (!input) return;
        const cur = Math.max(0, Math.min(1, parseFloat(input.value) || 0));
        const next = Math.min(1, cur + 0.05);
        input.value = String(next);
        const pct = btn.parentElement?.querySelector('span'); if (pct) pct.textContent = `${Math.round(next*100)}%`;
        this._hold.set(name, Date.now() + 900);
        this._vols[name] = next;
        this._setVol(name, next);
      });
    });
  }

  _toggle(name, on) {
    if (!name) return;
    if (!this._current) this._current = new Set();
    if (on) this._current.add(name); else this._current.delete(name);
  }

  async _apply() {
    const selected = Array.from(this._root.querySelectorAll('.dev-toggle'))
      .filter(sw => sw.checked)
      .map(sw => sw.dataset.dev);
    try {
      this._pending = true;
      await this._hass.callService('apple_music', 'set_selected_airplay_devices', {
        entity_id: this._entityId(),
        devices: selected,
      });
      await this._fetchCurrent();
      this._render();
    } catch (e) { /* ignore */ } finally { this._pending = false; }
  }

  _setVol(name, value) {
    if (!name) return;
    if (this._deb.has(name)) clearTimeout(this._deb.get(name));
    const t = setTimeout(async () => {
      this._deb.delete(name);
      try {
        const level = Math.round(Math.max(0, Math.min(1, value)) * 100);
        this._vols[name] = level / 100;
        await this._hass.callService('apple_music', 'set_device_volume', {
          entity_id: this._entityId(),
          device: name,
          level,
        });
      } catch (e) { /* ignore */ }
    }, 250);
    this._deb.set(name, t);
  }
}
try {
  if (!customElements.get('music-airplay-outputs-card')) {
    customElements.define('music-airplay-outputs-card', MusicAirplayOutputsCard);
  }
} catch (_) { /* ignore define errors */ }

// =============================
// Lovelace Card: Browse & Search
// usage in YAML: type: custom:music-browse-card
// optional: entity: media_player.apple_music_player
class MusicBrowseCard extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._config = {};
    // browse/search state
    this._browseSection = 'playlists';
    this._browseStack = [];
    this._browseData = null;
    this._browseCache = { playlists: null, albums: null, artists: null }; // null until first click
    this._browsePage = 0;
    this._pageSize = 5;
    this._browseAlpha = '';
    this._browseReqToken = 0;
    this._preferWS = true;
    this._marqTimers = new WeakMap();
  }

  setConfig(config) {
    this._config = config || {};
    if (!this._root) {
      this._root = document.createElement('div');
      this._root.style.padding = '0';
      this._root.innerHTML = `
        <style>
          .constrain { width:100%; max-width: clamp(320px, 92vw, 860px); margin: 0 auto; }
          .toolbar { display:flex; gap:12px; align-items:center; justify-content:space-between; padding:12px 16px 0; flex-wrap: wrap; }
          .seg { display:flex; gap:6px; flex-wrap:wrap; }
          .segbtn { cursor:pointer; border:none; border-radius:12px; padding:6px 10px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          .segbtn.active { background: var(--primary-color); color:#fff; }
          .search { display:flex; gap:8px; align-items:center; flex: 1 1 240px; justify-content:flex-end; }
          .search input[type="search"] { flex: 1 1 180px; max-width: 320px; border-radius:8px; border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); background: transparent; color: var(--primary-text-color, CanvasText); padding:6px 10px; }
          .hint { opacity:.7; padding:4px 16px 0; }
          .browse-inner { display:flex; flex-direction:column; max-height: clamp(360px, 60vh, 540px); }
          .list { padding:8px 16px 16px; display:grid; gap:8px; flex:1 1 auto; overflow:auto; max-width:100%; overflow-x:hidden; }
          .item { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 12px; border-radius:10px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); cursor:pointer; min-height:56px; height:56px; box-sizing:border-box; overflow:hidden; }
          .item[data-act] { border:1px solid var(--divider-color, color-mix(in srgb, var(--primary-text-color) 25%, transparent)); transition: background .15s ease, transform .02s ease-in; }
          .item[data-act]:hover { background: color-mix(in srgb, var(--card-background-color) 94%, var(--primary-text-color) 6%); }
          .item[data-act]:hover { background: color-mix(in srgb, var(--card-background-color) 94%, var(--primary-text-color) 6%); }
          .item[data-act]:active { transform: translateY(1px); }
          .label { position:relative; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex: 1 1 0; min-width:0; }
          .label-inner { display:inline-block; will-change: transform; transform: translateX(0); }
          .actions { display:flex; gap:8px; flex: 0 0 auto; flex-wrap: nowrap; justify-content:flex-end; align-items:center; }
          .item * { min-width:0; }
          .actions button { white-space: nowrap; }
          button { cursor:pointer; border:none; border-radius:8px; padding:8px 12px; background: var(--primary-color); color:#fff; }
          button.secondary { background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); }
          .pager { display:flex; flex-direction:column; gap:10px; padding:0 16px 16px; }
          .pager .letters { display:flex; gap:6px; overflow:auto; -webkit-overflow-scrolling: touch; padding-bottom:4px; }
          .pager .letters .letterbtn { flex:0 0 auto; cursor:pointer; border:none; border-radius:999px; padding:4px 8px; background: var(--secondary-background-color, color-mix(in srgb, var(--primary-text-color) 12%, transparent)); color: var(--primary-text-color, CanvasText); font-size:12px; }
          .pager .letters .letterbtn.active { background: var(--primary-color); color:#fff; }
          .pager .pn { display:flex; align-items:center; gap:8px; }
          .pager .pn .info { opacity:.8; }
          .pager .pn button[disabled] { opacity:.5; cursor:not-allowed; }
        </style>
        <ha-card header="${this._config.title || 'Browse & Search'}">
          <div class="constrain">
            <div class="toolbar">
              <div class="seg">
                <button id="segPlaylists" class="segbtn">Playlists</button>
                <button id="segAlbums" class="segbtn">Albums</button>
                <button id="segArtists" class="segbtn">Artists</button>
              </div>
              <form id="searchForm" class="search">
                <input id="searchInput" type="search" placeholder="Search…" />
                <button id="searchBtn" type="submit" class="secondary">Search</button>
              </form>
            </div>
            <div class="browse-inner">
              <div id="browseHint" class="hint"></div>
              <div id="browseList" class="list"></div>
              <div id="browsePager" class="pager" style="display:none;">
                <div id="alphaRow" class="letters"></div>
                <div class="pn">
                  <button id="pageFirst" class="secondary">«</button>
                  <button id="pagePrev" class="secondary">‹ Prev</button>
                  <span id="pageInfo" class="info"></span>
                  <button id="pageNext" class="secondary">Next ›</button>
                  <button id="pageLast" class="secondary">»</button>
                </div>
              </div>
              <div id="browseBackRow" class="backrow" style="display:none; padding:0 16px 16px;">
                <button id="browseBack" class="secondary">← Back</button>
              </div>
            </div>
          </div>
        </ha-card>`;
      this.appendChild(this._root);

      // wire static handlers
      this._root.querySelector('#segPlaylists')?.addEventListener('click', () => this._browseSwitch('playlists'));
      this._root.querySelector('#segAlbums')?.addEventListener('click', () => this._browseSwitch('albums'));
      this._root.querySelector('#segArtists')?.addEventListener('click', () => this._browseSwitch('artists'));
      this._root.querySelector('#searchForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const term = this._root.querySelector('#searchInput')?.value?.trim() || '';
        if (term) this._browseSearch(term);
      });
      this._root.querySelector('#browseBack')?.addEventListener('click', () => this._browseBack());
      this._root.querySelector('#browseList')?.addEventListener('click', (ev) => this._browseListClick(ev));
      // Pager controls (delegate for robustness)
      const pager = this._root.querySelector('#browsePager');
      pager?.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        const id = b.id;
        if (id === 'pageFirst') this._pageSet(0);
        else if (id === 'pagePrev') this._pageSet(this._browsePage - 1);
        else if (id === 'pageNext') this._pageSet(this._browsePage + 1);
        else if (id === 'pageLast') this._pageSet(Number.POSITIVE_INFINITY);
      });
      this._root.querySelector('#alphaRow')?.addEventListener('click', (ev) => {
        const b = ev.target.closest('.letterbtn');
        if (!b) return; this._alphaSet(b.dataset.letter || '');
      });
    }
  }

  set hass(hass) {
    this._hass = hass;
    // no auto-load; show hint until user picks a section
    if (this._root && this._browseCache.playlists === null && this._browseCache.albums === null && this._browseCache.artists === null) {
      const hint = this._root.querySelector('#browseHint');
      if (hint) hint.textContent = 'Choose Playlists, Albums, or Artists to begin browsing';
    }
  }

  getCardSize() { return 6; }
  _entityId() {
    if (this._config?.entity) return this._config.entity;
    const s = this._hass?.states || {};
    return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }
  _mpService(service, data={}) { this._hass?.callService('media_player', service, { entity_id: this._entityId(), ...data }); }

  async _browseSwitch(section) {
    this._browseStack = [];
    this._browseSection = section;
    this._browsePage = 0;
    this._browseAlpha = '';
    this._setActiveSeg('#seg' + section.charAt(0).toUpperCase() + section.slice(1));
    await this._browseLoad(section);
  }

  _setActiveSeg(id) {
    ['#segPlaylists','#segAlbums','#segArtists'].forEach(sel => {
      const el = this._root.querySelector(sel);
      if (!el) return; if (('#'+el.id) === id) el.classList.add('active'); else el.classList.remove('active');
    });
  }

  async _browseLoad(section, arg) {
    // Update active section; reset pagination on transition
    const prev = this._browseSection;
    this._browseSection = section;
    if (prev !== section) { this._browsePage = 0; this._browseAlpha = ''; }
    const list = this._root.querySelector('#browseList');
    const back = this._root.querySelector('#browseBackRow');
    const hint = this._root.querySelector('#browseHint');
    if (hint) hint.textContent = '';
    if (back) back.style.display = this._browseStack.length ? '' : 'none';
    if (!list) return;
    list.innerHTML = '<div class="item"><div class="label">Loading…</div></div>';
    this._browseReqToken++;
    try {
      await this._browseLoadViaHA(section, arg);
    } catch (e) {
      list.innerHTML = '<div class="item"><div class="label">Failed to load</div></div>';
    }
  }

  async _browseLoadViaHA(section, arg) {
    const token = this._browseReqToken;
    const entity_id = this._entityId();
    const typeFor = (idOrSection) => {
      if (!idOrSection) return 'library';
      const s = String(idOrSection).toLowerCase();
      if (s === 'playlists' || s === 'albums' || s === 'artists') return 'library';
      if (s.startsWith('album:')) return 'album';
      if (s.startsWith('artist:')) return 'artist';
      if (s.startsWith('playlist:')) return 'playlist';
      if (s.startsWith('song:')) return 'music';
      return 'library';
    };
    const browse = async (media_content_id, overrideType) => {
      return await this._hass.callWS({ type: 'media_player/browse_media', entity_id, media_content_id, media_content_type: overrideType || typeFor(media_content_id) });
    };

    const strip = (s, p) => s && s.startsWith(p) ? decodeURIComponent(s.slice(p.length)) : s;
    const parseSongName = (cid) => {
      if (!cid) return ''; if (cid.startsWith('song:')) { let s = cid.slice(5); const i = s.indexOf('||'); if (i>=0) s = s.slice(0,i); try { return decodeURIComponent(s); } catch { return s; } } return cid;
    };
    const flattenChildren = (arr) => { const out=[]; const stack=Array.isArray(arr)?[...arr]:[]; while(stack.length){ const n=stack.shift(); if(!n) continue; if(Array.isArray(n.children)&&n.children.length){ stack.push(...n.children);} else { out.push(n);} } return out; };
    const isTrack = (c) => { const cid=c.media_content_id||''; const mc=(c.media_class||'').toLowerCase(); const title=(c.title||'').toLowerCase(); if (cid.startsWith('song:')) return true; if (mc==='track') return true; if (mc.includes('music')||mc.includes('audio')) { if (cid.startsWith('play_')||cid.startsWith('shuffle_')) return false; if (title.includes('play album')||title.includes('shuffle')) return false; return true;} return false; };

    let data=null;
    if (section==='playlists') {
      const res = await browse('playlists','library');
      let children = Array.isArray(res?.children)?res.children:[]; if(!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map(c=>({ id:c.media_content_id||'', name:c.title||strip(c.media_content_id||'','playlist:') }));
      this._browseCache[section] = Array.isArray(data)?data:[];
    } else if (section==='albums') {
      const res = await browse('albums','library');
      let children = Array.isArray(res?.children)?res.children:[]; if(!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map(c=>({ id:c.media_content_id||'', name:c.title||strip(c.media_content_id||'','album:') }));
      this._browseCache[section] = Array.isArray(data)?data:[];
    } else if (section==='artists') {
      const res = await browse('artists','library');
      let children = Array.isArray(res?.children)?res.children:[]; if(!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map(c=>({ id:c.media_content_id||'', name:c.title||strip(c.media_content_id||'','artist:') }));
      this._browseCache[section] = Array.isArray(data)?data:[];
    } else if (section==='artist_albums' && arg) {
      const res = await browse(arg,'artist'); let children = Array.isArray(res?.children)?res.children:[]; if(!children.length && Array.isArray(res?.items)) children=res.items; children=flattenChildren(children);
      data = children.map(c=>({ id:c.media_content_id||'', name:c.title||strip(c.media_content_id||'','album:') }));
    } else if (section==='album_tracks' && arg) {
      const res = await browse(arg,'album'); let children = Array.isArray(res?.children)?res.children:[]; if(!children.length && Array.isArray(res?.items)) children=res.items; children=flattenChildren(children);
      data = children.filter(isTrack).map(c=>({ id:c.media_content_id||'', name:c.title||parseSongName(c.media_content_id||'') }));
    } else if (section==='playlist_tracks' && arg) {
      const res = await browse(arg,'playlist'); let children = Array.isArray(res?.children)?res.children:[]; if(!children.length && Array.isArray(res?.items)) children=res.items; children=flattenChildren(children);
      data = children.filter(isTrack).map(c=>({ id:c.media_content_id||'', name:c.title||parseSongName(c.media_content_id||'') }));
    } else if (section==='search' && arg) {
      const res = await this._hass.callWS({ type:'media_player/search_media', entity_id, search_query: arg });
      const result = Array.isArray(res?.result)?res.result:[];
      const albums=[], artists=[], playlists=[], songs=[];
      for (const it of result) {
        const mc=(it.media_class||'').toLowerCase(); const cid=it.media_content_id||'';
        if (mc==='album') albums.push({ id:cid, name: it.title || strip(cid,'album:') });
        else if (mc==='artist') artists.push({ id:cid, name: it.title || strip(cid,'artist:') });
        else if (mc==='playlist') playlists.push({ id:cid, name: it.title || strip(cid,'playlist:') });
        else if (mc==='track' || mc==='music') songs.push({ id:cid, name: it.title || parseSongName(cid) });
      }
      data = { albums, artists, playlists, songs };
      if (token !== this._browseReqToken) return;
      this._browseData = { section, arg, data };
      this._renderBrowse();
      return;
    }

    if (data == null) data = Array.isArray(this._browseCache[section]) ? this._browseCache[section] : [];
    if (token !== this._browseReqToken) return;
    this._browseData = { section, arg, data };
    this._renderBrowse();
  }

  _renderBrowse() {
    const list = this._root.querySelector('#browseList');
    const hint = this._root.querySelector('#browseHint');
    const back = this._root.querySelector('#browseBackRow');
    if (!list || !this._browseData) return;
    const { section, arg, data } = this._browseData;
    if (back) back.style.display = this._browseStack.length ? '' : 'none';

    if (this._isTop(section) && this._browseCache[section] === null) {
      list.innerHTML = '';
      if (hint) hint.textContent = 'Choose Playlists, Albums, or Artists to begin browsing';
      const pager = this._root.querySelector('#browsePager'); if (pager) pager.style.display = 'none';
      return;
    }

    const mkItem = (primary, actionsHtml='', attrs='') => `
      <div class="item" ${attrs}>
        <div class="label"><span class="label-inner">${primary}</span></div>
        <div class="actions">${actionsHtml}</div>
      </div>`;

    const attr = (s) => String(s ?? '').replace(/"/g,'&quot;');
    const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
    const cleanTypeIcon = (s) => String(s ?? '').replace(/^[\uFFFD\uFE0F\u200B-\u200F\u2060\s🎧💿👤📀]+\s*/u,'');
    const iconFor = (k) => k==='playlist' ? 'mdi:playlist-music' : k==='album' ? 'mdi:album' : k==='artist' ? 'mdi:account-music' : '';
    const iconize = (k, name) => { const n=esc(cleanTypeIcon(name)); const ic=iconFor(k); return ic ? `<ha-icon icon="${ic}" style="--mdc-icon-size:18px; margin-right:6px; vertical-align:-4px;"></ha-icon>${n}` : n; };
    const trackLabel = (idx, name) => { const n = esc(String(name||'')); if (/^\s*\d+(?:[\.)-])\s/.test(n)) return n; return `${String(idx).padStart(2,'0')}. ${n}`; };

    let html = '';
    if (section==='playlists') {
      const items = this._getFilteredTopItems(); const start = this._browsePage*this._pageSize; const slice=items.slice(start, start+this._pageSize);
      slice.forEach(it => { const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html += mkItem(`${iconize('playlist',name)}`,
        `<button data-act="play" data-type="playlist" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>
         <button data-act="shuffle" data-type="playlist" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle</button>`,
        `data-act="open-playlist" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (hint) hint.textContent='Play or open playlists'; this._renderPager(items.length);
    } else if (section==='albums') {
      const items = this._getFilteredTopItems(); const start = this._browsePage*this._pageSize; const slice=items.slice(start, start+this._pageSize);
      slice.forEach(it => { const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html += mkItem(`${iconize('album',name)}`,
        `<button data-act="play" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>
         <button data-act="shuffle" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle</button>`,
        `data-act="open-album" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (hint) hint.textContent='Play or open albums'; this._renderPager(items.length);
    } else if (section==='artists') {
      const items = this._getFilteredTopItems(); const start = this._browsePage*this._pageSize; const slice=items.slice(start, start+this._pageSize);
      slice.forEach(it => { const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html += mkItem(`${iconize('artist',name)}`,
        `<button data-act="play" data-type="artist" data-id="${attr(id)}" data-name="${attr(name)}">Play All</button>
         <button data-act="shuffle" data-type="artist" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle All</button>`,
        `data-act="open-artist" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (hint) hint.textContent='Open artist to view albums, or play whole catalog'; this._renderPager(items.length);
    } else if (section==='artist_albums') {
      const artistName = (arg && arg.startsWith('artist:')) ? (()=>{ try { return decodeURIComponent(arg.slice(7)); } catch { return arg.slice(7);} })() : (arg||'');
      html += mkItem(`Albums by ${artistName}`,
        `<button data-act="play" data-type="artist" data-id="${attr(arg)}" data-name="${attr(artistName)}">Play All</button>
         <button data-act="shuffle" data-type="artist" data-id="${attr(arg)}" data-name="${attr(artistName)}" class="secondary">Shuffle All</button>`);
      (data||[]).forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html+=mkItem(`${iconize('album',name)}`,
        `<button data-act="play" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>
         <button data-act="shuffle" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}" class="secondary">Shuffle</button>`,
        `data-act="open-album" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (hint) hint.textContent = `Albums by ${artistName}`;
    } else if (section==='album_tracks') {
      let idx=0; const albumName=(arg&&arg.startsWith('album:'))?(()=>{try{return decodeURIComponent(arg.slice(6));}catch{return arg.slice(6);}})():(arg||'');
      html += mkItem('Play album',
        `<button data-act="play" data-type="album" data-id="${attr(arg)}" data-name="${attr(albumName)}">Play</button>
         <button data-act="shuffle" data-type="album" data-id="${attr(arg)}" data-name="${attr(albumName)}" class="secondary">Shuffle</button>`);
      (data||[]).forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; idx+=1; const lab=trackLabel(idx,name); html+=mkItem(`${lab}`,
        `<button data-act="play-track" data-id="${attr(id)}" data-kind="album" data-container="${attr(arg)}" data-name="${attr(name)}" data-idx="${idx}">Play</button>`); });
      if (hint) hint.textContent = `Tracks on ${albumName}`;
    } else if (section==='playlist_tracks') {
      let idx=0; const plName=(arg&&arg.startsWith('playlist:'))?(()=>{try{return decodeURIComponent(arg.slice(9));}catch{return arg.slice(9);}})():(arg||'');
      html += mkItem('Play playlist',
        `<button data-act="play" data-type="playlist" data-id="${attr(arg)}" data-name="${attr(plName)}">Play</button>
         <button data-act="shuffle" data-type="playlist" data-id="${attr(arg)}" data-name="${attr(plName)}" class="secondary">Shuffle</button>`);
      (data||[]).forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; idx+=1; const lab=trackLabel(idx,name); html+=mkItem(`${lab}`,
        `<button data-act="play-track" data-id="${attr(id)}" data-kind="playlist" data-container="${attr(arg)}" data-name="${attr(name)}" data-idx="${idx}">Play</button>`); });
      if (hint) hint.textContent = `Tracks in ${plName}`;
    } else if (section==='search') {
      const albums = Array.isArray(data?.albums)?data.albums:[];
      const artists = Array.isArray(data?.artists)?data.artists:[];
      const playlists = Array.isArray(data?.playlists)?data.playlists:[];
      const songs = Array.isArray(data?.songs||data?.tracks)?(data.songs||data.tracks):[];
      if (albums.length) html += `<div class="hint" style="padding-top:8px;">Albums</div>`;
      albums.forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html += mkItem(`${iconize('album',name)}`,
        `<button data-act="play" data-type="album" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>`,
        `data-act="open-album" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (artists.length) html += `<div class="hint" style="padding-top:8px;">Artists</div>`;
      artists.forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html += mkItem(`${iconize('artist',name)}`,
        `<button data-act="play" data-type="artist" data-id="${attr(id)}" data-name="${attr(name)}">Play All</button>`,
        `data-act="open-artist" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (playlists.length) html += `<div class="hint" style="padding-top:8px;">Playlists</div>`;
      playlists.forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; html += mkItem(`${iconize('playlist',name)}`,
        `<button data-act="play" data-type="playlist" data-id="${attr(id)}" data-name="${attr(name)}">Play</button>`,
        `data-act="open-playlist" data-id="${attr(id)}" data-name="${attr(name)}"`); });
      if (songs.length) html += `<div class="hint" style="padding-top:8px;">Songs</div>`;
      let sidx=0; songs.forEach(it=>{ const name=typeof it==='string'?it:it.name; const id=typeof it==='string'?'':it.id; sidx+=1; const lab=trackLabel(sidx,name); html += mkItem(`${lab}`,
        `<button data-act="play-track" data-id="${attr(id)}" data-kind="song" data-container="" data-name="${attr(name)}" data-idx="${sidx}">Play</button>`); });
      if (hint) hint.textContent='Search results';
    }

    if (!this._isTop(section)) { const pager=this._root.querySelector('#browsePager'); if (pager) pager.style.display='none'; }

    if (!html) {
      if (this._isTop(section)) {
        const f=this._getFilteredTopItems();
        if (!f.length) { list.innerHTML = '<div class="item"><div class="label"><span class="label-inner">No items. Try another letter or section.</span></div></div>'; this._initBrowseMarquee(); }
        else { list.innerHTML = '<div class="item"><div class="label"><span class="label-inner">No items on this page.</span></div></div>'; this._initBrowseMarquee(); }
      } else {
        list.innerHTML = '<div class="item"><div class="label"><span class="label-inner">No items</span></div></div>'; this._initBrowseMarquee();
      }
    } else {
      list.innerHTML = html; this._initBrowseMarquee();
    }
  }

  _initBrowseMarquee() {
    const rows = this._root.querySelectorAll('#browseList .label');
    rows.forEach(vp => { const inner = vp.querySelector('.label-inner'); if (inner) this._marqueeOnce(vp, inner); });
  }
  _marqueeOnce(viewport, inner) {
    inner.style.transition='none'; inner.style.transform='translateX(0)';
    const old = this._marqTimers.get(inner); if (old) { clearTimeout(old); this._marqTimers.delete(inner); }
    requestAnimationFrame(()=>{
      const vw=viewport.clientWidth; const iw=inner.scrollWidth; const delta=Math.max(0, iw-vw); if (delta<=4) return;
      const pxPerSec=40; const dur=Math.max(6, delta/pxPerSec); const delayMs=3000;
      const startTid=setTimeout(()=>{
        inner.style.transition=`transform ${dur}s linear`; inner.style.transform=`translateX(-${delta}px)`;
        const resetTid=setTimeout(()=>{ inner.style.transition='none'; inner.style.transform='translateX(0)'; }, Math.round(dur*1000 + 2000));
        this._marqTimers.set(inner, resetTid);
      }, delayMs);
      this._marqTimers.set(inner, startTid);
    });
  }

  _isTop(section){ return section==='playlists' || section==='albums' || section==='artists'; }
  _alphaSet(letter){ this._browseAlpha = letter||''; this._browsePage=0; this._renderBrowse(); }
  _pageSet(p){
    // Support pagination across all sections, not just top-level
    let itemsLen = 0; const section=this._browseSection;
    if (this._isTop(section)) {
      itemsLen = (this._getFilteredTopItems()||[]).length;
    } else if (section==='search') {
      const d=this._browseData?.data||{}; const albums=Array.isArray(d.albums)?d.albums.length:0; const artists=Array.isArray(d.artists)?d.artists.length:0; const playlists=Array.isArray(d.playlists)?d.playlists.length:0; const songs=Array.isArray(d.songs||d.tracks)?(d.songs||d.tracks).length:0; itemsLen = albums+artists+playlists+songs;
    } else {
      const arr = Array.isArray(this._browseData?.data)?this._browseData.data:[]; itemsLen = arr.length;
    }
    const pages=Math.max(1, Math.ceil(itemsLen/this._pageSize)); let next=p; if(!isFinite(next)||next>pages-1) next=pages-1; if(next<0) next=0; this._browsePage=next; this._renderBrowse();
  }
  _getFilteredTopItems(){ const section=this._browseSection; const baseRaw=Array.isArray(this._browseCache[section])?[...this._browseCache[section]]:[]; const arr=baseRaw.map(x=> (typeof x==='string'?{id:'',name:x}:x)); const norm=(s)=>String(s||'').replace(/^[^A-Za-z0-9]+/,''); arr.sort((a,b)=> norm(a.name).localeCompare(norm(b.name),undefined,{sensitivity:'base'})); const L=(this._browseAlpha||'').toUpperCase(); if(!L) return arr; if(L==='#') return arr.filter(o=> !/^[A-Z]/i.test(norm(o.name).charAt(0))); return arr.filter(o=> norm(o.name).toUpperCase().startsWith(L)); }

  _computeLetters(){ const section=this._browseSection; if(!this._isTop(section)) return []; const baseRaw=Array.isArray(this._browseCache[section])?[...this._browseCache[section]]:[]; const arr=baseRaw.map(x=> (typeof x==='string'?{id:'',name:x}:x)); const norm=(s)=>String(s||'').replace(/^[^A-Za-z0-9]+/,''); const set=new Set(); for(const it of arr){ const n=norm(it.name); if(!n) continue; const ch=n.charAt(0).toUpperCase(); if(ch>='A'&&ch<='Z') set.add(ch); else set.add('#'); } const out=[]; if(set.has('#')) out.push('#'); for(let c=65;c<=90;c++){ const L=String.fromCharCode(c); if(set.has(L)) out.push(L); } return out; }

  _renderPager(itemsLen){ const pager=this._root.querySelector('#browsePager'); const alphaRow=this._root.querySelector('#alphaRow'); const info=this._root.querySelector('#pageInfo'); const prev=this._root.querySelector('#pagePrev'); const next=this._root.querySelector('#pageNext'); const first=this._root.querySelector('#pageFirst'); const last=this._root.querySelector('#pageLast'); if(!pager||!alphaRow||!info) return; if(!this._isTop(this._browseSection)){ pager.style.display='none'; return; } pager.style.display=''; const letters=(this._computeLetters && this._computeLetters())||[]; if(this._browseAlpha && !letters.includes(this._browseAlpha)) this._browseAlpha=''; alphaRow.innerHTML = letters.map(L=>`<button class="letterbtn ${this._browseAlpha===L?'active':''}" data-letter="${L}">${L}</button>`).join(''); const pages=Math.max(1, Math.ceil(itemsLen/this._pageSize)); const page=Math.min(this._browsePage, pages-1); info.textContent = `Page ${pages ? (page+1) : 0} of ${pages}`; const disPrev = page<=0; const disNext = page>=pages-1; [prev,first].forEach(b=>{ if(b) b.disabled=disPrev; }); [next,last].forEach(b=>{ if(b) b.disabled=disNext; }); }

  _browseBack(){ if(!this._browseStack.length) return; const prev=this._browseStack.pop(); this._browseLoad(prev.section, prev.arg); }

  _browseListClick(ev){
    const btn = ev.target.closest('button');
    if (!btn) {
      const row = ev.target.closest('.item'); if (!row) return; const act=row.getAttribute('data-act'); if(!act) return; const id=row.getAttribute('data-id')||''; const name=row.getAttribute('data-name')||'';
      if (act==='open-album') { this._browseStack.push({ section:this._browseData.section, arg:this._browseData.arg }); this._browseLoad('album_tracks', id || ('album:'+name)); }
      else if (act==='open-playlist') { this._browseStack.push({ section:this._browseData.section, arg:this._browseData.arg }); this._browseLoad('playlist_tracks', id || ('playlist:'+name)); }
      else if (act==='open-artist') { this._browseStack.push({ section:this._browseData.section, arg:this._browseData.arg }); this._browseLoad('artist_albums', id || ('artist:'+name)); }
      return;
    }
    const act=btn.getAttribute('data-act'); const id=btn.getAttribute('data-id')||''; const name=btn.getAttribute('data-name')||'';
    if (act==='open-album') { this._browseStack.push({ section:this._browseData.section, arg:this._browseData.arg }); this._browseLoad('album_tracks', id || ('album:'+name)); }
    else if (act==='open-playlist') { this._browseStack.push({ section:this._browseData.section, arg:this._browseData.arg }); this._browseLoad('playlist_tracks', id || ('playlist:'+name)); }
    else if (act==='open-artist') { this._browseStack.push({ section:this._browseData.section, arg:this._browseData.arg }); this._browseLoad('artist_albums', id || ('artist:'+name)); }
    else if (act==='play' || act==='shuffle') { const type=btn.getAttribute('data-type')||'album'; const shuffle=(act==='shuffle'); this._playContainer(type, name, shuffle, id); }
    else if (act==='play-track') { const kind=btn.getAttribute('data-kind'); const container=btn.getAttribute('data-container')||''; const idx=parseInt(btn.getAttribute('data-idx')||'0',10)||0; this._playTrack(kind, container, name, idx, id); }
  }

  async _browseSearch(term){ this._browseStack=[]; this._browseSection='search'; await this._browseLoad('search', term); }

  async _playContainer(type, name, shuffle=false, idArg='') {
    const entity = this._entityId();
    const playMedia = (mcid) => this._hass.callService('media_player', 'play_media', { entity_id: entity, media_content_type: 'music', media_content_id: mcid });
    const start = () => this._hass.callService('media_player', 'media_play', { entity_id: entity });

    if (shuffle) {
      if (type === 'artist') {
        const artistId = idArg || (name ? `artist:${name}` : '');
        const artistName = (artistId && artistId.startsWith('artist:')) ? (()=>{ try { return decodeURIComponent(artistId.slice(7)); } catch { return artistId.slice(7); } })() : (name || '');
        if (artistName) { try { await this._hass.callApi('POST', 'apple_music/queue_artist_shuffled', { artist: artistName }); } catch(_){} }
        return;
      }
      const nameFromId = (id) => { if(!id) return ''; if(id.startsWith('album:')){ try{return decodeURIComponent(id.slice(6));}catch{return id.slice(6);} } if(id.startsWith('playlist:')){ try{return decodeURIComponent(id.slice(9));}catch{return id.slice(9);} } if(id.startsWith('artist:')){ try{return decodeURIComponent(id.slice(7));}catch{return id.slice(7);} } return ''; };
      const baseName = (idArg && nameFromId(idArg)) || name || '';
      const sid = (type==='playlist') ? `shuffle_playlist:${baseName}` : (type==='album') ? `shuffle_album:${baseName}` : '';
      if (sid) { playMedia(sid); start(); }
      return;
    }

    if (idArg) { playMedia(idArg); start(); return; }
    const pid = (type==='playlist')?`play_playlist:${name}` : (type==='album')?`play_album:${name}` : (type==='artist')?`artist:${name}` : '';
    if (!pid) return; playMedia(pid); start();
  }

  _playTrack(kind, container, name, idx, idArg='') {
    const entity = this._entityId();
    if (idArg) { this._hass.callService('media_player','play_media',{ entity_id:entity, media_content_type:'music', media_content_id:idArg}); return; }
    let id=''; if (kind==='album') id=`song:${name}||album=${container}||idx=${idx}`; else if (kind==='playlist') id=`song:${name}||playlist=${container}||idx=${idx}`; else id=`song:${name}`;
    this._hass.callService('media_player','play_media',{ entity_id:entity, media_content_type:'music', media_content_id:id });
  }
}
try {
  if (!customElements.get('music-browse-card')) {
    customElements.define('music-browse-card', MusicBrowseCard);
  }
} catch (_) { /* ignore define errors */ }

// Attach SSE helpers to main panel prototype (file order places them after class definition)
MusicControllerPanel.prototype._connectSSE = function() {
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const open = (path) => {
      if (this._es) { try { this._es.close(); } catch(_){} this._es = null; }
      const es = new EventSource(path || '/api/apple_music/events');
      this._es = es;
      es.onopen = () => {
        this._sseBackoff = 1000;
        this._sseHealthy = true;
        // Stop aggressive poll; keep a slow watchdog
        if (this._pollHandle) { clearInterval(this._pollHandle); this._pollHandle = null; }
        if (!this._healthHandle) this._healthHandle = setInterval(() => this._poll(false), 60000);
      };
      es.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          this._handleSSE(msg);
          this._sseHealthy = true;
        } catch (_) { /* ignore */ }
      };
      es.onerror = () => {
        try { this._es && this._es.close(); } catch(_){}
        this._es = null;
        this._sseHealthy = false;
        // Resume aggressive poll until SSE reconnects
        if (!this._pollHandle) { this._pollHandle = setInterval(() => this._poll(), 3000); }
        if (this._healthHandle) { clearInterval(this._healthHandle); this._healthHandle = null; }
        const wait = Math.min(30000, Math.max(1000, this._sseBackoff || 1000));
        this._sseBackoff = Math.min(30000, wait * 2);
        setTimeout(() => { try { this._connectSSE(); } catch(_){} }, wait);
      };
    };

    // Prefer HA signed-path auth for EventSource
    if (this._hass && this._hass.callWS) {
      const path = '/api/apple_music/events';
      this._hass.callWS({ type: 'auth/sign_path', path, expires: 60 })
        .then((resp) => {
          if (resp && typeof resp.path === 'string' && resp.path) open(resp.path); else open(path);
        })
        .catch(() => open(path));
      return;
    }
    // Fallback: open without signing; polling remains as backup
    open('/api/apple_music/events');
  } catch (e) {
    if (!this._pollHandle) this._pollHandle = setInterval(() => this._poll(), 3000);
  }
};

MusicControllerPanel.prototype._handleSSE = function(msg) {
  const { event, data } = msg || {};
  if (event === 'snapshot') {
    this._applySnapshot(data);
    return;
  }
  // Treat multiple synonyms from various server implementations as NOW updates
  if (event === 'now' || event === 'status' || event === 'now_playing' || event === 'now-playing') {
    if (data) {
      const t = this.querySelector('#track'); if (t && typeof data.title === 'string' && data.title) t.textContent = data.title;
      const ar = this.querySelector('#artist'); if (ar && typeof data.artist === 'string' && data.artist) ar.textContent = data.artist;
      const al = this.querySelector('#album'); if (al && typeof data.album === 'string' && data.album) al.textContent = data.album;
      const prevKey = this._lastNPKey || '';
      const nowKey = `${data.title||''}|${data.artist||''}|${data.album||''}`;
      this._lastNPKey = nowKey;
      // Update art in UI
      try {
        const tok = (data.artwork_token || data.token || '').toString();
        const album = (data.album || '').toString();
        if (tok) {
          this._setArtwork?.(tok);
          if (this._lastSavedTok !== tok) {
            this._lastSavedTok = tok;
            // Check cache on the server; only force save if missing
            this._ensureServerArtworkSaved?.(tok, album);
          }
        } else if (album) {
          if (this._lastSavedAlbum !== album) {
            this._lastSavedAlbum = album;
            this._ensureServerArtworkSaved?.('', album);
          }
          // Without a token, update current artwork directly
          this._refreshCurrentArtworkNoToken?.();
        } else if (nowKey !== prevKey) {
          // No token and album not provided; still refresh on track metadata change
          this._refreshCurrentArtworkNoToken?.();
        }
      } catch(_) { /* ignore */ }
      this._status = { ...(this._status||{}), shuffle: !!(data.shuffle ?? this._status?.shuffle) };
      this._updateShuffleButtonVisual?.();
      if (typeof data.state === 'string') this._updatePlayPauseVisual?.(data.state);
      this._applyNowPlayingMarquee?.();
    }
    return;
  }
  if (event === 'master_volume') {
    const slider = this.querySelector('#masterVol');
    if (slider && typeof data === 'number' && Date.now() >= this._masterHoldUntil) {
      slider.value = String(Math.max(0, Math.min(1, data/100)));
    }
    return;
  }
  if (event === 'shuffle') {
    this._status = { ...(this._status||{}), shuffle: !!(data && data.enabled) };
    this._updateShuffleButtonVisual?.();
    return;
  }
  if (event === 'airplay_full') {
    const names = Array.isArray(data) ? data.map(d => d.name) : [];
    this._devices = names;
    this._currentDevices = new Set((data||[]).filter(d => d.active).map(d => d.name));
    const vols = {};
    (data||[]).forEach(d => { if (typeof d.volume === 'number') vols[d.name] = d.volume/100; });
    this._deviceVolumes = vols;
    this._renderDevices();
    return;
  }
  // Individual push updates from server
  if (event === 'current_devices' || event === 'selected_devices') {
    try {
      let arr = [];
      if (Array.isArray(data)) arr = data;
      else if (data && Array.isArray(data.devices)) arr = data.devices;
      const names = arr.map(d => (typeof d === 'string') ? d : (d && (d.name || d.device)) ).filter(Boolean);
      this._currentDevices = new Set(names);
      this._renderDevices?.();
    } catch(_) {}
    return;
  }
  if (event === 'device_volumes' || event === 'devices_volume' || event === 'per_device_volume') {
    try {
      const norm = {};
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [k,v] of Object.entries(data)) {
          let val = Number(v);
          if (!isFinite(val)) continue;
          if (val > 1.5) val = val/100;
          if (val < 0) val = 0; if (val > 1) val = 1;
          norm[k] = val;
        }
      } else if (Array.isArray(data)) {
        for (const it of data) {
          const name = it && (it.name || it.device);
          let val = Number((it && (it.volume ?? it.level)) ?? NaN);
          if (!name || !isFinite(val)) continue;
          if (val > 1.5) val = val/100;
          if (val < 0) val = 0; if (val > 1) val = 1;
          norm[name] = val;
        }
      }
      if (Object.keys(norm).length) {
        this._deviceVolumes = { ...this._deviceVolumes, ...norm };
        this._renderDevices?.();
      }
    } catch(_) {}
    return;
  }
  if (event === 'devices' || event === 'airplay_devices') {
    try {
      const list = Array.isArray(data) ? data : (data && Array.isArray(data.devices) ? data.devices : []);
      const names = list.map(d => (typeof d === 'string') ? d : (d && d.name)).filter(Boolean);
      if (names.length) { this._devices = names; this._renderDevices?.(); }
    } catch(_) {}
    return;
  }
  if (event === 'artwork_saved') {
    try {
      const tok = (data && (data.token || ''));
      if (tok) {
        this._setArtwork?.(tok);
      } else {
        // No token reported; fetch current artwork and swap
        this._refreshCurrentArtworkNoToken?.();
      }
    } catch (_) {}
    return;
  }
};

MusicControllerPanel.prototype._applySnapshot = function(data) {
  if (!data) return;
  // Now playing
  const now = data.now || {};
  const t = this.querySelector('#track'); if (t && typeof now.title === 'string' && now.title) t.textContent = now.title;
  const ar = this.querySelector('#artist'); if (ar && typeof now.artist === 'string' && now.artist) ar.textContent = now.artist;
  const al = this.querySelector('#album'); if (al && typeof now.album === 'string' && now.album) al.textContent = now.album;
  if (data.artwork_token) this._setArtwork?.(data.artwork_token);

  // Master volume
  if (typeof data.master === 'number') {
    const slider = this.querySelector('#masterVol');
    if (slider && Date.now() >= this._masterHoldUntil) {
      slider.value = String(Math.max(0, Math.min(1, data.master/100)));
    }
  }
};

// Helper: sign a path via HA and set the artwork image src
MusicControllerPanel.prototype._signedPath = function(path) {
  try {
    if (this._hass && this._hass.callWS) {
      return this._hass
        .callWS({ type: 'auth/sign_path', path, expires: 60 })
        .then((resp) => (resp && typeof resp.path === 'string' && resp.path) ? resp.path : path)
        .catch(() => path);
    }
  } catch (_) {}
  return Promise.resolve(path);
};

// Ensure server-side artwork cache is populated before forcing a refresh
MusicControllerPanel.prototype._ensureServerArtworkSaved = async function(tok, album) {
  try {
    const base = tok ? `/api/apple_music/artwork?tok=${encodeURIComponent(tok)}` : '/api/apple_music/artwork';
    const url = await this._signedPath(base).catch(()=>base);
    let ok = false;
    try {
      const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
      ok = !!(r && (r.ok || r.status === 304));
    } catch(_) { ok = false; }
    if (!ok) {
      const ref = base + (base.includes('?') ? '&' : '?') + 'refresh=1';
      const u2 = await this._signedPath(ref).catch(()=>ref);
      try { await fetch(u2, { cache: 'no-store', credentials: 'same-origin' }); } catch(_) {}
    }
  } catch(_) { /* ignore */ }
};

// Fetch and display current artwork when no token is provided by the server
MusicControllerPanel.prototype._refreshCurrentArtworkNoToken = async function() {
  if (this._pendingArtFetch) return;
  this._pendingArtFetch = true;
  try {
    const base = '/api/apple_music/artwork';
    const fetchOnce = async (u) => {
      const url = await this._signedPath(u).catch(()=>u);
      const r = await fetch(url || u, { cache: 'no-store', credentials: 'same-origin' });
      if (!r || !r.ok) throw new Error('artwork fetch failed');
      return r.blob();
    };
    let blob;
    try { blob = await fetchOnce(base); }
    catch (_) { blob = await fetchOnce(base + '?refresh=1'); }
    const imgEl = this.querySelector('#art');
    if (imgEl && blob) {
      const url = URL.createObjectURL(blob);
      const prev = imgEl.dataset.blobUrl;
      imgEl.src = url;
      imgEl.dataset.blobUrl = url;
      if (prev && prev !== url) { try { URL.revokeObjectURL(prev); } catch(_){} }
    }
  } catch(_) { /* ignore */ }
  finally { this._pendingArtFetch = false; }
};

// Artwork caching and display without flicker
MusicControllerPanel.prototype._artCacheKey = function(tok){ return `https://am-art.local/art/${encodeURIComponent(tok)}`; };
MusicControllerPanel.prototype._getArtCache = async function(){ try { return await caches.open('apple_music_artwork'); } catch(_) { return null; } };
MusicControllerPanel.prototype._loadArtFromCache = async function(tok){
  try { const cache = await this._getArtCache(); if (!cache) return null; const req = new Request(this._artCacheKey(tok)); const resp = await cache.match(req); return resp || null; } catch(_) { return null; }
};
MusicControllerPanel.prototype._fetchAndCacheArt = async function(tok){
  const path = `/api/apple_music/artwork?tok=${encodeURIComponent(tok)}`;
  const url = await this._signedPath(path).catch(()=>path);
  let resp = null;
  try { resp = await fetch(url, { cache: 'no-store' }); } catch(_) { resp = null; }
  if (resp && resp.ok) {
    try { const cache = await this._getArtCache(); if (cache) { await cache.put(new Request(this._artCacheKey(tok)), resp.clone()); } } catch(_){}
    return resp;
  }
  return null;
};
MusicControllerPanel.prototype._setArtwork = async function(tok) {
  try {
    if (!tok) return;
    const img = this.querySelector('#art'); if (!img) return;
    this._currentArtTok = tok;
    // Try cache first
    let resp = await this._loadArtFromCache(tok);
    if (!resp) resp = await this._fetchAndCacheArt(tok);
    if (!resp) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    // Swap only when decoded to reduce flicker
    const tmp = new Image();
    tmp.onload = () => {
      if (this._currentArtTok === tok) {
        const prev = img.dataset.blobUrl;
        img.src = url;
        img.dataset.blobUrl = url;
        this._lastArtToken = tok;
        this._lastArtSetAt = Date.now();
        if (prev && prev !== url) { try { URL.revokeObjectURL(prev); } catch(_){} }
      } else {
        try { URL.revokeObjectURL(url); } catch(_){}
      }
    };
    tmp.onerror = () => { try { URL.revokeObjectURL(url); } catch(_){} };
    tmp.src = url;
  } catch (_) { /* ignore */ }
};

// Service helpers
MusicControllerPanel.prototype._purgeAlbumCache = async function(){
  // Prefer Home Assistant services
  let ok = false;
  try { await this._hass.callService('apple_music','purge_album_cache',{ entity_id: this._entityId?.() }); ok = true; } catch(_){}
  if (!ok) { try { await this._hass.callService('apple_music','purge_album_cache',{}); ok = true; } catch(_){} }
  // Clear local artwork cache regardless
  try { const c = await caches.open('apple_music_artwork'); const keys = await c.keys(); await Promise.all(keys.map(k=>c.delete(k))); } catch(_){}
  if (!ok) throw new Error('service-missing');
};
MusicControllerPanel.prototype._purgeThumbCache = async function(){
  let ok = false;
  try { await this._hass.callService('apple_music','purge_thumb_cache',{ entity_id: this._entityId?.() }); ok = true; } catch(_){}
  if (!ok) { try { await this._hass.callService('apple_music','purge_thumb_cache',{}); ok = true; } catch(_){} }
  try { const c = await caches.open('apple_music_artwork'); const keys = await c.keys(); await Promise.all(keys.map(k=>c.delete(k))); } catch(_){}
  if (!ok) throw new Error('service-missing');
};
