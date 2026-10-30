# TODO

## Open

- Power on receivers without zones (forum topic 10722, post 35, Marantz PM7000N): detection and
  `PWON`/`PWSTANDBY` checked against the published protocols (Marantz M-CR511/611, Denon DRA-100)
  and simulated receivers only. To confirm with the reporter's logs after the release: the
  `power mode is now "receiver without zones..."` line and `sent PWON`/`sent PWSTANDBY`.
- If a stereo model turns out to answer `ZM?` anyway but ignore `ZMON`/`ZMOFF`, add the second
  detection python denonavr uses: `DeviceZones` in `/goform/Deviceinfo.xml` (port 8080, or 80
  before 2016); `1` means no zones.

## Decisions

- 2026-10-30, power mode per receiver (`src/devices/power.js`): `ZMON`/`ZMOFF` until the receiver
  is known to have no zones (answers `PW?`, not `ZM?`, within 4 s of a connect); one `ZM` line
  ever seen keeps the zone commands until the session is closed, because `PWON`/`PWSTANDBY` would
  wake or cut Zone 2 on an AV receiver. Detection over Telnet only, no extra HTTP request. Zone 2
  and Zone 3 never use `PW` commands.
- 2026-10-30, power commands are followed for 5 s: no power report back turns the device badge
  degraded (not an error: the command may still have worked).
