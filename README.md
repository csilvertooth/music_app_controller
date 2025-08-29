# Music App Controller (macOS) – Home Assistant custom integration

Control the Music app on a Mac (via a small Flask + AppleScript controller) from Home Assistant.  This is 1 part of the 2 part solution.  You will also need a Mac to the run the server application to control Apple Music from Home Assistant.  If you don't have a Mac and don't use Apple Music this project is not for you.

- Browse Playlists / Albums / Artists (with cached artwork)
- Playback control
- AirPlay outputs (current devices), per-device volume
- Native **search** via `media_player.search_media`
- Cache management services
- “🔎 Search…” pseudo-node in Media Browser

## First install the Server Application on your Mac.
1. Download Music App Server from -> https://github.com/csilvertooth/music_app_server/releases
2. Follow the directions to get that setup and working here -> https://github.com/csilvertooth/music_app_server
## Install via HACS
1. HACS → Integrations → ⋯ → **Custom repositories**
2. Add `https://github.com/csilvertooth/music_app_controller` as **Integration**
3. Install **Music App Controller (macOS)**
4. Restart Home Assistant
5. Settings → Devices & Services → **Add Integration** → *Music App Controller (macOS)* → enter Controller IP/port

## Manual install

Copy `custom_components/apple_music/` into your HA `config/custom_components/` and restart HA.

## Examples (optional helpers)
This repo includes optional YAML helpers under `examples/` that you can copy into your Home Assistant setup. They add a simple dropdown and script for routing AirPlay outputs, plus an automation to keep the list in sync.

### Option A — Packages (recommended)
1. Enable packages (once) by adding this to your `configuration.yaml`:
   ```yaml
   homeassistant:
     packages: !include_dir_named packages
   ```
2. Copy `examples/packages/music_app_controller.yaml` into your HA config at:
   ```
   config/packages/music_app_controller.yaml
   ```
3. Restart Home Assistant (helpers like `input_select` require a restart).

### Option B — Classic includes
If you don’t use packages, split the same YAML into your existing files:
- Merge the `input_select:` block into `configuration.yaml` (under your existing `input_select:` key)
- Append the `script:` block to `scripts.yaml`
- Append the `automation:` block to `automations.yaml`

You can reload Automations/Scripts from Developer Tools, but adding a new `input_select` requires a restart.

## Disclaimer
This is an independent, community-built project. It is not affiliated with or endorsed by Apple Inc. or Nabu Casa.

## Trademarks
Apple, Apple Music, and macOS are trademarks of Apple Inc., registered in the U.S. and other countries. Home Assistant is a trademark of Nabu Casa, Inc. Any other trademarks are the property of their respective owners.