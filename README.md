# gladys-denon-avr

External integration for [Gladys Assistant](https://gladysassistant.com) to control a Denon or
Marantz AV receiver: power, volume, mute and input source. Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js), from
the official [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

Talks the "AVR Control" protocol shared by (almost) the whole Denon/Marantz networked receiver
lineup (Telnet, TCP port 23) — not hardcoded to a specific model.

## What it does

- **Discovery**: SSDP/UPnP, mediated by the Gladys core (`network_discovery: ["ssdp"]` in the
  manifest) — receivers are found automatically on the LAN, whether powered on or in standby
  (Network Standby required). A manual IP fallback is available in the Configuration screen for
  networks that block multicast.
- **Power / Volume / Mute**: controllable features (`TELEVISION` category), fed in real time by
  the Telnet session the receiver itself pushes state changes to — no polling.
- **Input source**: a dropdown on the dashboard, backed by `TEXT.SELECT` +
  `supported_options` (the receiver's own SI codes) — **not** the generic `TELEVISION.SOURCE`
  type, which Gladys' front-end renders as a one-shot remote-control button with no way to pick
  a specific input (see the design notes in [`src/devices/avr.js`](./src/devices/avr.js)). The
  **Select input** manifest action is kept as an equivalent second path regardless. The
  `source_overrides` config field lets you rename an entry (the input actually plugged into
  `SAT/CBL` might really be a Chromecast) or hide ones you never use.
- **Sound mode**: same `TEXT.SELECT` dropdown mechanism as the source, built from
  `SOUND_MODE_CODES` in [`src/denon/protocol.js`](./src/denon/protocol.js) — the least certain
  part of this integration (mode naming shifted a lot across Denon/Marantz generations), see
  "Tested and confirmed" below.
- **Playback controls**: Play/Pause/Next/Previous buttons (`MUSIC` category), meaningful while a
  NET/USB/streaming source (Qobuz, Spotify Connect via HEOS...) is active — a no-op otherwise.
- **Now playing**: a read-only "Artist - Title" line, composed from the two status lines the
  receiver pushes while streaming.
- **Test connection** action: on-demand query + a summary of the receiver's current state.

## New to this codebase? Start here

An "external integration" is just a small Node.js program that Gladys (the home automation
hub) runs as its own **Docker container**, next to the main Gladys server. The two only ever
talk over **one WebSocket connection**, opened by the SDK
([`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)) —
you never touch that connection directly, you just react to the events it emits (`onScanRequest`,
`onSetValue`, `onDeviceCreated`...) and call its methods (`publishState`, `getConfig`...).

This integration then opens a **second, completely separate connection**: a plain TCP/Telnet
socket (port 23) straight to the AV receiver on the local network. That's the actual point of
the project — everything in `src/denon/` and `src/devices/avr.js` exists to manage that second
connection and translate between "what the receiver says" and "what Gladys understands".

```
┌────────────┐   WebSocket (SDK, handled for you)   ┌──────────────────────┐   Telnet :23   ┌──────────┐
│ Gladys hub │ ───────────────────────────────────▶ │  This integration    │ ─────────────▶ │ Denon/   │
│ (the app)  │ ◀─────────────────────────────────── │  (this repo, in a    │ ◀───────────── │ Marantz  │
└────────────┘   events / commands / config          │  Docker container)   │   plain-text    │ AVR      │
                                                       └──────────────────────┘   lines         └──────────┘
```

Recommended reading order, each file assumes only the one(s) before it:

1. [`src/denon/protocol.js`](./src/denon/protocol.js) — no dependencies, no I/O: just
   string-in/string-out functions that translate a Telnet line to a Gladys value and back. Read
   this first to understand the receiver's language.
2. [`src/denon/telnet.js`](./src/denon/telnet.js) — opens the actual TCP socket, splits the
   incoming stream into lines, and reconnects automatically if the connection drops. Knows
   nothing about Denon's protocol or about Gladys.
3. [`src/denon/discovery.js`](./src/denon/discovery.js) — how a receiver is found on the LAN
   before you even have its IP address (SSDP/UPnP).
4. [`src/devices/avr.js`](./src/devices/avr.js) — the glue: keeps one Telnet client per AVR the
   user added, and wires `protocol.js` + `telnet.js` to what the SDK expects (features, actions).
5. [`src/devices/index.js`](./src/devices/index.js) and [`src/config.js`](./src/config.js) —
   small composition/config-normalization helpers used by the entry point.
6. [`index.js`](./index.js) — the entry point. On purpose the shortest, least interesting file:
   it only creates the SDK client and wires its events to the functions above.

## Dependencies

This project intentionally has a **single runtime dependency**:

| Package                                                                                              | Role                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@gladysassistant/integration-sdk`](https://www.npmjs.com/package/@gladysassistant/integration-sdk) | Everything about talking to the Gladys hub: authentication, the WebSocket connection and its reconnection, and the event/method API used in `index.js` (`onScanRequest`, `publishState`, ...). |

Everything else needed at runtime is a Node.js built-in, on purpose (fewer dependencies = fewer
things that can break or need updating): `node:net` for the Telnet socket
([`src/denon/telnet.js`](./src/denon/telnet.js)) and the global `fetch` for reading a receiver's
UPnP description ([`src/denon/discovery.js`](./src/denon/discovery.js)).

Dev-only dependencies (never shipped in the Docker image, see the `Dockerfile`'s
`npm ci --omit=dev`):

| Package                                                        | Role                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `eslint` + `@eslint/js` + `eslint-config-prettier` + `globals` | Linting (`npm run lint`) — catches real bugs (undefined vars, dead code...). |
| `prettier`                                                     | Code formatting (`npm run format` / `format:check`) — no style debates.      |

Testing uses no library at all: `npm test` runs Node's own built-in test runner (`node --test`,
requires no dependency), see `test/` and the "Quality checks" section below.

### Keeping dependencies up to date

[Dependabot](https://docs.github.com/en/code-security/dependabot/dependabot-version-updates)
(config: [`.github/dependabot.yml`](./.github/dependabot.yml)) checks weekly for newer versions
of the three things this repo pins — npm packages, the Dockerfile's base image, and the GitHub
Actions used by the workflows — and opens a PR by itself for each one it finds, no bot account
or extra service to install.

The regression check for those PRs is the existing CI workflow
([`.github/workflows/ci.yml`](./.github/workflows/ci.yml)): it already runs on every pull
request (format, lint, tests), Dependabot's included, so a PR that breaks something simply
won't go green. Nothing merges by itself — review the diff (mainly the `CHANGELOG`/release
notes Dependabot links in the PR body) and merge it like any other PR once CI is green.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no protocol logic)
├─ src/
│  ├─ devices/
│  │  ├─ avr.js                      # discovery payloads, Telnet connection registry, onSetValue, actions
│  │  └─ index.js                    # composes SSDP discovery + the manual host fallback
│  ├─ denon/
│  │  ├─ protocol.js                 # PURE: parse Telnet lines <-> feature values, build commands
│  │  ├─ telnet.js                   # raw net.Socket client: line framing, reconnect w/ backoff
│  │  └─ discovery.js                # SSDP scan + UPnP description.xml parsing
│  └─ config.js                      # config defaults + normalization
├─ test/                             # one *.test.js per src/ file above, node --test, no library
├─ test-fixtures/
│  └─ fakeGladys.js                  # minimal in-memory stand-in for the SDK client, used by tests
│                                     # — deliberately OUTSIDE test/: `node --test` treats every
│                                     # .js file under test/ as a test file to run, fixtures included
├─ scripts/
│  └─ debug-telnet.js                # talk to a real receiver's Telnet session directly, without
│                                     # running Gladys at all — `node scripts/debug-telnet.js <host>`
├─ docs/
│  └─ en.md / fr.md                  # END-USER documentation, re-hosted by Gladys itself in its
│                                     # UI (not this README) — what someone installing the
│                                     # integration from the Gladys store reads, not a developer
├─ gladys-assistant-integration.json # the "manifest": declares the integration to the Gladys
│                                     # store/hub (name, version, Docker image, the config form
│                                     # and actions you see in the Configuration screen)
├─ Dockerfile                        # packages index.js + src/ into the image Gladys runs,
│                                     # Node 24 Alpine, prod dependencies only
└─ cover.png                         # catalog cover, 800×534 px, ≤150 KB
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="denon-avr" \
LOG_LEVEL=debug \
npm start
```

## Quality checks

```bash
npm run format:check   # Prettier
npm run format          # Prettier, write
npm run lint             # ESLint
npm test                 # node --test
```

`protocol.js` and `telnet.js`/`discovery.js` are unit-tested without a real receiver: pure
parsing/building functions, a local fake Telnet server (`net.createServer`), and a mocked
`fetch`/`scanNetwork`. See [`test/`](./test). Test doubles/fixtures live in
[`test-fixtures/`](./test-fixtures), not `test/` itself — `node --test` runs every `.js` file it
finds under `test/`, fixtures included, so one in there silently becomes a passing 0-assertion
"test" instead of the helper it's meant to be.

To poke a real receiver directly, without running Gladys at all:
`node scripts/debug-telnet.js <host> [port]` opens the same Telnet client this integration uses
in production and gives you a prompt to type raw protocol commands (`PW?`, `MV50`, `SITUNER`...).

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

Add the GitHub topic `gladys-assistant-integration`, then **Actions → Release → Run workflow**
(bumps `package.json` + the manifest, tags, builds the multi-arch image). See the
[integration-template-js README](https://github.com/GladysAssistant/integration-template-js) for
the full publishing flow — unchanged from the template.

`gladys_version` is pinned to `>=4.86.0`: that's the floor `categories` needs to declare (checked
against the store's `manifest.schema.json` — an older core "rejects unknown manifest fields"
outright rather than ignoring just that one, so the two changes had to land together), and
comfortably covers the `TEXT.SELECT`/`supported_options` the input-source dropdown needs too
(exact minimum unconfirmed, but the feature already existed well before this core version).

## v1 scope

Power, volume, mute, input source (status + selection, with per-user renaming/hiding), sound
mode, network/USB playback controls, now-playing metadata, SSDP discovery. Deliberately out of
scope for now: multi-zone (Zone 2/3) and an HTTP fallback control channel — see the design notes
at the top of [`src/devices/avr.js`](./src/devices/avr.js) and
[`src/denon/discovery.js`](./src/denon/discovery.js).

## Tested and confirmed

Honest status, so it's clear what "it works" actually rests on:

- **Confirmed on a real Denon AVR-S970H**: unit tests and the store validator are green, and on
  the actual hardware (as of v1.0.3): static-IP detection, the Telnet connection, power/volume,
  the mute toggle (fixed in 1.0.2 — was re-sending the same command every press), and the
  input-source dropdown (`TEXT.SELECT` + `supported_options`, confirmed rendering and working on
  this user's Gladys core version).
- **Not yet confirmed** — implemented from protocol research, not yet run against real hardware:
  - **Sound mode**: the least certain part of this integration. `SOUND_MODE_CODES` in
    [`src/denon/protocol.js`](./src/denon/protocol.js) is a starting list — mode naming shifted
    repeatedly across Denon/Marantz generations, so this one specifically may need adjusting.
  - **Playback controls / now-playing metadata**: the `NS9x` transport codes and `NSE1`/`NSE2`
    now-playing lines aren't in the same official reference PDF as the rest of the protocol
    (network/HEOS control was documented later, less cleanly) — cross-checked against two
    independent community implementations that agree on the transport codes, but genuinely lower
    confidence than everything else here.
  - The volume mapping (`DENON_VOLUME_MAX` = 98, the receiver's raw scale ceiling) and multiple
    manual-fallback hosts (comma-separated `source_overrides`/`host`) — implemented and
    unit-tested, no real-hardware pass yet (the volume ceiling is a protocol-level constant, not
    a per-user "Maximum Volume" setting, so it shouldn't need calibration — see the comment above
    `DENON_VOLUME_MAX`).
  - The SSDP discovery flow itself (only the static-IP fallback has been confirmed so far).

  Use [`scripts/debug-telnet.js`](./scripts/debug-telnet.js) against your own receiver to check
  any of the above — in particular, send `MS?` and start streaming on a NET/USB source to see
  the real sound-mode and now-playing lines your model actually sends.

## License

Apache-2.0
