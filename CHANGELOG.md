# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Fixed

- On/Off did nothing on receivers without zones, such as the Marantz PM7000N
  (forum topic 10722): their protocol has no zone power command (`ZMON`/
  `ZMOFF`), only the whole-unit `PWON`/`PWSTANDBY`. The integration now reads
  the number of zones the receiver declares (`DeviceZones` in its
  `Deviceinfo.xml` page, port 80 or 8080). Without that page, it checks what
  the receiver answers over Telnet, and switches to `PWON`/`PWSTANDBY` only
  when it answers the whole-unit power query and none of the zone queries. A
  Zone 2 or Zone 3 answer always means zones. In doubt, power stays
  `ZMON`/`ZMOFF`. Only "with zones" is remembered in `/data`, and the entry is
  deleted with the device. Known limit: an AV receiver without that page, on
  its very first connection, that loses all three zone answers is taken for
  one without zones until it answers one.
  "Speak on a speaker" uses the same commands (power on before, back to
  standby after).

### Added

- Each power command is logged at info level with the exact command sent,
  the power is asked again 2 s later, and a command still unconfirmed after
  5 s turns the device badge orange, naming the command. "Test connection"
  tells which power commands the receiver gets.

## [1.1.0] - 2026-10-15

### Added

- Scene action **AVR: play from Qobuz**: a Qobuz playlist (yours first, then
  the catalog) or album, by name, through HEOS, which has Qobuz built in
  since 2025; the configured zone is switched on and to HEOS, the queue
  replaced. The name played (and the artist of an album) are outputs.
- Configuration button **Qobuz: check and list my playlists**: whether HEOS
  sees Qobuz on the receiver, signed in or not, and the playlists found.

## [1.0.25] - 2026-10-13

## [1.0.24] - 2026-10-13

### Changed

- Shared tooling of the LM1LC3N7 Gladys integrations: CI on Node 22 and 24
  with `npm audit`, Release workflow driven by this changelog, GitHub Releases
  from its sections, grouped Dependabot updates.
- Gladys integration SDK 0.15: poll-frequency and batch validation of the
  discovered devices, state heartbeat, the SDK fake Gladys for the tests.

## [1.0.23] - 2026-10-13

The releases before this file was started are described by their GitHub
Releases.

[Unreleased]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.0.25...v1.1.0
[1.0.25]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.0.24...v1.0.25
[1.0.24]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.0.23...v1.0.24
[1.0.23]: https://github.com/LM1LC3N7/gladys-denon-avr/releases/tag/v1.0.23
