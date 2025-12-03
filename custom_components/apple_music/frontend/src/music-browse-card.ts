// music-browse-card.ts
import { LitElement, html, css, TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HomeAssistant } from 'custom-card-helpers';

interface Config {
  title?: string;
  entity?: string;
}

interface BrowseStackItem {
  section: string;
  arg?: string;
}

interface BrowseData {
  section: string;
  arg?: string;
  data: any;
}

@customElement('music-browse-card')
class MusicBrowseCard extends LitElement {
  @property({ attribute: false }) public accessor hass!: HomeAssistant;
  @state() private accessor _config: Config = {} as Config;
  @state() private accessor _browseSection: string = 'playlists';
  @state() private accessor _browseStack: BrowseStackItem[] = [];
  @state() private accessor _browseData: BrowseData | null = null;
  @state() private accessor _browseCache: { [key: string]: any[] | null } = { playlists: null, albums: null, artists: null };
  @state() private accessor _browsePage: number = 0;
  @state() private accessor _pageSize: number = 5;
  @state() private accessor _browseAlpha: string = '';
  @state() private accessor _browseReqToken: number = 0;
  @state() private accessor _preferWS: boolean = true;
  @state() private accessor _marqTimers = new WeakMap<Element, number>();

  setConfig(config: Config) {
    this._config = { ...config };
  }

  protected render(): TemplateResult {
    return html`
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
      </ha-card>
    `;
  }

  static get styles() {
    return css`
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
    `;
  }

  firstUpdated() {
    // Wire event listeners
    this.shadowRoot?.querySelector('#segPlaylists')?.addEventListener('click', () => this._browseSwitch('playlists'));
    this.shadowRoot?.querySelector('#segAlbums')?.addEventListener('click', () => this._browseSwitch('albums'));
    this.shadowRoot?.querySelector('#segArtists')?.addEventListener('click', () => this._browseSwitch('artists'));
    this.shadowRoot?.querySelector('#searchForm')?.addEventListener('submit', (e: Event) => {
      e.preventDefault();
      const input = this.shadowRoot?.querySelector('#searchInput') as HTMLInputElement;
      const term = input?.value?.trim() || '';
      if (term) this._browseSearch(term);
    });
    this.shadowRoot?.querySelector('#browseBack')?.addEventListener('click', () => this._browseBack());
    this.shadowRoot?.querySelector('#browseList')?.addEventListener('click', (ev: Event) => this._browseListClick(ev as MouseEvent));
    const pager = this.shadowRoot?.querySelector('#browsePager');
    pager?.addEventListener('click', (ev: Event) => {
      const b = (ev.target as Element).closest('button');
      if (!b) return;
      const id = b.id;
      if (id === 'pageFirst') this._pageSet(0);
      else if (id === 'pagePrev') this._pageSet(this._browsePage - 1);
      else if (id === 'pageNext') this._pageSet(this._browsePage + 1);
      else if (id === 'pageLast') this._pageSet(Number.POSITIVE_INFINITY);
    });
    this.shadowRoot?.querySelector('#alphaRow')?.addEventListener('click', (ev: Event) => {
      const b = (ev.target as Element).closest('.letterbtn');
      if (!b) return;
      this._alphaSet(b.getAttribute('data-letter') || '');
    });
  }

  protected updated() {
    if (!this._browseSection && this._browseCache.playlists === null && this._browseCache.albums === null && this._browseCache.artists === null) {
      const hint = this.shadowRoot?.querySelector('#browseHint');
      if (hint) (hint as HTMLElement).textContent = 'Choose Playlists, Albums, or Artists to begin browsing';
      const pager = this.shadowRoot?.querySelector('#browsePager') as HTMLElement;
      if (pager) pager.style.display = 'none';
      const list = this.shadowRoot?.querySelector('#browseList') as HTMLElement;
      if (list) list.innerHTML = '';
    }
  }

  private _entityId(): string {
    if (this._config.entity) return this._config.entity;
    const s = this.hass.states;
    return s['media_player.music_control_player'] ? 'media_player.music_control_player' : 'media_player.apple_music_player';
  }

