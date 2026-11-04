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
  the Telnet session the receiver itself pushes state changes to — no polling. The legacy Telnet
  `MV`/`MU` commands stay authoritative whenever that session is up (confirmed correct on real
  hardware, main-zone volume regardless of source). Volume/Volume up/Volume down/Mute additionally
  fall back to their HEOS CLI equivalents (`player/set_volume`, `player/volume_up`/`volume_down`,
  `player/set_mute`) whenever the legacy Telnet session isn't reachable at all — the case for a
  HEOS-only speaker (Denon Home, HEOS 1/3/5/7, Bar...), which has no "AVR Control" service
  whatsoever (port 23 is actively refused). Power itself has no HEOS equivalent and stays
  Telnet-only — see "v1 scope" below for exactly which features work on that kind of device.
- **HEOS-only speakers** (`src/devices/speaker.js`, forum topic 10722 post 37): recognized when
  HEOS matches a player at the device's IP, the last Telnet attempt was refused (`ECONNREFUSED`,
  not a timeout) and the model is a speaker one (HEOS `get_players` `model` or SSDP `modelName`:
  "Denon Home …", "HEOS …", never an AVR/amp model); a missing or unreadable model is never a
  speaker; never once Telnet came up in the session. In a session only the HEOS model decides;
  the SSDP `modelName` only decides what Discovery offers. A device saved without the power
  feature logs its port 23 refusal at info, not warn (`quietError` of the Telnet client). Then: Discovery offers only the HEOS
  features (`HEOS_SPEAKER_FEATURES`), Telnet-only commands are refused with "not available on a
  HEOS speaker … nothing sent", the badge follows HEOS only (`local`, or `unreachable` as soon as
  HEOS is lost), Telnet is retried every 5 min (the retry already scheduled is moved too), and
  the Telnet client logs a repeating socket error once (`src/denon/telnet.js`).
- **Widget Vol −/+** (`nudgeVolume()` in `src/devices/control.js`): Gladys core caps widget
  actions and the content re-pull after each one at 30 a minute per integration (fixed window,
  429 for every widget button until it ends). A tap is therefore a real step (2 % ≈ 2 dB on
  Telnet `MV`, 5 % on HEOS `set_volume`) from the last wanted level (2.5 s, per route), never
  past the receiver's `MVMAX` (state `volume_max`, when the receiver announces it; a half-step
  ceiling is floored) nor outside 0-98 (Telnet) / 0-100 (HEOS), spaced 60 ms per device, the last
  wanted level winning; an absolute volume cancels a waiting tap. Widget re-pulls
  (`src/widgets/index.js`, `refresh.js`): the core's 30 pulls a minute are shared with the taps,
  so a widget is nudged only for a device one of its instances showed in a pull since the start
  (`createShownDevices()`; every device during the first 5 min, a crashed process may have left
  content cached core-side), and the first nudge of a burst waits 400 ms to carry it whole.
