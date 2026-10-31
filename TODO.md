# TODO

## Open

- Power on receivers without zones (forum topic 10722, post 35, Marantz PM7000N): checked against
  the published protocols (Marantz M-CR511/611, Denon DRA-100), python denonavr's rule and
  simulated receivers only. To confirm with the reporter's logs after the release: the
  `DeviceZones` and `power mode is now ...` lines, then `sent PWON` / `sent PWSTANDBY`.
- Not known: whether the PM7000N serves `/goform/Deviceinfo.xml` with `DeviceZones` (python
  denonavr relies on it for one-zone models), and what it answers to `ZM?`.

## Decisions

- 2026-10-31, power mode per receiver (`src/devices/power.js`), after review r1 of da2455b
  (a single lost `ZM?` answer could make a multi-zone AVR cut Zone 2 with `PWSTANDBY`):
  1. `DeviceZones` from `/goform/Deviceinfo.xml` (port 80, then 8080, 64 KB, 3 s each, once per
     session) decides: 1 = `PWON`/`PWSTANDBY`, 2 or more = `ZMON`/`ZMOFF`. Nothing overrides it.
  2. Any `ZM`/`Z2`/`Z3` line = zones, kept in `/data/power-modes.json` per device and IP address.
  3. Only without `DeviceZones` and with a readable `/data`: Telnet probe. `PW?` answered, while
     `ZM?` (sent with the first queries, then again alone after 4 s) and `Z2?` get no answer
     within 6 s = no zones.
  4. In doubt (nothing answered, probe cut by a disconnect, `Deviceinfo.xml` still being read,
     `/data` unreadable): `ZMON`/`ZMOFF`, as in 1.1.0.
     Zone 2 and Zone 3 never use `PW` commands.
- 2026-10-30, power commands are re-queried after 2 s and followed for 5 s: no power report back
  turns the device badge degraded (not an error: the command may still have worked).
