# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Gladys music player (requires Gladys 5.3.0 or newer, which this version now needs). The
  receiver works in the dashboard Music box and in Gladys' "Play music on a speaker" scene
  action:
  - catalog: HEOS favorites, HEOS playlists and Qobuz, browsed as in the HEOS app;
  - search in Qobuz: artists, albums, playlists and tracks. An artist also offers its "latest
    album", picked when it is played. Typing "dernier album de Céline Dion" offers it first;
  - play with replace, play next or add to the end;
  - the queue, with the current track; a tap jumps to a track;
  - now playing: title, artist, album and artwork, as four new music features. For a receiver
    already added, run a Discovery scan and click Update to get them.
- Scene action "AVR: play from Qobuz": besides a playlist or an album, it now plays the latest
  album of an artist, an artist (its radio, else its popular tracks, else every track found by
  its name) or a track. An optional Artist field narrows an album or a track down. A queue mode
  replaces the queue, plays next or adds to the end. The action also returns the type played
  and how it was found. Existing scenes keep working unchanged.
- Every HEOS music service, not only Qobuz:
  - the music player's catalog lists every service signed in in the HEOS app (TIDAL, Deezer,
    Amazon Music, SoundCloud, TuneIn, iHeartRadio, Napster, Pandora…), the network music servers
    and USB (Local Music), History and the inputs (AUX Input). A service not signed in is not
    shown. Spotify is not either: in HEOS it is Spotify Connect only, started from the Spotify
    app;
  - the search looks in the "Preferred music service for the search" (new setting): Automatic
    is Qobuz when it is signed in, else every service that can search, each result naming its
    service. "Dernier album de X" works with any service that can search albums;
  - new scene action "AVR: play from a HEOS music service": a service field, the same kinds as
    the Qobuz action, plus a radio station by its name (TuneIn, iHeartRadio…). "AVR: play from
    Qobuz" is unchanged for the scenes using it.
- "HEOS services and Qobuz: check" (formerly "Qobuz: check and list my playlists") first lists
  every service HEOS sees, signed in or not, with its search criteria.
- "Qobuz: check": an optional artist to test. The integration logs (lines "Qobuz check") show
  what the receiver really answers: sources, first level and its options, the playlist
  containers, the search criteria and, with an artist, the artist search, the artist page and
  what "latest album" and "artist" would play. Nothing is played. The account name and the
  image URLs are never logged.

### Fixed

- Music commands now end before Gladys stops waiting (10 s): after 8 s the integration stops,
  starts nothing and says that the service did not answer in time, so the music never starts
  after Gladys showed a failure, and a slow command no longer delays the next ones. A search
  stops at 6 s on every service and keeps what it found. A search that found nothing because a
  service failed now says so instead of showing no result.
- Artwork above 300 KB, or not a PNG, JPEG or WebP, is left out with a log line.
- After Discovery "Update", the now-playing features show the current track at once.
- The check logs hide any URL and any nested value, and the account name even when the sources
  step fails.
- Qobuz playlists that HEOS lists as not playable (a known HEOS behaviour) are now found and
  queued. A playlist is no longer opened as if it were a folder.
- Qobuz is also recognized by its usual HEOS source id (30) when HEOS gives it no name.

### Changed

- Gladys 5.3.0 or newer is required (the music player). On an older Gladys, version 1.2.3 stays
  installed.

## [1.2.3] - 2026-11-03

### Fixed

- Radio ad breaks (OUI FM, reported by Louis): with a learned start jingle,
  every break the jingle was not heard in was taken about 90 s after the song
  end instead of after the learned host talk (45 s by default). Only hits were
  judged, so a jingle that no longer matched stayed active forever and blocked
  relearning. Now each break the integration detected (Radio ad break switched
  on for that song end: ad window, start jingle or a press), when its sound was
  heard in full, records whether each active jingle was heard. A long host
  talk with no break is not judged. The last 10 results are kept in
  `/data/ad-jingles`, and each miss is logged with the best score seen.
  - The start jingle counts as heard up to 90 s after the song end, the end
    jingle up to 150 s before the next song (the delay that confirms its
    hits), with 10 s of margin.
  - The 90 s fallback wait only applies to a reliable start jingle, heard in
    at least 80 % of at least 5 recorded breaks. Otherwise the learned host
    talk is used, as with no jingle. A jingle saved by an earlier version has
    no record yet, so it gets the learned talk right after the update.
  - An active jingle missed in more than half of its last 6 recorded breaks
    goes back to observation (template kept, hits and confirmations reset).
    A different shared sound may then replace it.
  - The Radio widget and the Ad-break report show the recall: "heard in 3 of
    the last 10 breaks" (« reconnu dans 3 des 10 dernières coupures »). They
    also say when the 90 s wait is not used.

