// music-airplay-join-card.ts
import { LitElement, html, css, TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { HomeAssistant } from 'custom-card-helpers';

interface Config {
  title?: string;
  entity?: string;
}

@customElement('music-airplay-join-card')
class MusicAirplayJoinCard extends LitElement {
  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() private _config: Config = {};
  @state() private _devices: string[] = [];
  @state() private _current: Set<string> = new Set();
  @state() private _selected: Set<string> = new Set();
  @state() private _groupMembers: string[] = [];
  @state() private _isJoining = false;

  // For independent operation without the panel store

  static styles = css`
    ha-card { position: relative; }
    .head { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; padding:0 16px; }
    .content { padding:0 16px 16px; }
    .grid { display:grid; gap:12px; }
    .section { margin-bottom:20px; }
    .section-title { font-weight:500; margin-bottom:8px; color: var(--primary-text-color); }
    .device-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap:8px; }
    .device-chip { display:flex; align-items:center; gap:8px; padding:8px 12px; border:2px solid var(--divider-color); border-radius:16px; background: var(--card-background-color); cursor:pointer; transition: all 0.2s; }
    .device-chip:hover { border-color: var(--primary-color); }
    .device-chip.selected { background: var(--primary-color); color: white; border-color: var(--primary-color); }
    .device-chip.current { border-color: var(--accent-color); }
    .device-chip.selected.current { border-color: var(--accent-color); }
    .device-name { font-size:14px; }
    .status-indicator { width:8px; height:8px; border-radius:50%; }
    .status-indicator.active { background: var(--accent-color); }
    .status-indicator.selected { background: var(--primary-color); }
    .join-button { width:100%; padding:12px; background: var(--primary-color); color: white; border:none; border-radius:8px; font-size:16px; font-weight:500; cursor:pointer; margin-top:16px; transition: opacity 0.2s; }
    .join-button:hover:not(:disabled) { opacity:0.9; }
    .join-button:disabled { opacity:0.6; cursor:not-allowed; }
    .current-group { padding:12px; background: var(--secondary-background-color); border-radius:8px; }
    .group-list { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
    .group-tag { padding:4px 8px; background: var(--accent-color); color: white; border-radius:12px; font-size:12px; }
    .select-all { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
    .no-devices { text-align:center; padding:20px; color: var(--secondary-text-color); }
    .loading { opacity:0.7; pointer-events:none; }
  `;

  setConfig(config: Config) {
    this._config = { ...config };
  }

  protected render(): TemplateResult {
    const title = this._config.title || 'Join AirPlay Sources';
    const entityId = this._config.entity || 'media_player.music_control_player';
    const entity = this.hass.states[entityId];
    const availableDevices = entity?.attributes?.available_devices || [];
    const selectedDevices = entity?.attributes?.selected_devices || [];

    return html`
      <ha-card .header=${title}>
        <div class="head">
          <div class="muted">Select devices to join for synchronized playback</div>
        </div>
        <div class="content">
          ${this._renderCurrentGroup(selectedDevices)}
          ${this._renderDeviceSelector(availableDevices)}
          ${this._renderJoinButton(selectedDevices)}
        </div>
      </ha-card>
    `;
  }

  private _renderCurrentGroup(selectedDevices: string[]): TemplateResult {
    if (!selectedDevices.length) {
      return html`
        <div class="section">
          <div class="section-title">Current Group</div>
          <div class="current-group">
            <span>No devices currently joined</span>
          </div>
        </div>
      `;
    }

    return html`
      <div class="section">
        <div class="section-title">Current Group (${selectedDevices.length} device${selectedDevices.length > 1 ? 's' : ''})</div>
        <div class="current-group">
          <div class="group-list">
            ${selectedDevices.map(device => html`
              <span class="group-tag">${device}</span>
            `)}
          </div>
        </div>
      </div>
    `;
  }

  private _renderDeviceSelector(availableDevices: string[]): TemplateResult {
    if (!availableDevices.length) {
      return html`
        <div class="section">
          <div class="section-title">Available Sources</div>
          <div class="no-devices">
            No AirPlay devices available
          </div>
        </div>
      `;
    }

    return html`
      <div class="section">
        <div class="section-title">Available Sources</div>
        <div class="select-all">
          <label>
            <input type="checkbox"
                   .checked=${this._selected.size === availableDevices.length && availableDevices.length > 0}
                   @change=${this._toggleSelectAll}
                   ?indeterminate=${this._selected.size > 0 && this._selected.size < availableDevices.length} />
            Select All
          </label>
        </div>
        <div class="device-grid">
          ${availableDevices.map(device => this._renderDeviceChip(device))}
        </div>
      </div>
    `;
  }

  private _renderDeviceChip(device: string): TemplateResult {
    const isSelected = this._selected.has(device);
    const isCurrent = this._current.has(device);

    return html`
      <div class="device-chip ${isSelected ? 'selected' : ''} ${isCurrent ? 'current' : ''}"
           @click=${() => this._toggleDevice(device)}>
        <div class="status-indicator ${isCurrent ? 'active' : ''} ${isSelected ? 'selected' : ''}"></div>
        <span class="device-name">${device}</span>
      </div>
    `;
  }

  private _renderJoinButton(selectedDevices: string[]): TemplateResult {
    const selectedCount = this._selected.size;
    const currentCount = selectedDevices.length;
    const hasChanges = selectedCount !== currentCount ||
                      !Array.from(this._selected).every(d => selectedDevices.includes(d));

    const buttonText = this._isJoining ? 'Joining...' :
                      selectedCount === 0 ? 'Clear Group' :
                      selectedCount === 1 ? `Join 1 Device` : `Join ${selectedCount} Devices`;

    return html`
      <button class="join-button"
              ?disabled=${!hasChanges || this._isJoining}
              @click=${this._joinDevices}>
        ${buttonText}
      </button>
    `;
  }

  private _toggleDevice(device: string): void {
    const newSelected = new Set(this._selected);
    if (newSelected.has(device)) {
      newSelected.delete(device);
    } else {
      newSelected.add(device);
    }
    this._selected = newSelected;
  }

  private _toggleSelectAll(e: Event): void {
    const target = e.target as HTMLInputElement;
    const entityId = this._config.entity || 'media_player.music_control_player';
    const entity = this.hass.states[entityId];
    const availableDevices = entity?.attributes?.available_devices || [];

    if (target.checked) {
      this._selected = new Set(availableDevices);
    } else {
      this._selected = new Set();
    }
  }

  private async _joinDevices(): Promise<void> {
    const entityId = this._config.entity || 'media_player.music_control_player';
    const selectedDevices = Array.from(this._selected);

    this._isJoining = true;
    this.requestUpdate();

    try {
      await this.hass.callService('apple_music', 'set_selected_airplay_devices', {
        target: { entity_id: entityId },
        devices: selectedDevices
      });

      // Update local state to reflect the change
      this._current = new Set(selectedDevices);
      this.requestUpdate();

    } catch (error) {
      console.error('Failed to join devices:', error);
    } finally {
      this._isJoining = false;
      this.requestUpdate();
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    // Listen to entity state changes
    this._listenToEntityChanges();
  }

  private _listenToEntityChanges(): void {
    const entityId = this._config.entity || 'media_player.music_control_player';
    this.hass.connection.subscribeEvents(() => {
      const entity = this.hass.states[entityId];
      if (entity) {
        const selectedDevices = entity.attributes?.selected_devices || [];
        this._current = new Set(selectedDevices);
        this._selected = new Set(selectedDevices); // Sync selection
        this.requestUpdate();
      }
    }, `state_changed`);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
  }

  // Let HA estimate size in grid layouts
  public getCardSize(): number { return 6; }
}

declare global {
  interface HTMLElementTagNameMap {
    'music-airplay-join-card': MusicAirplayJoinCard;
  }
}