- **Zones**: every per-zone command targets the **main zone by default** (`zone` config key,
  `main`/`zone2`/`zone3`, see `ZONE` in `src/denon/protocol.js`). Power uses `ZMON`/`ZMOFF`, never
  the whole-unit `PWON`/`PWSTANDBY`: `PWON` wakes the receiver up restoring whichever zones were on
  last (so it could come back on Zone 2 alone), and `PWSTANDBY` also cuts Zone 2. A bare `PWON`
  push is likewise not read as "main zone on" (Zone 2 alone sends it too) — the `ZMON` push is.
  Exception, receivers **without zones** (Marantz PM7000N, M-CR610/611, Denon DRA-100...):
  their protocol has no `ZM` at all, so the main zone uses `PWON`/`PWSTANDBY`/`PW?`
  (`POWER_MODE.SYSTEM`) there. `src/devices/power.js` decides, strongest source first: a
  `Z2`/`Z3` line (zones, always); `DeviceZones` read this session from `/goform/Deviceinfo.xml`
  (port 80, then 8080; 1 = no zones, as python denonavr, MIT, does); a `ZM` line or a saved
  verdict (zones); then, only without `DeviceZones` and with a readable `/data`, a Telnet probe:
  `PW?` answered while `ZM?` (asked again alone) and `Z2?` are not. In doubt: `ZMON`/`ZMOFF`.
  `/data/power-modes.json` keeps only "with zones" verdicts (per device and IP, deleted with the
  device). Every power command is logged at info level, re-queried after
  `timing.powerReadBackMs`, and one left unanswered for `timing.powerConfirmMs` turns the device
  badge degraded, naming the command.
  `parseLine(line, zone)` drops other zones' lines (`Z2...`/`Z3...` in main-zone mode, `ZM`/`MV`/
  `MU`/`SI` in secondary-zone mode). On the HEOS side, a multi-zone AVR can expose one player per
  zone on the same IP: `findPlayerIdByIp(payload, ip, zone)` picks the one named after the zone
  (the main zone being the one named after none), lowest `pid` on a tie — never HEOS' list order.
  And before a "Speak on a speaker" stream, the configured zone is switched on and to `NET` over
  Telnet (skipped when the last reported state already says so), otherwise HEOS starts the stream
  on whichever zone it last played on. Changing `zone` — or the Telnet port, the reconnect backoff
  or the source overrides, which every session also captures when it opens — reconnects every AVR
  (`sessionConfigChanged()` in `src/config.js`, called from `index.js`'s `onConfigUpdated`). A
  device update carrying a new `IP_ADDRESS` (DHCP, then **Update** in the Discovery tab) reconnects
  that AVR alone (`refreshDevice()`, `onDeviceUpdated`); a rename keeps its session. Sound mode and
  the Setup-menu keys stay main-zone only.
  **Volume: the percent is the receiver's own number** (1.2.1, forum topic 10722 post 39,
  Marantz PM7000N): `percentToDenonVolume()`/`denonVolumeToPercent()` (`src/denon/protocol.js`)
  map 1:1 onto the raw 0-`DENON_VOLUME_MAX` (98) scale, half steps kept on the way in (`MV255` =
  25.5), rounded on the way out, 99-100 sent as `MV98`. Up to 1.2.0 the 0-98 scale was stretched
  onto 0-100 (`round(raw / 98 * 100)`), so from raw 25 up Gladys showed one more than the
  receiver's display (and setting 25 % snapped to 26 %). Same number, louder than before: +1 dB
  for 26-75 and 99, +2 dB for 76-98 (90 was `MV88`, is `MV90`). Telnet widget taps top out at 98;
  the HEOS path keeps HEOS' own 0-100.