  private _mpService(service: string, data: any = {}) {
    this.hass.callService('media_player', service, { entity_id: this._entityId(), ...data });
  }

  private async _browseSwitch(section: string) {
    this._browseStack = [];
    this._browseSection = section;
    this._browsePage = 0;
    this._browseAlpha = '';
    this._setActiveSeg('#seg' + section.charAt(0).toUpperCase() + section.slice(1));
    await this._browseLoad(section);
  }

  private _setActiveSeg(id: string) {
    ['#segPlaylists', '#segAlbums', '#segArtists'].forEach(sel => {
      const el = this.shadowRoot?.querySelector(sel) as HTMLElement;
      if (el) {
        if (('#' + el.id) === id) el.classList.add('active');
        else el.classList.remove('active');
      }
    });
  }

  private async _browseLoad(section: string, arg?: string) {
    const prev = this._browseSection;
    this._browseSection = section;
    if (prev !== section) { this._browsePage = 0; this._browseAlpha = ''; }
    const list = this.shadowRoot?.querySelector('#browseList') as HTMLElement;
    const back = this.shadowRoot?.querySelector('#browseBackRow') as HTMLElement;
    const hint = this.shadowRoot?.querySelector('#browseHint') as HTMLElement;
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

  private async _browseLoadViaHA(section: string, arg?: string) {
    const token = this._browseReqToken;
    const entity_id = this._entityId();
    const typeFor = (idOrSection?: string) => {
      if (!idOrSection) return 'library';
      const s = String(idOrSection).toLowerCase();
      if (s === 'playlists' || s === 'albums' || s === 'artists') return 'library';
      if (s.startsWith('album:')) return 'album';
      if (s.startsWith('artist:')) return 'artist';
      if (s.startsWith('playlist:')) return 'playlist';
      if (s.startsWith('song:')) return 'music';
      return 'library';
    };
    const browse = async (media_content_id: string, overrideType?: string) => {
      return await this.hass.callWS({ type: 'media_player/browse_media', entity_id, media_content_id, media_content_type: overrideType || typeFor(media_content_id) });
    };

    const strip = (s: string, p: string) => s && s.startsWith(p) ? decodeURIComponent(s.slice(p.length)) : s;
    const parseSongName = (cid: string) => {
      if (!cid) return '';
      if (cid.startsWith('song:')) {
        let s = cid.slice(5);
        const i = s.indexOf('||');
        if (i >= 0) s = s.slice(0, i);
        try { return decodeURIComponent(s); } catch { return s; }
      }
      return cid;
    };
    const flattenChildren = (arr: any[]) => {
      const out: any[] = [];
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
    const isTrack = (c: any) => {
      const cid = c.media_content_id || '';
      const mc = (c.media_class || '').toLowerCase();
      const title = (c.title || '').toLowerCase();
      if (cid.startsWith('song:')) return true;
      if (mc === 'track') return true;
      if (mc.includes('music') || mc.includes('audio')) {
        if (cid.startsWith('play_') || cid.startsWith('shuffle_')) return false;
        if (title.includes('play album') || title.includes('shuffle')) return false;
        return true;
      }
      return false;
    };

    let data: any = null;
    if (section === 'playlists') {
      const res: any = await browse('playlists', 'library');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map((c: any) => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'playlist:') }));
      this._browseCache[section] = Array.isArray(data) ? data : [];
    } else if (section === 'albums') {
      const res: any = await browse('albums', 'library');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map((c: any) => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'album:') }));
      this._browseCache[section] = Array.isArray(data) ? data : [];
    } else if (section === 'artists') {
      const res: any = await browse('artists', 'library');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      data = children.map((c: any) => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'artist:') }));
      this._browseCache[section] = Array.isArray(data) ? data : [];
    } else if (section === 'artist_albums' && arg) {
      const res: any = await browse(arg, 'artist');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      children = flattenChildren(children);
      data = children.map((c: any) => ({ id: c.media_content_id || '', name: c.title || strip(c.media_content_id || '', 'album:') }));
    } else if (section === 'album_tracks' && arg) {
      const res: any = await browse(arg, 'album');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      children = flattenChildren(children);
      data = children.filter(isTrack).map((c: any) => ({ id: c.media_content_id || '', name: c.title || parseSongName(c.media_content_id || '') }));
    } else if (section === 'playlist_tracks' && arg) {
      const res: any = await browse(arg, 'playlist');
      let children = Array.isArray(res?.children) ? res.children : [];
      if (!children.length && Array.isArray(res?.items)) children = res.items;
      children = flattenChildren(children);
      data = children.filter(isTrack).map((c: any) => ({ id: c.media_content_id || '', name: c.title || parseSongName(c.media_content_id || '') }));
    } else if (section === 'search' && arg) {
      // Perform HA search via WS and normalize varied response shapes
      const res: any = await this.hass.callWS({
        type: 'media_player/search_media',
        entity_id,
        search_query: arg,
      });

      // Extract array of items from possible keys: result.media | result | media | []
      let items: any[] = [];
      if (Array.isArray(res?.result?.media)) items = res.result.media;
      else if (Array.isArray(res?.result)) items = res.result;
      else if (Array.isArray(res?.media)) items = res.media;
      else if (Array.isArray(res)) items = res;

      // Target buckets
      const albums: any[] = [];
      const artists: any[] = [];
      const playlists: any[] = [];
      const songs: any[] = [];

      // Some integrations might return grouped dicts already
      if (!items.length && res && typeof res === 'object') {
        const pushList = (arr: any, kind: 'album' | 'artist' | 'playlist' | 'song') => {
          const list = Array.isArray(arr) ? arr : [];
          for (const it of list) {
            const cid = (typeof it === 'string') ? `${kind}:${it}` : (it?.id || it?.media_content_id || '');
            const title = (typeof it === 'string') ? it : (it?.title ?? it?.name ?? '');
            if (kind === 'album') albums.push({ id: cid || `album:${title}`, name: title || strip(cid, 'album:') });
            else if (kind === 'artist') artists.push({ id: cid || `artist:${title}`, name: title || strip(cid, 'artist:') });
            else if (kind === 'playlist') playlists.push({ id: cid || `playlist:${title}`, name: title || strip(cid, 'playlist:') });
            else songs.push({ id: cid || `song:${title}`, name: title || parseSongName(cid) });
          }
        };
        pushList(res.albums, 'album');
        pushList(res.artists, 'artist');
        pushList(res.playlists, 'playlist');
        pushList(res.songs ?? res.tracks, 'song');
      }

      // Default: partition a flat array of BrowseMedia items
      if (!albums.length && !artists.length && !playlists.length && !songs.length) {
        for (const it of items) {
          const mc = String(it?.media_class || '').toLowerCase();
          const cid = it?.media_content_id || '';
          const title = it?.title ?? '';
          if (mc === 'album') albums.push({ id: cid, name: title || strip(cid, 'album:') });
          else if (mc === 'artist') artists.push({ id: cid, name: title || strip(cid, 'artist:') });
          else if (mc === 'playlist') playlists.push({ id: cid, name: title || strip(cid, 'playlist:') });
          else if (mc === 'track' || mc === 'music' || mc === 'audio' || mc === 'song') songs.push({ id: cid, name: title || parseSongName(cid) });
        }
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

  private _renderBrowse() {
    const list = this.shadowRoot?.querySelector('#browseList') as HTMLElement;
    const hint = this.shadowRoot?.querySelector('#browseHint') as HTMLElement;
    const back = this.shadowRoot?.querySelector('#browseBackRow') as HTMLElement;
    if (!list || !this._browseData) return;
    const { section, arg, data } = this._browseData;
    if (back) back.style.display = this._browseStack.length ? '' : 'none';

    if (this._isTop(section) && this._browseCache[section] === null && !this._browseSection) {
      list.innerHTML = '';
      if (hint) hint.textContent = 'Choose Playlists, Albums, or Artists to begin browsing';
      const pager = this.shadowRoot?.querySelector('#browsePager') as HTMLElement;
      if (pager) pager.style.display = 'none';
      return;
    }

    const mkItem = (primary: string, actionsHtml = '', attrs = '') => `
          <div class="item" ${attrs}>
            <div class="label"><span class="label-inner">${primary}</span></div>
            <div class="actions">${actionsHtml}</div>
          </div>`;

    const attr = (s: string | null) => String(s ?? '').replace(/"/g, '"');
    const esc = (s: string | null) => String(s ?? '').replace(/[&<>]/g, (c: string) => (({ '&': '&', '<': '<', '>': '>' } as Record<string, string>)[c] || c));
    const cleanTypeIcon = (s: string | null) => String(s ?? '').replace(/^[\uFFFD\uFE0F\u200B-\u200F\u2060\s🎧💿👤📀]+\s*/u, '');
    const iconFor = (k: string) => k === 'playlist' ? 'mdi:playlist-music' : k === 'album' ? 'mdi:album' : k === 'artist' ? 'mdi:account-music' : '';
    const iconize = (k: string, name: string | null) => {
      const n = esc(cleanTypeIcon(name));
      const ic = iconFor(k);
      return ic ? `<ha-icon icon="${ic}" style="--mdc-icon-size:18px; margin-right:6px; vertical-align:-4px;"></ha-icon>${n}` : n;
    };
    const trackLabel = (idx: number, name: string | null) => {
      const n = esc(String(name || ''));
      if (/^\s*\d+(?:[\.)-])\s/.test(n)) return n;
      return `${String(idx).padStart(2, '0')}. ${n}`;
    };

    let html = '';
    if (section === 'playlists') {
      const items = this._getFilteredTopItems();
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach((it) => {
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
      slice.forEach((it) => {
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
      slice.forEach((it) => {
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
    } else if (section === 'artist_albums' && arg) {
      const artistName = (arg && arg.startsWith('artist:')) ? (() => { try { return decodeURIComponent(arg.slice(7)); } catch { return arg.slice(7); } })() : (arg || '');
      html += mkItem(
        `Albums by ${artistName}`,
        `<button data-act="play" data-type="artist" data-id="${attr(arg)}" data-name="${attr(artistName)}">Play All</button>
                 <button data-act="shuffle" data-type="artist" data-id="${attr(arg)}" data-name="${attr(artistName)}" class="secondary">Shuffle All</button>`
      );
      const items = data || [];
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach((it: any) => {
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
      this._renderPager(items.length);
    } else if (section === 'album_tracks' && arg) {
      let idx = 0;
      const albumName = (arg && arg.startsWith('album:')) ? (() => { try { return decodeURIComponent(arg.slice(6)); } catch { return arg.slice(6); } })() : (arg || '');
      html += mkItem(
        'Play album',
        `<button data-act="play" data-type="album" data-id="${attr(arg)}" data-name="${attr(albumName)}">Play</button>
                 <button data-act="shuffle" data-type="album" data-id="${attr(arg)}" data-name="${attr(albumName)}" class="secondary">Shuffle</button>`
      );
      const items = data || [];
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach((it: any) => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        idx += 1;
        const tlabel = trackLabel(idx + start, name);
        html += mkItem(
          `${tlabel}`,
          `<button data-act="play-track" data-id="${attr(id)}" data-kind="album" data-container="${attr(arg)}" data-name="${attr(name)}" data-idx="${idx + start}">Play</button>`
        );
      });
      if (hint) hint.textContent = `Tracks on ${albumName}`;
      this._renderPager(items.length);
    } else if (section === 'playlist_tracks' && arg) {
      let idx = 0;
      const plName = (arg && arg.startsWith('playlist:')) ? (() => { try { return decodeURIComponent(arg.slice(9)); } catch { return arg.slice(9); } })() : (arg || '');
      html += mkItem(
        'Play playlist',
        `<button data-act="play" data-type="playlist" data-id="${attr(arg)}" data-name="${attr(plName)}">Play</button>
                 <button data-act="shuffle" data-type="playlist" data-id="${attr(arg)}" data-name="${attr(plName)}" class="secondary">Shuffle</button>`
      );
      const items = data || [];
      const start = this._browsePage * this._pageSize;
      const slice = items.slice(start, start + this._pageSize);
      slice.forEach((it: any) => {
        const name = typeof it === 'string' ? it : it.name;
        const id = typeof it === 'string' ? '' : it.id;
        idx += 1;
        const tlabel = trackLabel(idx + start, name);
        html += mkItem(
          `${tlabel}`,
          `<button data-act="play-track" data-id="${attr(id)}" data-kind="playlist" data-container="${attr(arg)}" data-name="${attr(name)}" data-idx="${idx + start}">Play</button>`
        );
      });
      if (hint) hint.textContent = `Tracks in ${plName}`;
      this._renderPager(items.length);
    } else if (section === 'search') {
      const albums = Array.isArray(data?.albums) ? data.albums : [];
      const artists = Array.isArray(data?.artists) ? data.artists : [];
      const playlists = Array.isArray(data?.playlists) ? data.playlists : [];
      const songs = Array.isArray(data?.songs || data?.tracks) ? (data.songs || data.tracks) : [];
      const total = albums.length + artists.length + playlists.length + songs.length;
      const start = this._browsePage * this._pageSize;
      const end = start + this._pageSize;
      let shown = 0;
      let idx = 0;
      const addGroup = (arr: any[], kind: string, heading: string) => {
        let addedInGroup = false;
        for (let j = 0; j < arr.length; j++) {
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
              const tlabel = trackLabel((j + 1), name);
              html += mkItem(`${tlabel}`, `<button data-act="play-track" data-id="${attr(id)}" data-kind="song" data-container="" data-name="${attr(name)}" data-idx="${j + 1}">Play</button>`);
            }
            shown++;
            if (shown >= this._pageSize) break;
          }
          idx++;
          if (shown >= this._pageSize) break;
        }
      };
      addGroup(albums, 'album', albums.length ? 'Albums' : '');
      if (shown < this._pageSize) addGroup(artists, 'artist', artists.length ? 'Artists' : '');
      if (shown < this._pageSize) addGroup(playlists, 'playlist', playlists.length ? 'Playlists' : '');
      if (shown < this._pageSize) addGroup(songs, 'song', songs.length ? 'Songs' : '');
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
    }
    this._initBrowseMarquee();
  }

  private _initBrowseMarquee() {
    const rows = this.shadowRoot?.querySelectorAll('#browseList .label');
    rows?.forEach((vp) => {
      const inner = vp.querySelector('.label-inner') as HTMLElement;
      if (inner) this._marqueeOnce(vp as HTMLElement, inner);
    });
  }

  private _marqueeOnce(viewport: HTMLElement, inner: HTMLElement) {
    inner.style.transition = 'none';
    inner.style.transform = 'translateX(0)';
    const old = this._marqTimers.get(inner);
    if (old) { clearTimeout(old); this._marqTimers.delete(inner); }
    requestAnimationFrame(() => {
      const vw = viewport.clientWidth;
      const iw = inner.scrollWidth;
      const delta = Math.max(0, iw - vw);
      if (delta <= 4) return;
      const pxPerSec = 40;
      const dur = Math.max(6, delta / pxPerSec);
      const delayMs = 3000;
      const startTid = setTimeout(() => {
        inner.style.transition = `transform ${dur}s linear`;
        inner.style.transform = `translateX(-${delta}px)`;
        const resetTid = setTimeout(() => {
          inner.style.transition = 'none';
          inner.style.transform = 'translateX(0)';
        }, Math.round(dur * 1000 + 2000));
        this._marqTimers.set(inner, resetTid);
      }, delayMs);
      this._marqTimers.set(inner, startTid);
    });
  }

  private _isTop(section: string): boolean {
    return section === 'playlists' || section === 'albums' || section === 'artists';
  }

  private _alphaSet(letter: string) {
    this._browseAlpha = letter || '';
    this._browsePage = 0;
    this._renderBrowse();
  }

  private _pageSet(p: number) {
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

  private _getFilteredTopItems(): any[] {
    const section = this._browseSection;
    const baseRaw = Array.isArray(this._browseCache[section]) ? [...this._browseCache[section]] : [];
    const arr = baseRaw.map((x: any) => (typeof x === 'string' ? { id: '', name: x } : x));
    const norm = (s: string) => String(s || '').replace(/^[^A-Za-z0-9]+/, '');
    arr.sort((a: any, b: any) => norm(a.name).localeCompare(norm(b.name), undefined, { sensitivity: 'base' }));
    const L = (this._browseAlpha || '').toUpperCase();
    if (!L) return arr;
    if (L === '#') return arr.filter((o: any) => !/^[A-Z]/i.test(norm(o.name).charAt(0)));
    return arr.filter((o: any) => norm(o.name).toUpperCase().startsWith(L));
  }

  private _renderPager(itemsLen: number) {
    const pager = this.shadowRoot?.querySelector('#browsePager') as HTMLElement;
    if (!pager) return;

    const pages = Math.max(1, Math.ceil(itemsLen / this._pageSize));
    const currentPage = this._browsePage + 1;

    // Show pager if there are multiple pages or items to paginate
    if (pages > 1 || itemsLen > this._pageSize) {
      pager.style.display = '';

      // Update navigation buttons
      const firstBtn = this.shadowRoot?.querySelector('#pageFirst') as HTMLButtonElement;
      const prevBtn = this.shadowRoot?.querySelector('#pagePrev') as HTMLButtonElement;
      const nextBtn = this.shadowRoot?.querySelector('#pageNext') as HTMLButtonElement;
      const lastBtn = this.shadowRoot?.querySelector('#pageLast') as HTMLButtonElement;
      const pageInfo = this.shadowRoot?.querySelector('#pageInfo') as HTMLElement;

      if (firstBtn) firstBtn.disabled = this._browsePage === 0;
      if (prevBtn) prevBtn.disabled = this._browsePage === 0;
      if (nextBtn) nextBtn.disabled = this._browsePage >= pages - 1;
      if (lastBtn) lastBtn.disabled = this._browsePage >= pages - 1;
      if (pageInfo) pageInfo.textContent = `Page ${currentPage} of ${pages}`;

      // Update alphabet letters
      this._renderAlphabetLetters();
    } else {
      pager.style.display = 'none';
    }
  }

  private _renderAlphabetLetters() {
    const alphaRow = this.shadowRoot?.querySelector('#alphaRow') as HTMLElement;
    if (!alphaRow) return;

    const letters = this._computeLetters();
    const currentAlpha = this._browseAlpha;

    let html = '';
    letters.forEach(letter => {
      const activeClass = letter === currentAlpha ? ' active' : '';
      html += `<button class="letterbtn${activeClass}" data-letter="${letter}">${letter}</button>`;
    });

    alphaRow.innerHTML = html;
  }

  private _browseBack() {
    if (!this._browseStack.length) return;
    const prev = this._browseStack.pop();
    if (prev) this._browseLoad(prev.section, prev.arg);
  }

  private _browseListClick(ev: MouseEvent) {
    const btn = (ev.target as Element).closest('button');
    if (!btn) {
      const row = (ev.target as Element).closest('.item');
      if (!row) return;
      const act = row.getAttribute('data-act');
      if (!act) return;
      const id = row.getAttribute('data-id') || '';
      const name = row.getAttribute('data-name') || '';
      if (act === 'open-album') {
        this._browseStack.push({ section: this._browseData!.section, arg: this._browseData!.arg });
        this._browseLoad('album_tracks', id || ('album:' + name));
      } else if (act === 'open-playlist') {
        this._browseStack.push({ section: this._browseData!.section, arg: this._browseData!.arg });
        this._browseLoad('playlist_tracks', id || ('playlist:' + name));
      } else if (act === 'open-artist') {
        this._browseStack.push({ section: this._browseData!.section, arg: this._browseData!.arg });
        this._browseLoad('artist_albums', id || ('artist:' + name));
      }
      return;
    }
    const act = btn.getAttribute('data-act');
    const id = btn.getAttribute('data-id') || '';
    const name = btn.getAttribute('data-name') || '';
    if (act === 'open-album') {
      this._browseStack.push({ section: this._browseData!.section, arg: this._browseData!.arg });
      this._browseLoad('album_tracks', id || ('album:' + name));
    } else if (act === 'open-playlist') {
      this._browseStack.push({ section: this._browseData!.section, arg: this._browseData!.arg });
      this._browseLoad('playlist_tracks', id || ('playlist:' + name));
    } else if (act === 'open-artist') {
      this._browseStack.push({ section: this._browseData!.section, arg: this._browseData!.arg });
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

  private _computeLetters(): string[] {
    const section = this._browseSection;
    if (!this._isTop(section)) return [];
    const baseRaw = Array.isArray(this._browseCache[section]) ? [...this._browseCache[section]] : [];
    const arr = baseRaw.map((x: any) => (typeof x === 'string' ? { id: '', name: x } : x));
    const norm = (s: string) => String(s || '').replace(/^[^A-Za-z0-9]+/, '');
    const set = new Set<string>();
    for (const it of arr) {
      const n = norm(it.name);
      if (!n) continue;
      let ch = '#';
      for (const c of n) {
        if (/[A-Z]/i.test(c)) {
          ch = c.toUpperCase();
          break;
        }
      }
      set.add(ch);
    }
    const out: string[] = [];
    if (set.has('#')) out.push('#');
    for (let c = 65; c <= 90; c++) {
      const L = String.fromCharCode(c);
      if (set.has(L)) out.push(L);
    }
    return out;
  }

  private async _browseSearch(term: string) {
    this._browseStack = [];
    this._browseSection = 'search';
    await this._browseLoad('search', term);
  }

  private async _playContainer(type: string, name: string, shuffle: boolean = false, idArg: string = '') {
    const entity = this._entityId();

    // Extract clean name from ID if needed
    let cleanName = name;
    if (idArg) {
      if (idArg.startsWith(`${type}:`)) {
        try {
          cleanName = decodeURIComponent(idArg.slice(type.length + 1));
        } catch {
          cleanName = idArg.slice(type.length + 1);
        }
      } else {
        cleanName = idArg;
      }
    }

    // Build the correct media content ID based on type and shuffle
    let mediaContentId = '';

    if (shuffle) {
      if (type === 'playlist') {
        mediaContentId = `shuffle_playlist:${cleanName}`;
      } else if (type === 'album') {
        mediaContentId = `shuffle_album:${cleanName}`;
      } else if (type === 'artist') {
        // For artist shuffle, use the special queue_artist_shuffled API
        try {
          await this.hass.callApi('POST', 'apple_music/queue_artist_shuffled', { artist: cleanName });
          return;
        } catch (error) {
          console.warn('Failed to shuffle artist:', error);
          return;
        }
      }
    } else {
      if (type === 'playlist') {
        mediaContentId = `play_playlist:${cleanName}`;
      } else if (type === 'album') {
        mediaContentId = `play_album:${cleanName}`;
      } else if (type === 'artist') {
        mediaContentId = `artist:${cleanName}`;
      }
    }

    if (mediaContentId) {
      try {
        await this.hass.callService('media_player', 'play_media', {
          entity_id: entity,
          media_content_type: 'music',
          media_content_id: mediaContentId,
        });
      } catch (error) {
        console.warn(`Failed to play ${type}:`, error);
      }
    }
  }

  private _playTrack(kind: string | null, container: string, name: string, idx: number, idArg: string = '') {
    const entity = this._entityId();
    if (idArg) {
      this.hass.callService('media_player', 'play_media', {
        entity_id: entity,
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
    this.hass.callService('media_player', 'play_media', {
      entity_id: entity,
      media_content_type: 'music',
      media_content_id: id,
    });
  }
}
