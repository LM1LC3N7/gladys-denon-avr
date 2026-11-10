# TODO

## Open

- Power on receivers without zones (forum topic 10722, post 35, Marantz PM7000N): confirmed
  working by the reporter with 1.1.1 (post 37). Still not known: whether the PM7000N serves
  `/goform/Deviceinfo.xml` with `DeviceZones`, and what it answers to `ZM?`.
- HEOS-only speakers (forum topic 10722, post 37, Denon Home 150 at 192.168.1.30): confirmed by
  the reporter with 1.2.0 (post 39): no repeated warnings, no orange dot, power/input/sound mode
  gone after Discovery > Update, volume/mute/playback/announcements working. Not seen in his
  logs: the `... is a HEOS speaker ...` line (asked again).
- Widget Vol −/+: 2 dB per tap accepted by the reporter (post 39); "L'action a échoué" still at
  times, see "Open after 1.2.1".

## Announcements from standby (forum topic 10722, post 42, guim31, after 1.2.4)

- Fixed, not tested on hardware: wait for the power report, 2 s, then the volume read back
  before the stream; no input put back before the standby (HDMI-CEC woke his Shield). To
  confirm by guim31 (AVR-S650H): volume applied, start of the message heard, TV stays off.
- Not known: whether the S650H echoes `PWON` at once (then the 2 s pause and the volume read
  back do the real waiting) or only once awake; whether it answers `MV50` while waking.
- Review denon-125-r1 (257485c): I1-I5 and m1-m5 fixed. Left on purpose: a volume changed with
  the remote (not Gladys) during the ≤ 4 s read back may be overwritten (a waking receiver may
  report its "Power On Level", which must not be taken for the user's); two mutants are
  equivalent and marked so in `scripts/mutants.json` (the `isCurrent()` in the catch, the
  `stopTimers` before tracking).
- The scene action's own volume is still dropped by the core (checked in Gladys 5.3.2:
  `scene.actions.js` passes `{ volume }` to `device.setValue`, the proxy service of
  `externalIntegration.registerProxyService.js` forwards only `value`). Nothing to change here.

## Qobuz and the music player (after 1.2.3, not tested on hardware)

Plan: `~/code/integrations/_lots/hors-lot/qobuz/denon-qobuz-plan.md`. Waiting for Louis' "Qobuz:
check" output with an artist (lines "Qobuz check" of the logs) to replace the guesses:

- [ ] Qobuz search criteria (assumed TIDAL's: Artist 1, Album 2, Track 3 with
      `SEARCHED_TRACKS-`, Playlist 6) and the `cid` a searched track is queued with.
- [ ] The names of the Qobuz tree ("Library" > "Playlists" assumed) and of an artist page
      ("Albums", "Top Tracks", a "latest release" or "radio" entry?).
- [ ] The order of an artist's albums ("latest album" = first listed is an assumption) and any
      date or year field.
- [ ] Whether add_to_queue really accepts a Qobuz playlist listed `playable: no`.
- [ ] The other services (TIDAL tree, TuneIn criteria names, Local Music/AUX sub-sources) are
      shaped on the spec and TIDAL/Deezer captures: confirm from a real "check" output.
- [ ] Next: duration and position (`event/player_now_playing_progress`), search in the local
      music servers.

### Review r1 (3a85841, 85c612d), left on purpose

- m4: the queue panel reads the whole queue (up to 500, pages of 100) for any page, and
  `total`/`currentIndex` stop at 500. Reading only the asked page needs a queue length HEOS does
  not document (`get_queue` gives no count in the spec).
- m7: an unknown play mode falls back to "replace" (the core only sends replace/next/append);
  with "dernier album de X" the search's type filter is ignored (only an album makes sense); the
  module's errors are in English, like before.
- Mutant left alive (equivalent): an artist page whose browse runs past the deadline, taken as
  empty, ends in the same refusal without any request sent.

## Decisions