- **Input source**: a dropdown on the dashboard, backed by `TEXT.SELECT` +
  `supported_options` (the receiver's own SI codes) — **not** the generic `TELEVISION.SOURCE`
  type, which Gladys' front-end renders as a one-shot remote-control button with no way to pick
  a specific input (see the design notes in [`src/devices/features.js`](./src/devices/features.js)). The
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
  from the same `visibleSourceCodes()` helper in `src/devices/features.js` so they can never disagree
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
  (`src/devices/commands.js`'s `onSetValue`, `src/heos/`):
  - **HEOS CLI** (port 1255) — used whenever this AVR's own IP has been matched to a HEOS
    `pid` (via `player/get_players`, on every connect). This is the path that actually reaches
    HEOS-managed streaming sources: Qobuz, Spotify Connect, TIDAL, TuneIn, Amazon Music...
  - **Legacy `NS9x` Telnet commands** — the fallback whenever no HEOS `pid` is known yet, HEOS
    CLI is unreachable (firewalled, or a non-HEOS/older model), or on a genuinely non-HEOS
    Net/USB source. This is the only path that existed before 1.0.8, and real-hardware feedback
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
  though HEOS commands sent _from_ Gladys worked fine. Only values that **changed** are published
  (`publishHeosState()`): Gladys core does not dedup, so re-publishing the same playback state every
  30s wrote ~2,900 history rows a day per receiver for nothing (Gladys ≥5.1.2 flags a feature past
  8,640 states a day as "verbose").
- **Setup-menu remote-control keys**: cursor Up/Down/Left/Right, Enter, Return, Info, Menu and
  relative Volume Up/Down, all `TELEVISION`-category push buttons (`REMOTE_KEYS` in
  [`src/devices/features.js`](./src/devices/features.js)). Unlike `MUSIC`, `TELEVISION` push-button types
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
  (`FEATURE.PLAY_NOTIFICATION` in `src/devices/features.js`) — the exact category+type Gladys core's
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
  announcement system causes by interrupting regular playback. **The volume chosen in the scene never
  arrives**, even though the scene action's own editor always shows a volume slider: checked
  against Gladys core (`server/lib/external-integration/externalIntegration.registerProxyService.js`),
  the proxy that external (Docker-based) integrations go through only ever forwards
  `device.setValue`'s `value` to `onSetValue()` — the `options` object carrying `volume` is
  dropped before it ever reaches the WebSocket, unlike the in-process built-in services (Sonos,
  Google Cast, AirPlay) that get it as a normal function argument
  ([integration-sdk-js#33](https://github.com/GladysAssistant/integration-sdk-js/issues/33), still
  open). Two config keys make up for it (`src/devices/announcements.js`): **`announcement_volume`**
  (0 = keep the current volume) is set before the stream starts, and **`announcement_restore`**
  (on by default) gives back the volume, the input and the standby state the receiver had before,
  once HEOS reports the stream over (its own `player_state_changed` event, or a 1 s poll of
  `get_play_state` while an announcement plays), refused by HEOS, never started (15 s) or capped
  (3 min). The volume is left alone if someone changed it during the announcement; a second
  announcement keeps the first one's snapshot; what HEOS was playing before is not resumed (the
  queue was cleared, see above). Since 1.2.1 (forum topic 10722, post 39, Lyrion): HEOS naming
  the announcement URL as its current media (`get_now_playing_media` `mid`, polled with the play
  state) proves it plays even when the music before kept the state at `play`; another media
  after it ends the announcement at once; once over with nothing playing, the queue is cleared
  again so a later Play cannot replay it.
  **Works on a HEOS-only speaker (Denon Home, HEOS 1/3/5/7, Bar...) added through the manual IP
  fallback**, not just a real AV receiver: `onSetValue()` dispatches this feature before its
  Telnet-connectivity check, not after, specifically because a pure HEOS speaker has no "AVR
  Control" Telnet service at all (port 23 is actively refused — confirmed on real hardware, a
  Denon Home 150) and would otherwise never be able to speak despite its HEOS CLI being perfectly
  reachable. This is a narrow, deliberate exception: every other feature this integration declares
  (Power, Volume, Source...) still requires Telnet and simply won't work on that kind of device —
  see the "v1 scope" note below.

- **Dashboard widgets** (Gladys >=5.1.0, `src/widgets/`): five cards a user adds from the
  dashboard editor, each bound to a receiver picked in its settings (the first one when left
  empty). **Now playing** — the HEOS cover art (downloaded by the integration, checked with the
  SDK's `validateWidgetImage()` and simply left out when it doesn't fit Gladys' 300 KB/4096 px
  bound: no resizing dependency), title, artist/station, album, input, sound mode, a live volume
  tile, and previous / play-or-pause / next / mute — what the core "Music" box can't show (no
  title, no artwork, and no volume for an AVR whose volume is a `TELEVISION` feature).
  **Shortcuts** — four one-tap buttons chosen among the inputs (labelled with `source_overrides`),
  Quick Select 1-5 (`MSQUICK<n>`, Smart Select on Marantz) and HEOS favorites 1-8, the active one
  ticked. **Amplifier** — power/input/sound mode/mute at a glance, live volume, power,
  volume −/+ and mute. **Remote** — four keys of the user's choice (arrows by default): several
  instances side by side make a full pad. **Radio** — the analog tuner (`TFAN`/`TPAN`/`TMAN`):
  frequency, preset, band, tuning mode and four configurable buttons; the input is switched to
  the tuner first, since the receiver ignores tuner commands on another input. Its `show`
  setting switches it to the radio ad-break view (`src/widgets/ad-breaks.js`) — one widget for
  both, the store admitting five widgets per integration. Widgets are
  read-and-tap only by design (no slider, no dropdown: those stay the core widgets rendering the
  device features), at most 8 components and 4 buttons each — every content is checked against
  the SDK's own `validateWidgetContent()` in `test/widgets.test.js`. The current choice is marked
  by an icon, never the `primary` style (Gladys paints it like the others in dark mode). Refresh
  nudges are coalesced to the core's 1-per-10 s window with a trailing nudge
  (`src/widgets/refresh.js`), so a card always ends on the receiver's last state.
- **Scene actions and triggers** (Gladys >=5.1.0, `src/scenes/`): **AVR: play from a HEOS music
  service** (`play_heos_service`: the same kinds as the Qobuz one below, on any signed-in service
  picked by key, plus a radio station by name — `play_qobuz` is kept unchanged for its scenes),
  **AVR: recall a Quick Select**,
  **AVR: play a HEOS favorite** (`browse/play_preset`), **AVR: play from Qobuz** (a playlist,
  an album, the latest album of an artist, an artist or a track, by name, with the replace /
  play next / add to the end modes (`aid` 4/2/3): `browse/get_music_sources` finds Qobuz by name
  (else sid 30), `browse/browse` reads the user's playlists and the artist pages,
  `browse/search` the catalog, `browse/add_to_queue` (container, or track with `mid`) or
  `browse/play_stream` (station) plays it; returns `played`, `artist`, `type` and the `method`
  that found it — see `src/devices/qobuz.js` and "Qobuz" in the docs), **AVR: set up the receiver** (power, input,
  sound mode and volume in one card, each optional — power on first with the wake-up pause,
  standby alone) and **AVR: read the receiver state** (outputs: power, volume, input code and
  name, sound mode, Quick Select, playing, title, artist — what the core's "Continue only if"
  needs to test a text value). Triggers: **AVR: input changed** (filterable by receiver and new
  input) and **AVR: track changed** (title/artist/album as variables), never fired on the first
  value seen after a (re)connect.
