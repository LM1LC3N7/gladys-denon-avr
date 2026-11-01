# TODO

## Open

- Power on receivers without zones (forum topic 10722, post 35, Marantz PM7000N): confirmed
  working by the reporter with 1.1.1 (post 37). Still not known: whether the PM7000N serves
  `/goform/Deviceinfo.xml` with `DeviceZones`, and what it answers to `ZM?`.
- HEOS-only speakers (forum topic 10722, post 37, Denon Home 150 at 192.168.1.30): checked on a
  simulated speaker only. To confirm with the reporter after the release: the log line
  `... is a HEOS speaker (Denon Home 150) without AVR Control ...` once, no more repeated
  `Telnet socket error` warnings, no orange dot, and the device list after Discovery > Update.
- Widget Vol −/+: the core caps (30 actions and 30 content reloads a minute per integration)
  stay; to ask upstream: not counting the re-pull that a successful action itself triggers, or a
  device-feature slider in widgets. To confirm with the reporter: 2 dB per tap is not too much.

## Decisions

- 2026-11-01 (review r1 of f37aa92), HEOS-only speaker (`src/devices/speaker.js`): HEOS matched
  - last Telnet attempt refused (ECONNREFUSED only) + a speaker model (HEOS `model`, SSDP
    `modelName`: "Denon Home", "HEOS", never AVR/receiver/SR/NR/AV/PM/CINEMA models). No model, no
    speaker: an AVR never loses power/zones on a guess (r1 I3). Never once Telnet came up in the
    session (sticky otherwise until then). Telnet retried every 5 min. No power feature (HEOS CLI
    has none). Badge follows HEOS only (r1 I2); "only HEOS answers" on an AVR waits for 3 Telnet
    failures.
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

## Next patch (review r3, 9191491; m4 and m5 done 2026-11-01)

- r1 (f37aa92) m4: a delayed volume send (60 ms) that fails is only logged; the tap already
  answered success. Accepted, noted.

- m1: delete the /data power-mode entry only in onDeviceDeleted; keep the "with zones" verdict across IP changes for devices identified by UDN (H12, H13).
- m2: when DeviceZones=1 arrives after a ZM line was seen, send `Z2?` alone again.
- m3: tests for T5 (a saved ZM verdict never beats a DeviceZones=1 read) and T9 (deletion never writes over an unreadable /data).

## Next patch (review denon-heos r2, 5896845)

- m1: no test for "speaker turned back into a receiver whose Telnet drops again keeps the receiver backoff", nor for "`retryIn` during an attempt opens no second socket".
- m2: surviving mutant V1b: capping a reported volume above the ceiling (`src/control.js:~347`).
- m3: surviving mutants V20, V24, V25, V15b, B3, S13 have no test (details in `_lots/hors-lot/denon-heos-r2.md`).
- m4: a receiver that never announces MVMAX gets the r1 behaviour back (presses past its ceiling are dead); the docs' "never above" needs "when the receiver announces its maximum".
- m5: README, docs and TODO say the SSDP model decides too; in a session only the HEOS model decides. Align one with the other.
- m6: speaker mode with HEOS "not paired" shows "Cannot reach the speaker": say what is really wrong.
- m7: malformed bullet in this file.
