# Apple Music Server – Home Assistant Companion

Control Apple Music on macOS and route audio to your AirPlay devices from Home Assistant. This project ships a Home Assistant integration and a lightweight frontend that talks to a small HTTP server running on your Mac.

The macOS server project is here: https://github.com/csilvertooth/music_app_server

Repository layout (manual install reference):
```
apple_music_server_haos/
  custom_components/apple_music/
    frontend/dist/music-controller-panel.js
    ... (component files)
```

## Requirements

- Home Assistant 2023.8+ (2025.8.x recommended)
- macOS Music App Server running and reachable on your network
  - Default UI/API: `http://<mac-host>:7766/ui` and `http://<mac-host>:7766`
- Network connectivity from HA to the Mac on the chosen port (default 7766)

## Install

Option A — HACS (recommended)
1) In HACS → Integrations → Custom repositories, add this repo URL and select “Integration”.
2) Install “Music App Controller (macOS)”.
3) Restart Home Assistant when prompted.

Option B — Manual
1) Copy `custom_components/apple_music` into your HA config directory’s `custom_components` folder.
2) Restart Home Assistant.
3) Optional (fallback only): add the frontend file as a Lovelace resource if your dashboard does not load the custom cards automatically.
   - No‑copy resource: Settings → Dashboards → Resources → Add
     - URL: `/apple_music_panel/music-controller-panel.js`
     - Type: `module`
   - Or copy to local and reference it:
     - Copy `custom_components/apple_music/frontend/dist/music-controller-panel.js` → `config/www/apple_music/music-controller-panel.js`
     - Add a resource with URL: `/local/apple_music/music-controller-panel.js`, Type: `module`

## Quick Start

1) In HA: Settings → Devices & Services → Add Integration → “Music App Controller (macOS)”.
2) Enter the IP/hostname of the Mac running the Music App Server.
3) Port is 7766 unless you changed it in the server settings.
4) Choose a Device Name and Area → Finish.
5) Optional: In the integration’s options, enable “Show Panel” to get a sidebar entry that opens the controller UI.

## Using the cards

- With the sidebar enabled, the panel loads the JS module automatically on modern HA.
- If you prefer adding cards to an existing Dashboard and the cards don’t appear, add the Lovelace resource (see Install → Optional) and then include cards like the examples below.

Example Dashboard YAML adding the two cards:
```yaml
views:
  - title: Home
    sections:
      - type: grid
        cards:
          - type: horizontal-stack
            cards:
              - type: custom:music-now-playing-card
      - type: grid
        cards:
          - type: horizontal-stack
            cards:
              - type: custom:music-airplay-outputs-card
```

## How it works

The integration proxies a small set of endpoints to the macOS server; the frontend calls those to control playback and devices.
- Playback: `/playpause`, `/next`, `/previous`, `/resume`
- Now Playing + artwork: `/now_playing`, `/artwork`
- Master volume: `/master_volume` (GET/POST)
- AirPlay devices: `/airplay_full`, `/set_devices`, `/set_device_volume`, `/current_devices`
- Settings: `/settings` (read), `/restart` after save if port changed
- Live updates: `/events` (SSE stream)

If you embed the server’s `/ui` via iframe, its own UI handles those calls internally — no extra HA plumbing needed.

## Troubleshooting

- No devices listed: Open the Music app once on the Mac. First‑run permissions can block AppleScript until you approve them.
- Buttons do nothing: From your browser, verify you can reach `http://<mac-host>:7766`. If HA runs HTTPS and your server is HTTP, use the iframe approach.
- Artwork missing: Some tracks may not have embedded artwork; the server falls back where possible.