- **Music player** (Gladys >=5.3.0, manifest `music: { browse, search, queue, append }`,
  `src/devices/music.js`): the core's Music box and its "Play music on a speaker" scene action
  browse a catalog (root: HEOS Favorites 1028, HEOS Playlists 1025, then every source
  `browse/get_music_sources` lists signed in, in its order — Qobuz, TIDAL, Deezer, Amazon,
  TuneIn…, Local Music 1024 whose servers are sources of their own (`sid` items), History 1026, AUX
  1027 whose inputs play with `browse/play_input` (`spid` for another player); Spotify 4 and
  QQMusic 18 left out: no CLI browse, Spotify is Spotify Connect only; signed-out services left
  out too). Search: the `music_search_service` setting (`auto`: Qobuz when signed in, else every
  signed-in service announcing criteria, Qobuz/TIDAL/Deezer first; `all`; or one service, falling
  back to all when it cannot), criteria picked by name per service (artist, album, playlist,
  track, station); a matching artist also offers a "latest album" entry resolved at play time,
  and "dernier album de X" / "latest album by X" is recognized for any service searching albums.
  Play with the replace / next / append modes (a station or an input always plays now), read the
  queue (`player/get_queue`, current item by the playing `qid`) and jump in it. MediaItem ids are
  `heos:` query strings carrying kind/sid/cid/mid/name (`src/heos/media.js`). The now playing goes
  out through `publishNowPlaying` as four read-only music features (republished after a Discovery
  "Update"); artwork bytes are served by `onMusicGetArtwork` through the widget's checked
  download (300 KB, PNG/JPEG/WebP). **Deadline** (`src/devices/deadline.js`): the core waits 10 s
  per music command; every command runs under an 8 s deadline carried by `AsyncLocalStorage`, each
  HEOS request waits at most what is left (a request reached after it is never sent, so nothing
  abandoned blocks the request chain), the acting step (zone, queue, play) needs 2.5 s left, and a
  search is bounded at 6 s on every service, keeping what it found. A failed search says which
  service failed instead of answering "no result".
- **Per-device connection badge** (`src/devices/transport.js`, `publishTransports()`): each AVR
  shows its own _local_ / _unreachable_ badge, with an orange "degraded" dot and its reason when
  HEOS lists no player at the receiver's IP ("Speak on a speaker" cannot work) or when only HEOS
  answers (Telnet down: a HEOS-only speaker). It replaces the integration-wide
  `setConnectionStatus(false, "Cannot reach…")` every Telnet session used to send, which flapped
  between receivers and never said which one failed.
- **Radio ad breaks** (opt-in, `src/adbreak/`, user docs: "Radio ad breaks" in `docs/`): while a
  station plays through HEOS, a per-receiver controller learns when that station airs its ads
  (song gaps from HEOS metadata + Deezer durations, or the Les Indés Radios live feed and its
  playlist history for stations like OUI FM; per-station minute windows by day type and hour,
  `stats.js`), recognizes its ad jingle in the decoded stream (`jingles.js`: ffmpeg to band-energy
  frames, the shared-sound search in a worker thread; each gap the detector took for a break
  (`breakHandled`) records whether the active jingles were heard, the last 10 kept: start within
  90 s after the song end, end within 150 s before the next song, ±10 s; only a start jingle heard
  in ≥ 80 % of ≥ 5 breaks makes the window rule wait 90 s instead of the learned host talk, and
  one missed in more than 3 of its last 6 breaks goes back to observation, replaceable by
  `relearn()`), publishes the **Radio ad break** switch
  (`SWITCH.BINARY`, also a "it's an ad" control) and lowers the HEOS volume meanwhile
  (`ad_break_auto_duck`). Off by default (`ad_break_detection`): disabled, nothing is learned,
  looked up or decoded. The volume always comes back: a 10-minute cap, a restore on `stop()`
  _before_ the HEOS socket closes, a retried restore while HEOS is down, and announcements end
  a break before snapshotting the volume (`interruptForAnnouncement()`). Learned data lives in
  `/data/ad-breaks.json` and `/data/ad-jingles/`. What was learned is shown by the **Radio**
  widget set to `show: ad_breaks` (windows and hours with ads per day type, next window, recent
  breaks, jingle states) and the **Ad-break report** Configuration action, both built from
  `src/adbreak/insights.js`, and by the read-only **Radio ad window** binary feature (1 inside a
  learned window, published at each change) for Gladys' own Binary chart. Hours are local to the `timezone` setting (`applyTimezone()` sets
  the process `TZ`): Gladys runs integration containers in UTC.