- 2026-11-03 (1.2.3, review denon-123 r1 I1), which gaps judge an active jingle (`recordBreak()`,
  `src/adbreak/jingles.js`): only a gap the detector took for a break, i.e. a break was started
  for that song end (`track.breakHandled`, passed by `onGap`: ad window, start jingle, "it's an
  ad"). Every 200-900 s gap is still sampled for learning. Not counted: a long host talk outside
  the windows, and a gap whose song ended in a window already used (the detector takes it for the
  host, `WINDOW_REUSE_MS`). The "song end in a learned ad window" fallback was not kept for that
  case: an hourly talk after the break, in the same window, would count one miss per hour and
  could demote the end jingle (Louis: 74/74). Cost: a real second break in a used window, or a
  real break outside the windows without the start jingle, is not judged. That only delays the
  verdict; it never demotes a good jingle. The end range is 150 s before the next song
  (`VERDICT_SECONDS`, what confirms an end hit), the start range stays 90 s after the song end.
- 2026-11-03, known limit, out of scope of 1.2.3 (review denon-123 r1, "Hors périmètre"): on HLS
  the decoded stream likely runs ~30 s ahead of the receiver. The ring dates the last sample
  received "now", and HLS sends whole 5 s segments (15 s at once at the start); the receiver
  plays 40 s behind the title feed (`sources.js`). So jingle hits act ~30 s early on HLS (volume
  lowered during the host talk, back during the last ads), and the learning windows and the 10 s
  miss margin are shifted alike. Icecast (Louis, via TuneIn): ~2 s, no effect. To be measured by
  the step 0 test bench; fix then: date the ring in receiver time, or delay hits by the offset.

- 2026-11-01 (review r1 of f37aa92), HEOS-only speaker (`src/devices/speaker.js`): HEOS matched,
  the last Telnet attempt refused (ECONNREFUSED only) and a speaker model (in a session, the HEOS
  `model` only; the SSDP `modelName` only decides what Discovery offers): "Denon Home", "HEOS",
  never AVR/receiver/SR/NR/AV/PM/CINEMA models. No model, no speaker: an AVR never loses
  power/zones on a guess (r1 I3). Never once Telnet came up in the session (sticky otherwise until
  then). Telnet retried every 5 min. No power feature (HEOS CLI has none). Badge follows HEOS only
  (r1 I2); "only HEOS answers" on an AVR waits for 3 Telnet failures.
- 2026-11-01, widget Vol −/+ (`nudgeVolume()`): 2 (Telnet, 2 dB on the 0-98 scale since 1.2.1) / 5 % (HEOS) from the last
  wanted level (kept 2.5 s), 60 ms between volume commands per device; the device features
  Volume up/down keep one remote step (MVUP/MVDOWN).
  Wanted level capped by `MVMAX` (main zone) and 0-100 (r1 I4); `buildSetVolumeCommand` clamps
  too.

- 2026-10-31, power mode per receiver (`src/devices/power.js`), after reviews r1 and r2 (a lost
  `ZM?` answer, then a saved `DeviceZones=1`, could make a multi-zone AVR cut Zone 2 with
  `PWSTANDBY`):
  1. A `Z2`/`Z3` line = zones, over everything.
  2. `DeviceZones` read this session from `/goform/Deviceinfo.xml` (port 80, then 8080, 64 KB,
     3 s each, once per session): 1 = `PWON`/`PWSTANDBY`, 2 or more = `ZMON`/`ZMOFF`. A `ZM`
     line does not override a 1 (a one-zone unit may answer `ZM?` and ignore `ZMON`).
  3. A `ZM` line, or a saved "with zones" verdict = zones. `/data/power-modes.json` keeps only
     "with zones" (DeviceZones >= 2, ZM line, Z2/Z3 line) per device and IP, never a 1; the
     entry is deleted with the device (kept on shutdown and config changes).
  4. Only without `DeviceZones` and with a readable `/data`: Telnet probe. `PW?` answered, while
     `ZM?` (sent with the first queries, then again alone after 4 s) and `Z2?` get no answer
     within 6 s = no zones.
  5. In doubt (nothing answered, probe cut by a disconnect, `Deviceinfo.xml` still being read,
     `/data` unreadable): `ZMON`/`ZMOFF`, as in 1.1.0. Accepted limit: an AV receiver without
     `Deviceinfo.xml`, on its very first connection, that loses `ZM?` twice and `Z2?`.
     Zone 2 and Zone 3 never use `PW` commands.
- 2026-10-30, power commands are re-queried after 2 s and followed for 5 s: no power report back
  turns the device badge degraded (not an error: the command may still have worked).

## Done in 1.2.1 (forum topic 10722, post 39)

- Volume percent = the receiver's raw 0-98 number (display match); widget taps top out at 98.
- Widget nudges only for a device a widget showed, burst settled 400 ms.
- Announcements: end seen from HEOS' media too, queue cleared once over and silent.
- Port 23 refused by a device saved as a speaker: info, not warn. Speaker "not paired" badge text.
- Minors of reviews r3 (9191491) m1-m3 and denon-heos r2 (5896845) m1-m7.

## Open after 1.2.1

- r1 (f37aa92) m4: a delayed volume send (60 ms) that fails is only logged; the tap already
  answered success. Accepted, noted.
- Lyrion with announcements (post 39): how Lyrion plays on the PM7000N is unknown (UPnP bridge,
  AirPlay bridge, optical from a Squeezelite box...); the music is not resumed by the
  integration. Questions sent to the reporter.
- Denon Home at 192.168.1.48 (post 39) while it was at .30 (post 37): manual devices are tied to
  their IP (`manual:<ip>`). To confirm with the reporter.
- Widget actions: the core re-pulls after every successful tap (30 a minute shared with the
  nudges). To ask upstream: not counting that re-pull, or a device-feature slider in widgets.
- A receiver that never announces MVMAX: taps above its Max Volume are dead (r2 m4), documented.

## Done in the next patch (after 1.2.1)

- Gladys integration SDK `^0.15.0` -> `^0.16.0` (no `poll_frequency`/`should_poll` in `src`, no
  real-clock test to bring down to x20).
- Review denon-heos r5 (7514017) m1: done. Test "announcement named, then an empty mid, then
  stop: exactly one clear_queue" holds `entry.lastMid &&` in the queue guard (checked: it fails
  with the condition removed).
