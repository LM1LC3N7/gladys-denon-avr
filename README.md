# gladys-denon-avr

External integration for [Gladys Assistant](https://gladysassistant.com) to control a Denon or
Marantz AV receiver: power, volume, mute and input source. Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js), from
the official [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

Talks the "AVR Control" protocol shared by (almost) the whole Denon/Marantz networked receiver
lineup (Telnet, TCP port 23) — not hardcoded to a specific model. On a HEOS-equipped receiver it
also opens a second, best-effort connection to the separate HEOS CLI service (port 1255) so that
playback controls actually reach HEOS-managed streaming sources (Qobuz, Spotify Connect, TIDAL,
TuneIn...) — see "Playback controls" below.

## What it does

- **Discovery**: SSDP/UPnP, mediated by the Gladys core (`network_discovery: ["ssdp"]` in the
  manifest) — receivers are found automatically on the LAN, whether powered on or in standby
  (Network Standby required). A manual IP fallback is available in the Configuration screen for
  networks that block multicast. Discovery is also re-run automatically on every connect/reconnect
  (`index.js`'s `'connected'` handler), not just when the user opens the Discovery tab: a device
  Gladys created before this integration added new features (e.g. the 1.0.4 playback controls)
  otherwise never shows the **Update** button that applies them — see "Re-publishing a device"
  in the SDK README for why a config/image change alone never does.
- **Power / Volume / Mute**: controllable features (`TELEVISION` category), fed in real time by
  the Telnet session the receiver itself pushes state changes to — no polling. **Volume: 25% and
  75% can never be displayed as themselves** — confirmed on real hardware (a slider that "jumps
  from 24% to 26%, can't land on 25%") and in the math: `percentToDenonVolume()`/
  `denonVolumeToPercent()` (`src/denon/protocol.js`) round-trip a plain 0-100 percent through the
  receiver's raw 0-`DENON_VOLUME_MAX` (98) scale, and compressing 101 possible percent values onto
  99 raw ones forces at least two collisions (pigeonhole principle) — raw `25` is the value both
  25% and 26% round to, but it reads back as 26%, so setting 25% is immediately overwritten by the
  receiver's own echo of what it actually did. This is an inherent consequence of the hardware only
  having 99 discrete volume steps for a 101-position percent scale, not a rounding bug to fix — the
  "gap" can be moved but never removed. The exact two percents affected depend on
  `DENON_VOLUME_MAX`, which is itself a generic default (see the comment above it), so don't expect
  25/75 to necessarily be the affected pair on every model/configuration.
- **Input source**: a dropdown on the dashboard, backed by `TEXT.SELECT` +
  `supported_options` (the receiver's own SI codes) — **not** the generic `TELEVISION.SOURCE`
  type, which Gladys' front-end renders as a one-shot remote-control button with no way to pick
  a specific input (see the design notes in [`src/devices/avr.js`](./src/devices/avr.js)). The
  **Select input** manifest action is kept as an equivalent second path regardless. The
  `source_overrides` config field lets you rename an entry (the input actually plugged into
  `SAT/CBL` might really be a Chromecast) or hide ones you never use.
- **Source index**: a plain read/write integer feature (`TELEVISION` category,
  `SENSOR.INTEGER` type — there's no neutral "just a number" category in the SDK, so this
  reuses `TELEVISION` since it's this device's own category, paired with a type none of Gladys'
  scene-editor special-casing (`DeviceSetValue.jsx`) hooks into, so it correctly falls through
  to a plain bounded number input/slider) that mirrors `Source` as a 0-based index into the
  dropdown's own `supported_options`, **as currently rendered — `source_overrides`-hidden
  entries excluded, and everything after a hidden one renumbers down**. Both features are built
  from the same `visibleSourceCodes()` helper in `src/devices/avr.js` so they can never disagree
  on what index N means, and `onLine()`'s handler republishes it in lockstep with `Source` on
  every push so it never goes stale. Exists specifically for scene automation — see "Scene
  automation" below for why this is (and isn't, depending on your Gladys version) needed
  alongside the `Source` dropdown itself.
- **Sound mode**: same `TEXT.SELECT` dropdown mechanism as the source, built from
  `SOUND_MODE_CODES` in [`src/denon/protocol.js`](./src/denon/protocol.js) — the least certain
  part of this integration (mode naming shifted a lot across Denon/Marantz generations), see
  "Tested and confirmed" below.
- **Playback controls**: Play/Pause/Next/Previous buttons (`MUSIC` category).
  **`MUSIC` features don't render in the plain device list** — Gladys' generic
  `SUPPORTED_FEATURE_TYPES` (`front/src/components/boxs/device-in-room/SupportedFeatureTypes.jsx`)
  doesn't include the `MUSIC` category at all, so there they fall back to a plain read-only row
  ("no recent value" is expected there, not a bug). Add a **Music** dashboard box for this device
  to get actual play/pause/skip buttons — that box also hard-requires a
  `MUSIC.PLAYBACK_STATE` feature to even initialize (`MusicBox.jsx` dereferences it
  unconditionally), which is why one is declared here even though nothing calls it a "button".
  Two separate command paths feed these buttons, picked automatically per press
  (`src/devices/avr.js`'s `onSetValue`, `src/heos/`):
  - **HEOS CLI** (port 1255) — used whenever this AVR's own IP has been matched to a HEOS
    `pid` (via `player/get_players`, on every connect). This is the path that actually reaches
    HEOS-managed streaming sources: Qobuz, Spotify Connect, TIDAL, TuneIn, Amazon Music...
  - **Legacy `NS9x` Telnet commands** — the fallback whenever no HEOS `pid` is known yet, HEOS
    CLI is unreachable (firewalled, or a non-HEOS/older model), or on a genuinely non-HEOS
    Net/USB source. This is the only path that existed before 1.1.0, and real-hardware feedback
    confirmed it has **no effect at all** on HEOS-managed sources — which is exactly why the HEOS
    path above was added.
  - **Limits**: this is implemented from the HEOS CLI protocol as documented by `pyheos`
    (the library behind Home Assistant's own official HEOS integration) — cross-checked, not
    directly verified on this project's own hardware, since exercising real Qobuz/Spotify
    playback isn't something these unit tests can do. If it misbehaves on your receiver,
    compare actual traffic with [`scripts/debug-heos.js`](./scripts/debug-heos.js) (next to
    [`scripts/debug-telnet.js`](./scripts/debug-telnet.js) for the legacy path) — see "Tested and
    confirmed" below.
- **Now playing**: a read-only "Artist - Title" line. Same two-path split as the buttons above:
  HEOS's `get_now_playing_media`/`event/player_now_playing_changed` when a `pid` is matched,
  otherwise the legacy `NSE1`/`NSE2` Telnet lines — HEOS-managed sources generally don't push
  those either, same root cause as the buttons. When HEOS is the source, the `artist` slot falls
  back to HEOS's own separate `station` payload field (`parseNowPlayingMedia()` in
  `src/heos/protocol.js`) whenever HEOS doesn't report a real artist — confirmed on real hardware:
  an internet radio stream with no ICY/ID3 metadata otherwise showed just a generic stream
  description ("63 kbps aac") with no indication of which station, even though the receiver's own
  front display shows the station name (e.g. "Oui FM") it gets from that same field. Never
  overwrites an artist HEOS did report.
- **Playback state / now-playing refresh**: once a HEOS `pid` is matched, it becomes the
  _authoritative_ source for `MUSIC.PLAYBACK_STATE` and "Now playing" — the legacy `NSE0`/`NSE1`/
  `NSE2` lines are ignored for those two features from then on (they don't track HEOS-managed
  playback anyway, so trusting them would just show stale/wrong data). On top of reacting to
  HEOS's own pushed events (`event/player_state_changed`, `event/player_now_playing_changed`),
  this integration also **actively re-polls** `get_play_state`/`get_now_playing_media` every 30s
  while a `pid` is known: HEOS CLI connections are known to drop silently when idle, and there's
  no guarantee every pushed event actually arrives, so the poll is a self-healing fallback rather
  than a bet on the push channel alone. Confirmed necessary on real hardware — the dashboard was
  observed stuck on "paused" indefinitely after playback started elsewhere (the Qobuz app), even
  though HEOS commands sent _from_ Gladys worked fine.
- **Setup-menu remote-control keys**: cursor Up/Down/Left/Right, Enter, Return, Info, Menu and
  relative Volume Up/Down, all `TELEVISION`-category push buttons (`REMOTE_KEYS` in
  [`src/devices/avr.js`](./src/devices/avr.js)). Unlike `MUSIC`, `TELEVISION` push-button types
  render directly as clickable buttons in the plain device list — confirmed by reading Gladys
  core's own `isPushButtonFeature`/`TelevisionPushButtonFeatureTypes`
  (`front/src/utils/consts.js`): every `TELEVISION` type except `BINARY`/`VOLUME`/`CHANNEL` is
  classified as a push button, no dashboard box required, unlike the `Play`/`Pause`/`Next`/
  `Previous` buttons above. `Menu` is the one key that's a real toggle rather than fire-and-forget
  (`has_feedback: true`, same toggle-off-the-last-known-state pattern as `Mute`): the receiver's
  own `MNMEN` push tells it whether the on-screen Setup menu is currently open. These `MN*`
  commands are, like the `NS9x` transport commands, not in the same official protocol PDF as
  power/volume/mute/source/sound mode — cross-checked instead against the actively maintained
  `python-denonavr` project (the library behind Home Assistant's own Denon integration); verify
  against your own receiver with [`scripts/debug-telnet.js`](./scripts/debug-telnet.js) (open the
  Setup menu on the receiver's own screen to see the real `MNMEN` line) before fully trusting it —
  see "Tested and confirmed" below. Which of these rows actually show up on a given dashboard is
  entirely up to the user: Gladys already lets you hide individual device features per box, so
  this integration declares all of them rather than picking favorites or adding its own
  show/hide config option.
- **Test connection** action: on-demand query + a summary of the receiver's current state, now
  including the current source's index (see "Source index" above) so it can be read off without
  guessing.
- **Speak on a speaker**: a `MUSIC`-category, `MUSIC.PLAY_NOTIFICATION`-type feature
  (`FEATURE.PLAY_NOTIFICATION` in `src/devices/avr.js`) — the exact category+type Gladys core's
  own **"Speak on a speaker"** scene action (`ACTIONS.MUSIC.PLAY_NOTIFICATION`,
  `editScene.actions.music.play-notification` = _"Parler sur une enceinte"_) filters its device
  picker on (`front/src/routes/scene/edit-scene/actions/PlayNotification.jsx` in Gladys core),
  so this AVR simply shows up there like any other speaker once the feature exists. The value that
  action hands `onSetValue()` is a ready-made TTS audio file URL
  (`self.gateway.getTTSApiUrl({ text })`, server-side); this integration plays it via HEOS's
  `browse/play_stream?pid=<pid>&url=<url>` — the same mechanism used for direct-URL/TuneIn-style
  playback — since there is no legacy Telnet command that can play an arbitrary URL. **Requires a
  matched HEOS player id** (see "Playback controls" above): a non-HEOS model, or one whose HEOS
  CLI is unreachable, cannot speak at all — `onSetValue()` throws a clear error in that case rather
  than silently doing nothing on this integration's side. That error is nonetheless invisible from
  the scene that triggered it: checked against Gladys core
  (`server/lib/scene/scene.executeActions.js`'s `executeAction()`), a thrown action error that
  isn't an `AbortScene` is caught, `logger.warn()`-logged server-side, and otherwise swallowed —
  the scene still reports as having run. So a "Speak on a speaker" scene that "seems to work" but
  produces no sound is the expected shape of this failure, not a sign something else is wrong;
  see "Playback controls" for the log line confirming a pid match, and note two more diagnostics
  added specifically for this: the `test_connection` manifest action's reply now ends with a HEOS
  status line (`player id ... matched` / `no player id matched` / `not connected`), and the HEOS
  `onMessage` handler now logs the actual `browse/play_stream` response — success, or the
  receiver's own rejection reason (`eid`/`text`) — since `sendCommand()` only confirms the socket
  accepted the bytes, never that the receiver could actually play the URL. Even a logged HEOS
  `result: success` used to not be proof of anything either: `buildPlayStreamCommand()`
  (`src/heos/protocol.js`) originally percent-encoded the `url` parameter, which real-hardware
  testing showed a receiver will happily accept (registering a generic "Url Stream" placeholder in
  its queue) and then never actually fetch — `get_play_state` stays `stop` forever, no matter the
  input source, power, volume, or mute state. Root-caused against `pyheos`'s own `HeosCommand`
  query encoder (`message.py`): the HEOS CLI spec requires `url` to be the last parameter and sent
  **raw, never percent-encoded** — that positional rule, not encoding, is what lets an `&`/`?`
  inside the URL coexist with `pid=` before it. Fixed; `pid` must stay first if any parameter is
  ever added after this. **Each announcement clears the HEOS queue first**
  (`buildClearQueueCommand()`, `player/clear_queue?pid=<pid>`, sent right before
  `browse/play_stream`): also confirmed on real hardware, `browse/play_stream` appends to the
  queue rather than replacing it despite the HEOS protocol spec documenting "Play URL" as its own
  command distinct from the explicit "add to queue" ones — triggering this scene action more than
  once in quick succession queued every announcement instead of replacing the previous one, so a
  receiver still working through announcement #1 would play it, then #2, then #3..., each stacking
  behind the last rather than the latest one winning. The accepted tradeoff: this also clears any
  other HEOS content genuinely queued (a playlist mid-playback), the same disruption any
  announcement system causes by interrupting regular playback. **Volume is not
  adjustable for the announcement**, even though the
  scene action's own editor always shows a volume slider: checked against Gladys core
  (`server/lib/external-integration/externalIntegration.registerProxyService.js`), the proxy that
  external (Docker-based) integrations go through only ever forwards `device.setValue`'s `value`
  to `onSetValue()` — the `options` object carrying `volume` is dropped before it ever reaches the
  WebSocket, unlike the in-process built-in services (Sonos, Google Cast, AirPlay) that get it as
  a normal function argument. The announcement plays at the receiver's current volume; there is no
  way for this integration to see or act on the slider's value.
  **Works on a HEOS-only speaker (Denon Home, HEOS 1/3/5/7, Bar...) added through the manual IP
  fallback**, not just a real AV receiver: `onSetValue()` dispatches this feature before its
  Telnet-connectivity check, not after, specifically because a pure HEOS speaker has no "AVR
  Control" Telnet service at all (port 23 is actively refused — confirmed on real hardware, a
  Denon Home 150) and would otherwise never be able to speak despite its HEOS CLI being perfectly
  reachable. This is a narrow, deliberate exception: every other feature this integration declares
  (Power, Volume, Source...) still requires Telnet and simply won't work on that kind of device —
  see the "v1 scope" note below.

A scene's generic **"Control a device"** action (`ACTIONS.DEVICE.SET_VALUE` in Gladys core) is
the only way to set `Source`/`Sound mode` from a scene — there is no scene-action type for a
manifest's own custom actions (`select_source` here), on any Gladys version, and there never has
been one; that part is a permanent Gladys-core limitation, not something this integration can
work around.

Whether the generic action can actually target `Source`/`Sound mode` **depends on your Gladys
core version**, and this was misdiagnosed once already during this project's own development —
worth stating precisely:

- **Gladys >=4.86.1**: works directly. The scene editor's device/feature picker has no category
  blacklist (`SelectDeviceFeature.jsx`), so `Source`/`Sound mode` are selectable like any other
  feature, and once picked, the value editor (`DeviceSetValue.jsx`) reads the feature's own
  `supported_options` and renders the same labeled dropdown as the dashboard
  (`deviceFeatureValueOptions.js`). Server-side, the scene action explicitly exempts
  `TEXT.SELECT` features from its otherwise-numeric-only value check
  (`server/lib/scene/scene.actions.js`) and forwards the string value as-is. This landed in two
  parts: [Gladys core #2869](https://github.com/GladysAssistant/Gladys/pull/2869) (v4.86.0)
  added `TEXT.SELECT`/string `supported_options` support, and
  [#2883](https://github.com/GladysAssistant/Gladys/pull/2883) (v4.86.1, the next day) fixed a
  bug specific to `supported_options` **declared by an external integration** (exactly this
  one's situation) — hence `gladys_version: ">=4.86.1"` in the manifest, not `>=4.86.0`.
- **Older Gladys**: the generic scene action either doesn't offer a usable control for
  `Source`/`Sound mode` at all, or (pre-#2869) rejects the string value outright. This is exactly
  why **Source index** exists (see "What it does" above): a plain bounded integer, which the
  generic scene action has always been able to set, on any Gladys version — set it to a number
  and the corresponding input is selected, independent of the `TEXT.SELECT` story above. It's
  also just a more stable number to hardcode into a scene than a label that changes when you edit
  `source_overrides`.

If your own scene shows **nothing at all** for this AVR under "Control a device" — no
`Source`/`Sound mode` dropdown and no `Source index` slider either — try a **hard refresh / clear
the browser cache** first: confirmed on real-world feedback to be the actual cause once, a stale
cached front-end bundle showed a completely empty picker for this device while other integrations
(MQTT, Zigbee2MQTT) still worked fine, and a cache-cleared browser fixed it immediately with no
config change at all. If that doesn't help, the next suspect is a Gladys core older than 4.86.1
combined with a device added before this integration shipped `Source index`: open the
integration's Discovery tab, scan, and click **Update** on the device — like any structural
change (see "Discovery" above), a new feature never appears on an already-created device without
that step.

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

On a HEOS-equipped receiver there's a **third connection**, to the separate HEOS CLI service
(port 1255, `src/heos/`) — used only for the playback buttons, and only when it's actually
reachable; see "Playback controls" above for why a second protocol turned out to be necessary
instead of reusing the Telnet one.

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
4. [`src/heos/protocol.js`](./src/heos/protocol.js) and
   [`src/heos/client.js`](./src/heos/client.js) — same pure-functions/socket-client split as 1-2
   above, for the separate HEOS CLI service (port 1255) used only by the playback buttons. Reuses
   `telnet.js`'s socket/reconnect logic (`lineTerminator: '\r\n'` instead of `'\r'`); read this
   after 1-2 since it leans on that split rather than repeating it.
5. [`src/devices/avr.js`](./src/devices/avr.js) — the glue: keeps one Telnet client (and,
   best-effort, one HEOS client) per AVR the user added, and wires `protocol.js`/`telnet.js`/
   `heos/` to what the SDK expects (features, actions).
6. [`src/devices/index.js`](./src/devices/index.js) and [`src/config.js`](./src/config.js) —
   small composition/config-normalization helpers used by the entry point.
7. [`index.js`](./index.js) — the entry point. On purpose the shortest, least interesting file:
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
│  ├─ heos/
│  │  ├─ protocol.js                 # PURE: parse HEOS CLI JSON lines, build heos:// commands
│  │  └─ client.js                   # thin wrapper of denon/telnet.js for the HEOS CLI socket
│  └─ config.js                      # config defaults + normalization
├─ test/                             # one *.test.js per src/ file above, node --test, no library
├─ test-fixtures/
│  └─ fakeGladys.js                  # minimal in-memory stand-in for the SDK client, used by tests
│                                     # — deliberately OUTSIDE test/: `node --test` treats every
│                                     # .js file under test/ as a test file to run, fixtures included
├─ scripts/
│  ├─ debug-telnet.js                # talk to a real receiver's Telnet session directly, without
│  │                                  # running Gladys at all — `node scripts/debug-telnet.js <host>`
│  └─ debug-heos.js                  # same, for the HEOS CLI service — `node scripts/debug-heos.js <host>`
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

**Merging a PR to `main` never publishes anything by itself, and Gladys will show no "Update"
button until it does.** `gladys-assistant-integration.json`'s `version`/`docker_image` — the only
two fields Gladys actually compares to decide whether an update exists — are only ever rewritten
by the **Release** workflow above, which is exclusively `workflow_dispatch` (manual, from the
Actions tab): there is no CI step that runs it automatically on a push/merge to `main`. So it's
entirely normal, not a bug, for several merged PRs to sit on `main` with real feature commits
while the manifest still points at the last released version/image — run the Release workflow
(any release type; nothing else forces `package.json`'s version to match how many PRs merged
since) whenever you want those changes to actually reach users.

`gladys_version` is pinned to `>=4.86.1`. 4.86.0 is the floor `categories` needs to declare
(checked against the store's `manifest.schema.json` — an older core "rejects unknown manifest
fields" outright rather than ignoring just that one, so that change and `TEXT.SELECT` support
had to land together), but the manifest is pinned one patch higher, to 4.86.1: that's the release
that fixed [#2883](https://github.com/GladysAssistant/Gladys/pull/2883), a bug specific to
`supported_options` declared by an _external_ integration (this one) rather than a built-in
device type — see "Scene automation" above.

## v1 scope

Power, volume, mute, input source (status + selection, with per-user renaming/hiding, plus a
numeric `Source index` alias for scene automation), sound mode, network/USB playback controls
(HEOS CLI when available, legacy `NS9x` Telnet otherwise), speak-on-a-speaker TTS playback (HEOS
`browse/play_stream`, see "Speak on a speaker" above), now-playing metadata, Setup-menu
remote-control keys (cursor pad, Enter/Return/Info/Menu, relative Volume Up/Down), SSDP discovery.
Deliberately out of scope for now: multi-zone (Zone 2/3),
HEOS-specific features beyond play/pause/next/previous (grouping, queue browsing, volume-per-
player...), and an HTTP fallback control channel — see the design notes at the top of
[`src/devices/avr.js`](./src/devices/avr.js) and
[`src/denon/discovery.js`](./src/denon/discovery.js).

This integration targets AV receivers, not standalone HEOS speakers (Denon Home, HEOS 1/3/5/7,
Bar, Subwoofer...): those have no "AVR Control" Telnet service at all, so Power, Volume, Mute,
Source and everything else built on `src/denon/protocol.js` simply cannot work against one, no
matter how it's added. **Speak on a speaker is the sole, deliberate exception** — it's pure HEOS,
so it works on either kind of device — see the note on it above. Full support for HEOS speakers as
their own device type (their own discovery, their own HEOS-native feature set for Power/Volume/
playback) is a separate, bigger piece of work, not attempted here.

Every other generic Gladys scene action that could plausibly target this kind of device
(`server/utils/constants.js`'s `ACTIONS` map in Gladys core) was checked against what this
integration already declares: `ACTIONS.DEVICE.SET_VALUE`/`GET_VALUE` (the generic "Control a
device"/read-a-value actions) already work against every feature declared here, and
`ACTIONS.MUSIC.PLAY_NOTIFICATION` ("Speak on a speaker") is the one covered above — it was the
only gap. Everything else in that map (`LIGHT.*`, `SWITCH.*`, `ALARM.*`, `CALENDAR.*`, `SMS.*`...)
targets a different device category entirely, or isn't device-specific at all (delays, HTTP
requests, variables...), so there is nothing else this device type could plug into.

## Tested and confirmed

Honest status, so it's clear what "it works" actually rests on:

- **Confirmed on a real Denon AVR-S970H**: unit tests and the store validator are green, and on
  the actual hardware: static-IP detection, the Telnet connection, power/volume, the mute toggle
  (fixed in 1.0.2 — was re-sending the same command every press), the input-source dropdown
  (`TEXT.SELECT` + `supported_options`), and — as of 1.0.4 — the sound-mode dropdown (correctly
  showed `MCH STEREO`, an actual `SOUND_MODE_CODES` entry, matching the receiver's real state).
  The `source_overrides` config field renders correctly too; its actual rename/hide effect on
  the dropdown hasn't been explicitly confirmed yet (needs the same Discovery→Update step as any
  feature/structure change — see "What it does" above).
- **Found and fixed after real-hardware feedback**: the `MUSIC` playback buttons published fine
  but did nothing when clicked, and only Play ever showed (no Previous/Next) — Gladys' Music
  dashboard box (`front/src/components/boxs/music/MusicBox.jsx`) unconditionally reads a
  `MUSIC.PLAYBACK_STATE` feature while initializing; without one, that throws, the box's `init`
  never finishes, and every button past Play silently has no wired-up feature. Confirmed by
  reading the actual Gladys core source, not guessed — fixed by declaring that feature (derived
  from the receiver's `NSE0` "Now Playing ..." banner, see `src/denon/protocol.js`).
- **Confirmed and then found/fixed after real-hardware feedback on the HEOS routing itself**:
  Play/Pause/Next/Previous do control Qobuz playback correctly via HEOS. Two follow-up bugs
  surfaced from the same feedback: the "Now playing" title never appeared, and the playback state
  stayed stuck on "paused" even while actively playing. Root causes: (1) now-playing metadata was
  still wired to the legacy `NSE1`/`NSE2` Telnet lines only, which — same as the transport
  commands before this fix — don't fire for HEOS-managed playback; there was simply no HEOS-side
  path for it yet. (2) playback state relied entirely on HEOS's _pushed_ `event/player_state_changed`,
  with no periodic re-check — if that push is dropped (HEOS CLI connections are documented to
  drop silently when idle) the dashboard never recovers on its own. Fixed by adding a HEOS
  `get_now_playing_media` path (mirroring the playback-state one, with the same "HEOS is
  authoritative once matched" precedence over the legacy NSE lines) and a 30s active poll of both
  `get_play_state`/`get_now_playing_media` on top of the pushed events, so a missed/dropped event
  self-heals within 30s instead of sticking forever.
- **Not yet confirmed** — implemented from protocol research, not yet run against real hardware:
  - The volume mapping (`DENON_VOLUME_MAX` = 98, the receiver's raw scale ceiling) and multiple
    manual-fallback hosts (comma-separated `source_overrides`/`host`) — implemented and
    unit-tested, no real-hardware pass yet (the volume ceiling is a protocol-level constant, not
    a per-user "Maximum Volume" setting, so it shouldn't need calibration — see the comment above
    `DENON_VOLUME_MAX`).
  - The SSDP discovery flow itself (only the static-IP fallback has been confirmed so far).
  - **HEOS now-playing metadata and the 30s poll** (the `get_now_playing_media` path and the
    periodic re-check added right after the playback-routing/state fixes below were confirmed):
    implemented from the same `pyheos` cross-reference, not yet re-verified on real hardware.
    Same fallback safety as everything else HEOS-side — a wrong assumption here just means a
    blank/stale title or a state that only self-heals every 30s instead of instantly, never a
    crash or a regression on non-HEOS playback.
  - The Setup-menu remote-control keys (cursor pad, Enter/Return/Info, the Menu toggle, relative
    Volume Up/Down): the `MN*`/`MVUP`/`MVDOWN` commands are cross-checked against
    `python-denonavr`, same as the `NS9x` transport commands above, but not yet pressed against a
    real receiver's actual Setup menu from this project's own hardware.

  Use [`scripts/debug-telnet.js`](./scripts/debug-telnet.js) against your own receiver to check
  any of the above — in particular, send `MS?` and start streaming on a NET/USB source to see
  the real sound-mode and now-playing lines your model actually sends, or open the Setup menu on
  the receiver's own screen to see the real `MNMEN` line — and
  [`scripts/debug-heos.js`](./scripts/debug-heos.js) to see the real HEOS CLI traffic (or confirm
  the receiver doesn't run HEOS/isn't reachable on port 1255 at all).

## License

Apache-2.0