A scene's generic **"Control a device"** action (`ACTIONS.DEVICE.SET_VALUE` in Gladys core) can
also set `Source`/`Sound mode` — and since Gladys 5.1.0, **AVR: set up the receiver** above does
it in one card, by name, on any Gladys that runs this version of the integration. The manifest
`select_source` action still only lives on the Configuration screen.

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
the project — everything in `src/denon/` and `src/devices/` exists to manage that second
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
5. [`src/devices/avr.js`](./src/devices/avr.js) — the map of `src/devices/`: one file per
   responsibility, each listed at the top of `avr.js`. Read
   [`features.js`](./src/devices/features.js) (what a device declares),
   [`registry.js`](./src/devices/registry.js) (the shared state every other module reads),
   [`session.js`](./src/devices/session.js) and [`heos-session.js`](./src/devices/heos-session.js)
   (the two connections per AVR), then [`commands.js`](./src/devices/commands.js) (the
   `onSetValue` routing) and [`control.js`](./src/devices/control.js) (the controls shared by
   commands, announcements, scenes and widgets).
6. [`src/widgets/`](./src/widgets) and [`src/scenes/`](./src/scenes) — the Gladys 5.1 surfaces
   built on top: pure content builders (`content.js`) plus the SDK wiring (`index.js`), and the
   scene actions/triggers. [`src/devices/index.js`](./src/devices/index.js) and
   [`src/config.js`](./src/config.js) are small composition/config-normalization helpers.
7. [`index.js`](./index.js) — the entry point. On purpose the shortest, least interesting file:
   it only creates the SDK client and wires its events to the functions above.

## Dependencies

This project intentionally has a **single runtime dependency**:

| Package                                                                                              | Role                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@gladysassistant/integration-sdk`](https://www.npmjs.com/package/@gladysassistant/integration-sdk) | Everything about talking to the Gladys hub: authentication, the WebSocket connection and its reconnection, and the event/method API used in `index.js` (`onScanRequest`, `publishState`, ...). |

Everything else needed at runtime is a Node.js built-in, on purpose (fewer dependencies = fewer
things that can break or need updating): `node:net` for the Telnet socket
([`src/denon/telnet.js`](./src/denon/telnet.js)), the global `fetch` for reading a receiver's
UPnP description ([`src/denon/discovery.js`](./src/denon/discovery.js)) and the cover art of the
"Now playing" widget ([`src/widgets/artwork.js`](./src/widgets/artwork.js), with `node:crypto`
for its image key). No image library: a cover above Gladys' 300 KB bound is left out, not
resized. The radio ad-break detection uses `node:child_process` to run **ffmpeg** (installed in
the image by the `Dockerfile`, `apk add ffmpeg`; without it, only the jingle recognition is off)
and `node:worker_threads` for its CPU-heavy jingle search.

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
│  │  ├─ avr.js                      # public face + map of this folder (re-exports)
│  │  ├─ features.js                 # feature/state keys, discovery payload (buildFeatures)
│  │  ├─ registry.js                 # shared state: sessions, last known state, listeners
│  │  ├─ session.js                  # Telnet session lifecycle: connect / refresh / disconnect
│  │  ├─ heos-session.js             # HEOS CLI session: player match, poll, deduped publishes,
│  │  │                              #   awaited requests (request(): one at a time, answer or eid)
│  │  ├─ transport.js                # per-device local/unreachable badge
│  │  ├─ control.js                  # controls shared by commands, scenes and widgets
│  │  ├─ commands.js                 # onSetValue routing (Telnet vs HEOS)
│  │  ├─ announcements.js            # "Speak on a speaker": volume, end, restore
│  │  ├─ qobuz.js                    # Qobuz and any HEOS service: source, playlists, search, latest
│  │  │                              #   album, artist (radio/top tracks), track, play modes
│  │  ├─ qobuz-check.js              # "check" diagnostics: every service, Qobuz (no account, no URL)
│  │  ├─ deadline.js                 # 8 s deadline of a music command (Gladys waits 10 s)
│  │  ├─ music.js                    # Gladys music player: browse/search/play/queue, now playing
│  │  ├─ actions.js                  # Configuration-screen actions (test, select input, Qobuz check)
│  │  └─ index.js                    # composes SSDP discovery + the manual host fallback
│  ├─ widgets/                       # dashboard widgets (Gladys >=5.1.0)
│  │  ├─ content.js                  # PURE: one content builder per widget
│  │  ├─ common.js                   # widget keys, texts, setting options
│  │  ├─ actions.js                  # what each widget button does
│  │  ├─ ad-breaks.js                # the Radio widget's ad-break view
│  │  ├─ artwork.js / refresh.js     # cover download + cache, coalesced refresh nudges
│  │  └─ index.js                    # SDK handlers + state-change nudges
│  ├─ scenes/
│  │  ├─ actions.js                  # scene actions (Quick Select, HEOS favorite, Qobuz, set up, read)
│  │  └─ triggers.js                 # scene triggers (input changed, track changed)
│  ├─ denon/
│  │  ├─ protocol.js                 # PURE: parse Telnet lines <-> feature values, build commands
│  │  ├─ telnet.js                   # raw net.Socket client: line framing, reconnect w/ backoff
│  │  └─ discovery.js                # SSDP scan + UPnP description.xml parsing
│  ├─ heos/
│  │  ├─ protocol.js                 # PURE: parse HEOS CLI JSON lines, build heos:// commands
│  │  ├─ qobuz.js                    # PURE: find Qobuz among the sources, match names, criteria,
│  │  │                              #   latest-album and artist-page rules, log redaction
│  │  ├─ media.js                    # PURE: music player media ids <-> HEOS, MediaItems
│  │  ├─ services.js                 # PURE: HEOS sources, services by key/name/id, search order
│  │  └─ client.js                   # thin wrapper of denon/telnet.js for the HEOS CLI socket
│  ├─ adbreak/                       # radio ad-break detection (opt-in)
│  │  ├─ index.js                    # per-receiver controller: station, feed, volume ducking
│  │  ├─ detector.js                 # PURE state machine: song gaps, windows, jingles -> breaks
│  │  ├─ stats.js                    # learned per-station windows/schedule + their JSON store
│  │  ├─ sources.js                  # station identity, song feeds, playlist history, Deezer
│  │  ├─ jingles.js                  # stream decoding (ffmpeg), jingle learning + recognition
│  │  ├─ jingle-worker.js            # the jingle search, off the main thread
│  │  ├─ insights.js                 # PURE: what was learned, for the widget and the report
│  │  └─ bands.js                    # PURE: PCM -> band-energy frames, correlation
│  └─ config.js                      # config defaults + normalization
├─ test/                             # *.test.js per src/ module, node --test, no library
├─ test-fixtures/
│  ├─ fakeGladys.js                  # minimal in-memory stand-in for the SDK client, used by tests
│  ├─ audio.js                       # synthetic radio audio + jingles for the ad-break tests
│  └─ fakeClients.js                 # fake Telnet/HEOS sessions injected through registry.js
│                                     # — deliberately OUTSIDE test/: `node --test` treats every
│                                     # .js file under test/ as a test file to run, fixtures included
├─ scripts/
│  ├─ debug-telnet.js                # talk to a real receiver's Telnet session directly, without
│  │                                  # running Gladys at all — `node scripts/debug-telnet.js <host>`
│  ├─ debug-heos.js                  # same, for the HEOS CLI service — `node scripts/debug-heos.js <host>`
│  └─ debug-adbreak.js               # the ad-break controller alone against a real receiver,
│                                     # to tune it by ear — `node scripts/debug-adbreak.js <host>`
├─ docs/
│  └─ en.md / fr.md                  # END-USER documentation, re-hosted by Gladys itself in its
│                                     # UI (not this README) — what someone installing the
│                                     # integration from the Gladys store reads, not a developer
├─ gladys-assistant-integration.json # the "manifest": declares the integration to the Gladys
│                                     # store/hub (name, version, Docker image, the config form,
│                                     # actions, widgets, scene actions and triggers)
├─ Dockerfile                        # packages index.js + src/ into the image Gladys runs,
│                                     # Node 26 Alpine, prod dependencies only
├─ cover.jpg                         # catalog cover: exactly 800×534 px, ≤150 KB (store rule)
└─ scripts/cover.html                # its source: render it with the command written inside
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
npm run test:coverage    # node --test + coverage thresholds on src/ (what CI runs)
```