- Review denon-heos r5 m2 and r4 (0aafb10) m1: behaviour unchanged, now pinned by tests
  ("... named only after the announcement stop is cleared", "... named before HEOS ever named
  the announcement is cleared"), so any change is a deliberate one. Still open, see below.

## Still open (left on purpose: need HEOS logs from real hardware)

- Review denon-heos r3 (1e611b4) m4: the announcement `mid` is assumed to be its URL (not
  checked on hardware). If HEOS names the URL, then changes `mid` for the same stream (internal
  id, ICY metadata), "replaced by other playback" would end the announcement mid-message and give
  the old volume back while it speaks. Left: needs the reporter's `get_now_playing_media` lines
  during an announcement; a fix without that log would be a guess, and Tolkyen is testing the
  1.2.1 announcement behaviour now.
- Review r4 (0aafb10) m1: narrow window left. A queue started from the HEOS app during an
  announcement BEFORE HEOS named the announcement's own `mid` is still cleared at its end (the
  guard only keeps a queue when the announcement was seen, then replaced). Accepted: the other
  way round would stop clearing whenever `mid` is not the URL. Pinned by a test.
- Review denon-heos r5 m2: the guard keeps a queue started from the HEOS app only if HEOS names
  it BEFORE the announcement's "stop" event; if "stop" comes first, the end is "over" and the new
  queue is cleared. Left: the real HEOS event order is not known (same log as r3 m4); waiting a
  while for a late `mid` before clearing would change when the volume and input come back, which
  the 1.2.1 test is checking. Pinned by a test.

## Next patch (review denon-125-r2, minors)

- [ ] M1: `--test-force-exit` (script `test`) sometimes drops a result line without failing
      (node 22.23.4: `test/protocol.test.js` alone, 1 run in 150 prints 31 results of 32; in a
      x20 loop, 517/525 and 524/525 with exit 0). Remove it from the script (check the whole
      suite still exits), or have `gi` compare the test count.
- [ ] M2: an announcement started right after the previous one's standby, before the standby
      report: the state still says on, so it takes the "recent wake" path (no ZMON), then the
      1 -> 0 report is taken for the remote and stops it, silently (log "switched off (remote or
      front panel)"). Fix: `wakes.delete(id)` when the announcement's own standby is sent
      (`fromAnnouncement`), and "recent" only without a standby sent since.
- [ ] The other ~25 fixed `await wait()` of `test/adbreak-controller.test.js` have the same shape
      as r2 I1 (never failed so far); the `wait(100)` after `setAdBreak(false)` also flushes the
      stats save, keep it.

## Next patch (review denon-123-r2, minors)

- [ ] Tests on the end-range bounds (4 mutants survive): end jingle 158 s before the next song (heard), 5 s after it (heard), 12 s after it (missed).
- [ ] Code comments that overstate: `src/adbreak/index.js:228-232` and `src/adbreak/jingles.js:778-780` say host talk "never" makes a jingle look missed. It can, when the window rule takes the talk for a break or after a mistaken press. Same wording issue at `src/adbreak/detector.js:52`.
- [ ] Limits for step 2 and the bench: start-jingle recall is biased upwards outside the windows (only breaks it opened are judged). "74/74" is a precision, not a recall: the end jingle's real recall will show in the 1.2.3 widget. Simulated demotion rate: 1 per 140 judged breaks at 80 % recall, 1 per 62 at 74 %.

## Next patch (review of the music player, relecture-r2, minors)

- m1: Amazon connected but refused by HEOS gives the raw error without the service name; a failed
  `get_music_sources` fails the whole catalog root, HEOS favorites included (keep favorites and playlists).
- m2: multi-service search is bounded in time only (about 15 requests per keystroke for 3 services).
- m3: "Artwork left out of the widget (<URL>)" logs the image URL: drop the URL.
- m4: a small "what each service can do" table in docs/en.md and docs/fr.md (README and this file have it).
- m5: "Preferred service" setting misses Amazon, Pandora, SiriusXM.
- m6: 1 s or less left for the acting step when the zone wakes from standby.
- m7: the check button has no per-service deadline.