## [1.2.2] - 2026-11-03

### Changed

- Gladys integration SDK 0.16 (`@gladysassistant/integration-sdk` `^0.16.0`).
  No change in behaviour.
- Announcements: the HEOS queue guard is now held by a test (an empty media id
  after the announcement's own still clears the queue once), and the two
  accepted limits of that guard (a queue named before the announcement, or
  after its end) are pinned by tests.

## [1.2.1] - 2026-11-02

### Fixed

- Volume (forum topic 10722, post 39, Marantz PM7000N): from 25 up, the widget
  showed one more than the receiver's display. Over Telnet the volume is now
  the receiver's own number, 0 to 98 (half steps kept): what Gladys shows is
  what the receiver shows. 99 and 100 are sent as 98. **A scene, an
  announcement volume or a saved volume now plays louder than before for the
  same number: +1 dB from 26 to 75 and 99, +2 dB from 76 to 98** (for example
  90 sent `MV88` before, `MV90` now); 0 to 25 and 100 are unchanged. To get the
  old level back, lower the number by 1 (26-75) or 2 (76-98). HEOS speakers
  keep their 0-100 scale.
- Widget Vol −/+ steps are now 2 dB (from a half step set with the remote, such
  as 25.5, the result is rounded to a whole number: 28 or 24) and stop at 98 (or the receiver's
  "Max Volume" when it announces it, a half-step one included), so Vol − acts
  from the first tap.
- "The action failed" in the widgets: the integration's own widget reloads
  share Gladys' 30-a-minute budget with the taps. A card is now reloaded only
  for the device it shows, never before Gladys first loaded it (except during
  the first 5 minutes after the integration starts), and once per burst of
  changes.
- Announcements (music from Lyrion or another app playing on HEOS before): the
  end of the message is seen at once even when the music kept HEOS on "play",
  or when another app takes the player back, instead of after 15 s. Once the
  message is over and nothing else plays, the HEOS queue is emptied (only with
  "Restore the receiver after an announcement" on, the default), so a later Play
  no longer speaks it again. The music itself is still not resumed by the
  integration.
- A HEOS speaker already updated from Discovery logs the refusal of port 23 at
  start as information, not as a warning. Its badge names the right problem
  when HEOS answers without a player at its address (address changed).
- A garbled or empty HEOS volume is treated as unknown, never published as NaN or 0.
- Power mode: a receiver keeps its saved "with zones" verdict when its device
  is updated (it is only forgotten when the device is deleted), and a
  discovered receiver keeps it at a new IP address. When Deviceinfo.xml says
  one zone after the receiver answered `ZM`, `Z2?` is asked again, so a Zone 2
  whose first answer was lost is not cut by `PWSTANDBY`.

## [1.2.0] - 2026-11-01

### Fixed

- HEOS-only speakers (Denon Home, HEOS 1/3/5/7, HEOS Link/Amp/Drive; forum
  topic 10722, post 37): recognized when port 23 is refused while HEOS answers
  and the model HEOS or the scan announces is a speaker one; a device without a
  readable model stays a receiver. Volume, mute, playback and
  announcements go through HEOS; power, inputs, sound modes, the Setup menu
  and the tuner are no longer offered (Discovery, then **Update** on a device
  added before) and are refused with a clear message, nothing sent. No more
  orange dot on the badge (unreachable as soon as HEOS is lost), one log line
  instead of a Telnet warning every 10-30 s, Telnet retried every 5 minutes. A device whose Telnet answers, or a
  known receiver/amplifier model, is never treated as a speaker.
- Widget Vol −/+: several quick taps ended on "The action failed", then every
  widget button stayed dead up to a minute. Gladys allows 30 widget actions
  (and 30 content reloads) a minute per integration, and one tap was one
  0.5 dB step. A tap now moves about 2 dB (5 % on a HEOS speaker) from the last
  requested volume, quick taps add up and are spaced to the receiver's pace,
  never past the receiver's "Max Volume" (MVMAX). HEOS volume levels are kept
  within 0-100.
- The Telnet socket error of a receiver that stays unreachable is logged once
  while it repeats, not at every attempt.
- The "only HEOS answers" badge of an AV receiver waits for 3 failed Telnet
  attempts instead of flashing while the receiver starts.

## [1.1.1] - 2026-10-31

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

[Unreleased]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.1.1...v1.2.0
[1.1.1]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.1.0...v1.1.1
[1.1.0]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.0.25...v1.1.0
[1.0.25]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.0.24...v1.0.25
[1.0.24]: https://github.com/LM1LC3N7/gladys-denon-avr/compare/v1.0.23...v1.0.24
[1.0.23]: https://github.com/LM1LC3N7/gladys-denon-avr/releases/tag/v1.0.23