`protocol.js` and `telnet.js`/`discovery.js` are unit-tested without a real receiver: pure
parsing/building functions, a local fake Telnet server (`net.createServer`), and a mocked
`fetch`/`scanNetwork`. See [`test/`](./test). Test doubles/fixtures live in
[`test-fixtures/`](./test-fixtures), not `test/` itself — `node --test` runs every `.js` file it
finds under `test/`, fixtures included, so one in there silently becomes a passing 0-assertion
"test" instead of the helper it's meant to be.

To poke a real receiver directly, without running Gladys at all:
`node scripts/debug-telnet.js <host> [port]` opens the same Telnet client this integration uses
in production and gives you a prompt to type raw protocol commands (`ZM?`, `MV50`, `SITUNER`,
`Z2?`...).

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

`gladys_version` is pinned to `>=5.3.0` since the `music` field (music player: catalog, search,
queue, now playing), which only the 5.3.0 validator accepts (store schema, `music: '5.3.0'`).
Before that it was `>=5.1.0`: the manifest declares `widgets`, `scene_actions` and
`scene_triggers`, which only the 5.1.0 validator accepts — an older core "rejects unknown manifest
fields" outright (checked against the store's `manifest.schema.json` and the Gladys tags: 5.0.4
has neither), so a Gladys 4.86/5.0 user stays on the last release of this integration that
declared `>=4.86.1` until they update Gladys. The previous floor came from
[#2883](https://github.com/GladysAssistant/Gladys/pull/2883) (4.86.1), the fix for
`supported_options` declared by an _external_ integration, which 5.1.0 includes.

## v1 scope

Power, volume, mute (legacy Telnet when reachable, HEOS CLI fallback otherwise), input source
(status + selection, with per-user renaming/hiding, plus a numeric `Source index` alias for scene
automation), sound mode, network/USB playback controls (HEOS CLI when available, legacy `NS9x`
Telnet otherwise), speak-on-a-speaker TTS playback (HEOS `browse/play_stream`, see "Speak on a
speaker" above, with an announcement volume and a return to the previous state), now-playing
metadata, Setup-menu remote-control keys (cursor pad, Enter/Return/Info/Menu, relative Volume
Up/Down), zone selection (main zone by default, or Zone 2/3 — one zone per integration, not
several zones side by side), SSDP discovery, five dashboard widgets, six scene actions (Qobuz and any HEOS service:
playlists, albums, latest album, artist, tracks and radios among them), two scene triggers, a
Gladys music player (Gladys >=5.3.0: HEOS favorites and playlists and every signed-in HEOS
service browsed and searched,
play modes, queue, now playing with artwork), a per-device connection badge.
Deliberately out of scope for now: controlling several zones at once (one device per zone),
HEOS grouping, searching the local music servers, duration/position,
shuffle/repeat, adding to HEOS favorites or a Qobuz library, volume-per-player, resuming what
HEOS played before an announcement,
and an HTTP fallback control channel — see the design notes at the top of
[`src/devices/avr.js`](./src/devices/avr.js) and
[`src/denon/discovery.js`](./src/denon/discovery.js).

This integration targets AV receivers, not standalone HEOS speakers (Denon Home, HEOS 1/3/5/7,
Bar, Subwoofer...) — those have no "AVR Control" Telnet service at all (port 23 is actively
refused, confirmed real-hardware feedback), so anything built purely on `src/denon/protocol.js`
cannot work against one, no matter how it's added: **Power, Source, Sound mode and the Setup-menu
remote keys have no HEOS equivalent and simply won't work on that kind of device.** Volume, Mute
and the playback buttons (Play/Pause/Next/Previous) are the exceptions — they have a real HEOS CLI
path (`player/set_volume`, `player/volume_up`/`volume_down`, `player/set_mute`,
`player/set_play_state`...) and fall back to it whenever the legacy Telnet session isn't reachable
at all, which in practice means it's the only path a HEOS-only speaker ever uses — see "Power /
Volume / Mute" and "Playback controls" above. **Speak on a speaker** is pure HEOS too, so it also
works on either kind of device. Full support for HEOS speakers as their own device type (their own
discovery, their own HEOS-native feature set for Power and anything else HEOS itself exposes) is
still a separate, bigger piece of work, not attempted here — this is a fallback for the features
that happen to have a HEOS equivalent already, not first-class HEOS-speaker support.

Every other generic Gladys scene action that could plausibly target this kind of device
(`server/utils/constants.js`'s `ACTIONS` map in Gladys core) was checked against what this
integration already declares: `ACTIONS.DEVICE.SET_VALUE`/`GET_VALUE` (the generic "Control a
device"/read-a-value actions) already work against every feature declared here, and
`ACTIONS.MUSIC.PLAY_NOTIFICATION` ("Speak on a speaker") is the one covered above — it was the
only gap among the core's own actions. Since Gladys 5.1.0 the integration declares its own scene
actions and triggers on top (see "What it does"). Everything else in that map (`LIGHT.*`, `SWITCH.*`, `ALARM.*`, `CALENDAR.*`, `SMS.*`...)
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
  - The volume mapping (`DENON_VOLUME_MAX` = 98, the receiver's raw scale ceiling; 1:1 since
    1.2.1, matching a Marantz PM7000N's display per its owner) and multiple
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
  - **HEOS volume/mute** (`player/get_volume`/`set_volume`/`volume_up`/`volume_down`,
    `player/get_mute`/`set_mute`, `event/player_volume_changed`): added specifically so Volume/Mute
    keep working on a HEOS-only speaker (no "AVR Control" Telnet service at all, port 23
    ECONNREFUSED — real-hardware feedback from a user's HEOS speaker) where they previously failed
    outright. Implemented and unit-tested from the same `pyheos` cross-reference as the rest of
    `src/heos/`, not yet re-verified against a real HEOS speaker. Same fallback safety as the rest
    of the HEOS layer: it only ever engages when the legacy Telnet session isn't reachable at all,
    so a real AVR receiver's confirmed-working Telnet volume/mute is never affected either way.

  - **Everything added for Gladys 5.1**: the five dashboard
    widgets, the scene actions and triggers, the per-device connection badge, the announcement
    volume/restore, the Quick Select (`MSQUICK`) and tuner (`TFAN`/`TPAN`/`TMAN`) lines and
    commands. Every widget content is checked against the SDK's `validateWidgetContent()`, the
    manifest passes the store validator, and the Quick Select/tuner codes come from Denon's own
    protocol PDF (AVR-X2000/E400, "PROTOCOL 10.1.0"; the AM/FM band commands are documented there
    as North America only) — but none of it has run against a real receiver and a real Gladys
    5.1 yet. The cover art in particular depends on the container reaching the HEOS `image_url`
    host (usually an Internet CDN) and on the cover fitting 300 KB.
  - **The other HEOS services** (TIDAL, Deezer, Amazon, TuneIn, Local Music, AUX inputs): browse
    and search follow the CLI spec and real TIDAL/Deezer captures (pyheos fixtures,
    gaelsimon/neos-audio samples, in `test-fixtures/heosServices.js`); the TIDAL tree under "My
    Music", TuneIn's "Station" criteria and the AUX/Local Music sub-sources are assumed. Never run
    against a real receiver signed in to them.
  - **Qobuz and the music player**: never run against a receiver showing Qobuz, nor a real Gladys
    5.3 Music box. Qobuz is not in the HEOS CLI spec; its source id 30, the "Library >
    Playlists" tree and its playlists listed `playable: no` come from third-party captures and a
    Home Assistant report, and the search criteria are assumed to be TIDAL's. HEOS gives no
    release date: "latest album" is a documented heuristic (`method` says which rule fired). The
    tests run against a fake HEOS CLI built from the spec and real TIDAL/Deezer captures
    (`test-fixtures/qobuzReceiver.js`). "Qobuz: check" (with an artist) logs what a real receiver
    answers, without the account name nor image URLs, to replace the guesses.
  - **Radio ad breaks**: the detection rules, the OUI FM feed and the jingle recognition were
    tuned by ear with [`scripts/debug-adbreak.js`](./scripts/debug-adbreak.js) against a real
    receiver, outside Gladys. Their run inside the integration (the switch, opt-in setting,
    volume restore on stop / HEOS loss / announcement, the worker-thread jingle search) is
    unit-tested only so far.

  Use [`scripts/debug-telnet.js`](./scripts/debug-telnet.js) against your own receiver to check
  any of the above — in particular, send `MS?` and start streaming on a NET/USB source to see
  the real sound-mode and now-playing lines your model actually sends, or open the Setup menu on
  the receiver's own screen to see the real `MNMEN` line — and
  [`scripts/debug-heos.js`](./scripts/debug-heos.js) to see the real HEOS CLI traffic (or confirm
  the receiver doesn't run HEOS/isn't reachable on port 1255 at all).

## License

Apache-2.0
