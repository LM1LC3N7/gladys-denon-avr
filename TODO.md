# TODO

## Open

- Power on receivers without zones (forum topic 10722, post 35, Marantz PM7000N): checked against
  the published protocols (Marantz M-CR511/611, Denon DRA-100), python denonavr's rule and
  simulated receivers only. To confirm with the reporter's logs after the release: the
  `DeviceZones` and `power mode is now ...` lines, then `sent PWON` / `sent PWSTANDBY`.
- Not known: whether the PM7000N serves `/goform/Deviceinfo.xml` with `DeviceZones` (python
  denonavr relies on it for one-zone models), and what it answers to `ZM?`.

## Decisions

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
