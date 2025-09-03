# Apple Music Server – Home Assistant Companion

What is it?

This companion app was created to facilitate control of your Apple Music application, and more specifically, Airplay 2 (or 1) devices in your house.  If you have an abundance of Airplay 2 devices, and you use Apple Music as your music hub, then hopefully this will be useful.

Components:

A Home Assistant (HA) Integration that communicates with the Music App Server (https://github.com/csilvertooth/music_app_server) running on your Mac which then facilitates control of the Apple Music application.

The HA Music App Controller is a lightweight frontend.  The Music App Server is an http server you run on the Mac that has your Apple Music App/Library.  It uses Applescript to control the Apple Music Application.

Repository layout reference (for manual install):
```
apple_music_server_haos/
  custom_components/apple_music/
    frontend/dist/music-controller-panel.js
    ... (component files)
```

## Requirements

- macOS Music App Server running and reachable on your network
  - Default UI/API: `http://<mac-host>:7766/ui` and `http://<mac-host>:7766` (changeable in Settings)
- Home Assistant 2023.8+ recommended

## Install

Option A — HACS (recommended)
1) In HACS → Integrations → Custom repositories, add this repo url in the Repository field and select “Integration” as the Type.
2) Install “Music App Controller (macOS)”.
3) Restart HA when prompted.

Option B — Manual copy
1) Copy `custom_components/apple_music` into your HA config directory’s `custom_components` folder.
2) Restart Home Assistant.
3) Expose the frontend file as a Lovelace resource:
   - Copy `custom_components/apple_music/frontend/dist/music-controller-panel.js` to `config/www/apple_music/music-controller-panel.js`.
   - In Settings → Dashboards → Resources, add:
     - URL: `/local/apple_music/music-controller-panel.js`
     - Type: `module`

Firewall/Network
- Ensure your HA host can reach your Mac’s server port (default 7766).

## Configuration

1) In Settings → Devices & Services → Add Integration and look for Music App Controller (macOS)
2) Your controller IP/Hostname should be the IP/Hostname of the macOS computer where the Music App Server is running.
3) The default port is 7766.  If you changed this from the default enter the port you set here and click submit.
4) Choose your Device Name and Area.  Then click Finish

You should now see Music App Controller (macOS) in the integrations list on your Home Assistant server.  If you click on it and select the gear for options you can enable "Show Panel" which is the easiest way to get started using this.

If you want to add these custom cards to an existing Dashboard follow these instructions below.

1) In Settings → Dashboards click the 3 dots in the upper right and then click Resources.
2) In the bottom right click "Add resource"
3) For URL → /apple_music_panel/music-controller-panel.js then select JavaScript module and click create.
4) Add the Yaml below to your dashboard.

Here is some example yaml you can add to a dashboard to add the two cards.
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


## How HA interacts with the server

The frontend panel (custom card) calls the macOS server REST API. Key routes used:
- Playback: `/playpause`, `/next`, `/previous`, `/resume`
- Now Playing + artwork: `/now_playing`, `/artwork`
- Master volume: `/master_volume` (GET/POST)
- AirPlay devices: `/airplay_full`, `/set_devices`, `/set_device_volume`, `/current_devices`
- Settings: `/settings` (read), then `/restart` after save if the port changed
- Live updates: `/events` SSE stream

If you embed the `/ui` via iframe, the server’s own UI handles these calls internally and no extra HA plumbing is required.

## Troubleshooting

- No devices listed: Music app might need to be opened once. The server launches it, but first‑run permissions can block AppleScript until approved.
- Buttons do nothing: Verify network reachability from your browser to `http://<mac-host>:7766`. Try the iframe approach if your HA runs HTTPS and your server runs HTTP.
- Artwork missing: Some tracks may not have embedded artwork; the server falls back to artist art where possible.

