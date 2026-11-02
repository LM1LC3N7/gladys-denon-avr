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

## Decisions

- 2026-11-01 (review r1 of f37aa92), HEOS-only speaker (`src/devices/speaker.js`): HEOS matched,
  the last Telnet attempt refused (ECONNREFUSED only) and a speaker model (in a session, the HEOS
  `model` only; the SSDP `modelName` only decides what Discovery offers): "Denon Home", "HEOS",
  never AVR/receiver/SR/NR/AV/PM/CINEMA models. No model, no speaker: an AVR never loses
  power/zones on a guess (r1 I3). Never once Telnet came up in the session (sticky otherwise until
  then). Telnet retried every 5 min. No power feature (HEOS CLI has none). Badge follows HEOS only
  (r1 I2); "only HEOS answers" on an AVR waits for 3 Telnet failures.
- 2026-11-01, widget Vol −/+ (`nudgeVolume()`): 2 % (Telnet, ~2 dB) / 5 % (HEOS) from the last
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
