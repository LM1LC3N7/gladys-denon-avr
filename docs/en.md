# Denon / Marantz AVR

Control a Denon or Marantz AV receiver from Gladys: power, volume, mute and input source. Works
with the "AVR Control" protocol shared by (almost) the whole Denon/Marantz networked receiver
lineup — not tied to a specific model.

## Overview

The integration talks directly to your receiver over the local network (Telnet, TCP port 23) —
no cloud account, no internet access needed (only the optional radio ad-break detection, and the
song titles of a few stations like OUI FM, reach the internet: see "Radio ad breaks"). The receiver itself pushes every state change
(power, volume, mute, source) as soon as it happens, whether triggered from Gladys, the
physical remote, or the Denon/HEOS app, so the dashboard stays in sync in real time.

These show up per receiver:

- **Power** — on/off, controllable. Only ever the **main zone** (or the zone picked in
  Configuration, see "Zone" below): turning the receiver on from Gladys can no longer wake it up
  on Zone 2, and turning it off no longer cuts a Zone 2 someone is listening to (except in the
  edge case described below, "Known limit").
  Receivers **without zones** (stereo network amplifiers and systems: for example the Marantz
  PM7000N, M-CR610/611, Denon DRA-100) have no zone power commands, only the whole-unit
  `PWON`/`PWSTANDBY`. The integration reads how many zones the receiver declares in its
  `Deviceinfo.xml` page (HTTP, port 80 or 8080): one zone means `PWON`/`PWSTANDBY`, two or more
  the zone commands. Without that page, it falls back on what the receiver answers over Telnet:
  `PWON`/`PWSTANDBY` only if it answers the whole-unit power query and neither the main-zone query
  (asked twice) nor the Zone 2 query. In doubt, it keeps the zone commands, and a Zone 2 or Zone 3
  answer always means zones, whatever the page says. Only "with zones" is remembered in the
  integration's data (for that device and IP address, deleted with the device), so it also
  applies after a restart; "without zones" is decided again at each start. Known limit: an AV
  receiver without that page that loses all three zone answers on a connection, as long as it has
  never given one (its very first connection, or a later one before any zone answer was kept), is
  taken for one without zones until it answers one. The choice is
  logged ("power mode is now ...") and shown by "Test connection"; each power command is logged at
  info level with the exact command sent. Checked against the published protocols and simulated
  receivers, not yet against a real PM7000N.
- **Volume** — controllable. Over Telnet the value is the receiver's own volume number, 0 to 98
  (1 = 1 dB, 80 = 0 dB; half steps such as 40.5 show as is): Gladys shows what the receiver
  displays (with its volume display set to absolute "0-98"; the dB display is that number minus
  80). 99 and 100 are sent as 98. Up to 1.2.0 the 0-98 scale was stretched to 0-100, so from 25 up
  Gladys showed one more than the receiver (forum, Marantz PM7000N). **A scene, an announcement
  volume or a saved volume now plays louder for the same number: +1 dB from 26 to 75 and 99,
  +2 dB from 76 to 98** (for example 90 sent `MV88` before 1.2.1, `MV90` now); 0 to 25 and 100
  are unchanged. To get the old level back, lower the number by 1 (26-75) or 2 (76-98). A half
  step (25.5) is rounded when Gladys sets it (`MV26`). The Gladys slider still goes to 100, but
  over Telnet anything above 98 is 98. The HEOS fallback below keeps HEOS'
  own 0-100 scale. On a HEOS-equipped
  device, if the classic Telnet control isn't reachable at all (see "HEOS support" below — this is
  the case for a standalone HEOS speaker, not a real AV receiver), Volume/Volume up/Volume down
  fall back to HEOS's own volume commands automatically.
- **Mute** — on/off, controllable. Same HEOS fallback as Volume above when Telnet isn't reachable.
- **Source** — a dropdown of the receiver's input codes (e.g. `TUNER`, `BD`, `NET`), directly on
  the dashboard. The **Select input** action described below does the exact same thing and stays
  available as an alternative — useful if your Gladys instance is on an older version that
  doesn't render the dropdown yet. You can rename or hide entries — see Configuration below.
- **Source index** — the same source control as a plain number instead of a dropdown: 0 is the
  first entry currently shown in the Source dropdown above, 1 the second, and so on. If you hide
  an entry (see Configuration below), every entry after it shifts down by one — the numbering
  always matches what's actually visible in the dropdown at the time. This exists for **scenes**:
  see "Automating source/sound mode from a scene" below for why you may or may not need it,
  depending on your Gladys version.
- **Sound mode** — a dropdown of surround/sound modes (e.g. `MOVIE`, `STEREO`, `PURE DIRECT`).
  Fewer receivers behave identically here than for the other controls — if a mode you use on the
  physical remote doesn't appear, it's likely just missing from the generic list this integration
  ships with.
- **Play / Pause / Next / Previous** — buttons that control playback on a network/USB/streaming
  source (Qobuz, Spotify Connect, TIDAL, internet radio...). They do nothing on a source that
  isn't a player (a TV input, for instance). **These need a Music box, not the plain device
  list**: on your dashboard, add a box and pick **Music** as its type, then this AVR as its
  device — that's what actually renders the play/pause/skip buttons. In the regular device list
  they only show up as plain rows with no visible value, which is expected there. On a
  HEOS-equipped receiver, these buttons are sent over HEOS whenever possible, since that's the
  actual control path for HEOS-managed sources like Qobuz or Spotify Connect — see "HEOS support"
  below.
- **Now playing** — a read-only "Artist - Title" line, filled in automatically while streaming.
  For an internet radio station with no track metadata, the "Artist" slot falls back to the
  station's own name (e.g. "Oui FM") — the same name the receiver's front display shows — instead
  of staying blank next to a generic stream description like "63 kbps aac".
- **Play notification** — backs Gladys' built-in **"Speak on a speaker"** scene action: pick this
  AVR from that action's speaker dropdown and it reads your text out loud. Requires HEOS (see
  "HEOS support" below) — there is no legacy-Telnet way to play an arbitrary audio URL, so this
  only appears/works once a HEOS player id has been matched for this receiver. The volume slider
  in that scene action never reaches this integration: Gladys does not forward it to this kind of
  integration (a core limitation). Instead, set **Announcement volume** in the Configuration (0 =
  current volume), and leave **Restore the receiver after an announcement** on: once the
  announcement is over, the receiver gets back its previous volume, input and standby state (the
  volume is left alone if someone changed it during the announcement). A receiver that was in
  standby goes back to standby on the network input: its previous input is not selected first,
  because selecting an HDMI input wakes the player on it over HDMI-CEC (which can switch the TV
  on); a player woken later by HDMI-CEC selects its own input anyway. From standby, the
  announcement waits for the receiver to report itself on (up to 5 s, then it goes on anyway),
  pauses (**Delay after power on before an announcement**, 4 s by default, 0 to 15), then waits for
  the announcement volume to be read back (up to 4 s, sent again every
  second, within one step, or the receiver's Max Volume when it is lower) before the message
  starts (worst case from standby: 5 s + 15 s + the input switch + 4 s, about 25 s, every wait
  bounded); the scene action is answered after 3 s at most while this goes on. Switching the
  receiver off meanwhile (from Gladys or its remote) stops the announcement, and nothing is
  restored; a volume you set from Gladys meanwhile is kept. A volume changed with the remote
  during those few seconds may still be replaced by the announcement volume. Whatever HEOS was playing
  before (a radio, a playlist, a stream sent by another app over UPnP or AirPlay, Lyrion for
  instance) does not resume on its own: that app has to play again. Once the announcement is
  over and nothing else plays, the HEOS queue is emptied, so a later Play cannot speak it again.
  This needs **Restore the receiver after an announcement** on: with it off, nothing follows the
  announcement, and a later Play may speak it again. The
  end is noticed as soon as HEOS stops, or as soon as it plays something else. This is also one of the features here that works on a standalone
  HEOS speaker (Denon Home, HEOS 1/3/5/7, Bar...) added through the manual IP fallback in
  Configuration, not just a real AV receiver — alongside Volume, Mute and Play/Pause/Next/Previous
  (all of which have a real HEOS equivalent, see "HEOS speakers" below). Triggering this scene action repeatedly in quick succession replaces
  whatever is currently speaking rather than queuing behind it — the queue is cleared before every
  announcement, confirmed necessary on real hardware (without it, a burst of announcements played
  back one after another instead of just the last one).
- **Setup-menu remote control** — cursor Up/Down/Left/Right, Enter, Return, Info, Menu and
  relative Volume Up/Down, shown as clickable buttons directly in the device list (no extra
  dashboard box needed). Handy for navigating the receiver's on-screen Setup menu from Gladys
  instead of hunting for the physical remote. Don't want all of them cluttering a dashboard? Hide
  the ones you don't use the same way you'd hide any other device feature — nothing to configure
  on this integration's side.

## HEOS speakers (Denon Home, HEOS 1/3/5/7...)

A standalone HEOS speaker (Denon Home 150/250/350, Denon Home Sound Bar, HEOS 1/3/5/7...)
answers HEOS (port 1255) but has no Telnet "AVR Control" (port 23 refused). For the other "HEOS"
models (Link, Amp, Drive...), the lack of Telnet is not verified: if they answer on port 23, they
stay handled as receivers.

The integration recognizes it when three things hold: HEOS lists a player at its address, port
23 is refused, and the model HEOS announces for that player is a speaker model ("Denon Home…",
"HEOS…"). The model found by the Discovery scan only decides what Discovery offers (a speaker
without power, input or sound mode); a running device follows the HEOS model. It is then immediate. Without a readable model, the device stays a receiver:
it keeps power, inputs and zones, Telnet is retried at the usual pace, and the badge gets the
"only HEOS answers" orange dot after three Telnet failures. A device whose Telnet answered even
once since the start stays a receiver, and a known receiver or amplifier model (for example the
Marantz PM7000N) is never taken for a speaker.

What the integration then does:

- **Volume, Volume up/down, Mute, Play/Pause/Next/Previous, Now playing and "Speak on a
  speaker"** go through HEOS.
- **Power, Source, Sound mode, the Setup menu, Quick Select and the tuner** do not exist in
  HEOS: a device discovered as a speaker does not have them; on a speaker added before this
  version, run a scan in the Discovery tab and click **Update** to remove them. Until then these
  commands are refused with a clear message ("not available on a HEOS speaker … nothing sent"),
  and nothing is sent.
- **Badge**: _local_, with no orange dot (not a degraded mode for a speaker); _unreachable_ as
  soon as HEOS stops answering (speaker unplugged).
- **Logs**: one info line ("… is a HEOS speaker … without AVR Control …") instead of a Telnet
  warning every 10 to 30 seconds. On a speaker already updated from Discovery, the first refusal
  of port 23 at start is an info line too (`Telnet socket error … ECONNREFUSED`), never a
  warning. Telnet is retried every 5 minutes. If it ever answers, the receiver commands work
  again at once; the features removed by **Update** only come back after a new scan and a new
  **Update**.
- **Address**: a speaker added through the manual IP (Configuration) is tied to that IP. If your
  router gives it a new one, add the new IP in Configuration, run Discovery and add it again (or
  give the speaker a fixed DHCP lease). The old device then says "Cannot reach the HEOS speaker"
  until the integration restarts, and after a restart "Cannot reach <old IP>:23… Check that the
  receiver is powered": at its old address nothing answers any more, so it can no longer be told
  apart from a receiver that is off.
- **Widgets**: the Amplifier card swaps Turn on/Standby for Play/Pause and shows "Power: Not
  controllable (HEOS)"; the Remote and Shortcuts cards keep only what works (Vol −, Vol +, Mute;
  HEOS favorites), the Radio card says there is no tuner.
- **Test connection** says "HEOS speaker (model) without AVR Control" and what works.

Checked against a simulated HEOS speaker (port 23 refused, HEOS answering with the model "Denon
Home 150"), not yet on a real Denon Home.

## Dashboard widgets

Since Gladys 5.1, this integration adds its own dashboard cards: edit a dashboard, add a card and
look for "Denon / Marantz AVR". Each card has a **Receiver** setting to pick the device (left
empty: the first receiver added). Cards show and trigger; the volume slider and the input
dropdown stay those of Gladys' own "Devices" card.

- **Now playing** — the cover art (or station logo), title, artist or station, album, input and
  sound mode, the live volume, with Previous, Play/Pause, Next and Mute. This is what Gladys'
  "Music" card does not show: no title, no artwork, and no volume for an AV receiver. The cover
  only appears when it is under 300 KB (Gladys' limit) and the integration's container can
  download it (often from the Internet).
- **Shortcuts** — four one-tap buttons, each picked among the inputs (with your "Rename/hide
  sources" names), **Quick Select 1-5** (Smart Select on Marantz: input, volume and sound mode
  stored in the receiver) and **HEOS favorites 1-8**. The active shortcut is ticked. Each button
  can get a custom label.
- **Amplifier** — power, input, sound mode and mute at a glance, the live volume, and Turn
  on/Standby, Vol −, Vol + and Mute buttons. In the cards, a Vol − or Vol + tap moves the volume
  by 2 on a receiver (2 dB, four remote presses) and by 5 % on a HEOS speaker. Quick taps
  add up from the last requested volume, even before the receiver answers, and never go out
  faster than the receiver takes them (one command every 60 ms at most, the last requested
  volume wins). They never go past 98, nor past the "Max Volume" set in the receiver when it
  announces it (`MVMAX`), so Vol − acts from the first tap. A receiver that does not announce its
  Max Volume may ignore the taps above it: a Vol − then takes a few taps to bite. The Volume up/down buttons of the device list keep one remote press.
- **Remote** — four keys of your choice (Up, Down, Left, Right, OK, Back, Menu, Info, Vol −,
  Vol +, Mute, Turn on, Standby; the four arrows by default). Place several side by side for a full
  pad (for instance an "arrows" card and an "OK / Back / Menu / Info" card).
- **Radio** — the FM/AM tuner: frequency, preset, band and tuning mode, with four buttons
  of your choice (Freq −/+, Preset −/+, AM/FM, Auto/Manual, Tuner input). The receiver only
  accepts these commands on the Tuner input: a press switches to it first when needed. Denon
  documents the AM/FM switch for North American models only. Set its **Show** setting to
  **Radio ad breaks** to see instead what was learned of the web radio's ads (see "Radio ad
  breaks" below).

## Scenes

Since Gladys 5.1, the scene editor offers this integration's own actions and triggers (look for
"AVR:"):

- **AVR: recall a Quick Select** — Quick Select 1-5 (Smart Select on Marantz).
- **AVR: play a HEOS favorite** — the n-th entry of the HEOS app favorites (a radio, a
  playlist…), on the configured zone, switched on and to HEOS when needed.
- **AVR: play from Qobuz** — a playlist, an album, the latest album of an artist, an artist
  (radio or popular tracks) or a track, by name, through HEOS; replacing the queue, played next or
  added at the end; see "Qobuz" below.
- **AVR: play from a HEOS music service** — the same from TIDAL, Deezer, Amazon Music,
  SoundCloud, Napster, TuneIn, iHeartRadio, Pandora, SiriusXM or Qobuz, plus a **radio by its
  name** (TuneIn, iHeartRadio…); see "Qobuz" below, which applies to all these services.
- **Play music on a speaker** (a Gladys 5.3 action, Music category) — a media picked from the
  receiver's catalog (HEOS favorites, HEOS playlists, signed-in services); see "Gladys music player" below.
- **AVR: set up the receiver** — power, input, sound mode and volume in a single action; a field
  left empty is not changed. Made for a "Movie" or "Music" scene.
- **AVR: read the receiver state** — returns power, volume, input (code and name), sound mode,
  Quick Select, playing, title and artist to the following actions of the scene — for instance a
  "Continue only if" on the input.
- Trigger **AVR: input changed** — from Gladys, the remote or the app, filterable on the receiver
  and on the new input (for instance: TV input → dim the lights). The previous input is available
  as a variable.
- Trigger **AVR: track changed** — a new title on HEOS or the network input, with title, artist,
  album and input as variables.

The generic **"Control a device"** action still works for Source, Sound mode and Source index. If
it shows nothing at all for this receiver, first try a **hard refresh / clear your browser cache**
(confirmed once as the cause: a stale cached front-end bundle), then run a **Discovery** scan and
click **Update** on the device.

## HEOS support

Denon/Marantz receivers with a HEOS module (most current network models) run HEOS as a separate
service alongside the classic Telnet control used for everything else on this page. Streaming
sources like Qobuz, Spotify Connect, TIDAL or TuneIn are actually played back _through_ HEOS —
the classic transport commands this integration used before have no effect on them at all.

Starting with this version, the Play/Pause/Next/Previous buttons talk to HEOS automatically when
the receiver supports it: no configuration needed, nothing to turn on. If HEOS isn't reachable
(no HEOS module, or its network port is blocked), the buttons transparently fall back to the
classic commands, which still work for the receiver's own non-HEOS Net/USB sources.

Volume, Volume up/down and Mute work the other way around: the classic Telnet commands stay in
charge whenever that connection is up (that's the confirmed-correct main-zone control on a real
receiver), and only fall back to HEOS when Telnet isn't reachable at all — in practice, a
standalone HEOS speaker with no "AVR Control" service whatsoever. If your Volume/Mute controls
stopped responding after this update on a real AV receiver, that would mean something else is
wrong with the Telnet connection (check the integration logs) — it's not this fallback kicking in.

Once HEOS is confirmed for your receiver, it also becomes the source for the playback state and
the "Now playing" title/artist — refreshed both when HEOS pushes a change and on a background
check every 30 seconds, so the dashboard catches up on its own within half a minute even if a
push notification is missed (this can happen if the HEOS connection drops briefly, which is a
known HEOS behavior on an idle connection).

**Limits**: this is implemented from HEOS's own (unofficial, but widely used) network protocol,
cross-checked against the library behind Home Assistant's official HEOS integration — not tested
by the developer against a live HEOS streaming session, since that requires an actual paid
streaming account. If the buttons don't do anything on your setup even though the receiver is
reachable, please report it (with the logs mentioned below) so it can be fixed.

## Qobuz

Since 2025 (HEOS 37.1), Qobuz is built into the HEOS app. The integration uses it to start Qobuz
music from Gladys, without a phone: at wake-up, when you come home, when a "Dinner" scene starts.

**Requirements**, once:

1. In the HEOS app, add Qobuz (home → Music services → the three dots → Edit → Add more music)
   and sign in to your Qobuz account.
2. Restart the integration: HEOS only shows a newly added service to a new connection.
3. In Gladys, press **HEOS services and Qobuz: check** (Configuration screen) and pick the
   receiver. The answer first lists **every service** HEOS sees, signed in or not, with its search
   criteria, then your Qobuz playlists. You may type an artist there (e.g. "Céline Dion"): the answer then also says which
   album would play as the "latest album" and how the artist would play, without playing
   anything.

**The scene actions "AVR: play from Qobuz" and "AVR: play from a HEOS music service"** (the
second has a **Service** field and one more kind, **Radio**: a station by its name, e.g. "FIP" in
TuneIn). All that follows applies to both, and to any service that can search (TIDAL and Deezer
follow the same shape as Qobuz):

| What to play              | What the action does                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------- |
| Playlist                  | looks first in **your** Qobuz playlists, then in the catalog                                |
| Album                     | looks in the catalog; the optional **Artist** field tells two albums of the same name apart |
| Latest album of an artist | type the artist; the action takes its latest release (see below)                            |
| Artist                    | its radio when HEOS offers one, else its popular tracks, else every track found by its name |
| Track                     | looks for the track; the **Artist** field picks the right version                           |

**Queue**: _Replace and play now_ (default), _Play next_ or _Add to the end_. A radio always
plays at once (HEOS does not queue a radio).

Case, accents and punctuation are ignored, and part of the name is enough ("morning jazz" finds
"Morning jazz 2024"). The configured zone is switched on and to HEOS when needed. The action
hands the following actions of the scene the **name played**, the **artist**, the **type** and
the **method** that found it.

**"Latest album"**: HEOS gives no release date. The action takes, in this order: a "latest
release" entry of the artist's page when HEOS shows one (method `latest_container`); the most
recent album when a year is in the names (`year`); else the **first album listed** by HEOS on the
artist's page (`first_listed`, Qobuz lists a discography newest first); failing that, the first
album found by a search on the artist's name (`album_search`, less reliable). The method is
returned by the action and logged: check it with the check button.

**"Artist"**: the returned method says what played: `artist_radio` (a radio of the artist),
`top_tracks` (its popular tracks), `artist` (its page, when HEOS calls it playable),
`created_station` (a station HEOS created, only when Qobuz offers it), `searched_tracks` (every
track found by its name).

Gladys never sees your Qobuz credentials: the receiver talks to Qobuz, with the account signed in
in the HEOS app. The list of your playlists is read again at most every 5 minutes.

**Limits**: Qobuz is not in the HEOS protocol documentation; all of this was built from the other
services and user reports, without a receiver showing Qobuz at hand. Qobuz playlists HEOS calls
"not playable" are queued anyway (a known HEOS defect). When something is not found, the check
button's answer and the "Qobuz check" lines of the logs show what the receiver returns (without
your account name nor the images): please send them so the lookup can be adjusted. A session
started from the Qobuz app (Qobuz Connect) stays controllable with the Play/Pause/Next/Previous
buttons, as before.

## Gladys music player

With Gladys 5.3 or newer, the receiver is a real music player in the dashboard **Music** box:

- **Now playing**: title, artist, album and artwork. For a receiver already added, run a
  **Discovery** scan and click **Update**: the four Title, Artist, Album and Artwork features then
  appear, with the current track.
- **Catalog**: _HEOS Favorites_, _HEOS Playlists_, then **every service signed in in the HEOS
  app**, in HEOS' order: Qobuz, TIDAL, Deezer, Amazon Music, SoundCloud, TuneIn, iHeartRadio,
  Napster, Pandora…, the network music servers and USB (_Local Music_), _History_ and the inputs
  (_AUX Input_, an input plays like a radio). Each is browsed as in the HEOS app. A service added
  but **not signed in** is not shown: the "HEOS services and Qobuz: check" button lists it with its
  state.
- **Search**: artists, albums, playlists, tracks and radios, in the **preferred service** chosen in
  the configuration ("Preferred music service for the search"): _Automatic_ searches Qobuz when it
  is signed in, else every service that can search (TIDAL, Deezer, TuneIn…), each result then
  naming its service. An artist found also offers "Dernier album · Latest album", picked when
  played: a scene saving it always plays the latest release. Typing "latest album by Céline Dion"
  offers it first, for any service that can search albums.
- **Play**: replace, play next or add to the end; an artist plays as the "Artist" action above. A
  radio (favorite, TuneIn, artist radio) and an input always play at once: HEOS does not queue them.
- The receiver's **queue**, with the current track; a tap jumps to a track.

Gladys' own scene action **Play music on a speaker** uses this catalog: the media is picked by
browsing or searching.

**Spotify**: in HEOS, Spotify is **Spotify Connect** only. Start it from the Spotify app (the
receiver shows there as a speaker); Play/Pause/Next/Previous and the now playing then work from
Gladys. It has no catalog to browse nor search, so it is not in the player.

**10 seconds at most**: Gladys waits 10 s for the answer of a music command. The integration stops
by itself after 8 s, then starts **nothing**, and says so ("… did not answer in time"). A search
stops at 6 s and keeps what it already found. On a slow service (Qobuz goes through its cloud,
several requests in a row), "latest album" and "artist" may not fit in that time from the Music box:
try again (what was read stays cached 5 minutes), or use the "AVR: play from…" scene action, which
waits up to 60 s. If the receiver is slow to confirm the very last command (queueing, playing), the
music may still start after the message.

**Artwork**: the image comes from the address HEOS gives (the service's image server, e.g. Qobuz's);
the integration downloads it, never your browser. An image above 300 KB, or not a PNG, JPEG or WebP,
is left out (empty frame, an "Artwork left out" line in the logs).

**Limits**: no duration nor position, no shuffle nor repeat for now; the search does not cover the
local music servers.

## Radio ad breaks

**Off by default.** To use it, switch on **Detect radio ad breaks** in the configuration, then run a
Discovery scan and click **Update** on the device to get its **Radio ad break** switch.

While a radio station plays through HEOS (TuneIn, a favorite, a stream URL), the integration spots
its ad breaks and turns the device's **Radio ad break** switch on during them. By default it also lowers
the volume by 20 steps, never below 20, then restores it when the music resumes. If you changed the volume by hand
meanwhile, your setting is kept. Everything is set in the "Radio ad breaks" section of the
configuration. To act in a scene of your own instead (switch station, mute…), switch off the
automatic volume drop and trigger your scene on **Radio ad break**. You can also switch it yourself: on means "it's an
ad" (the volume drops right away, and the integration learns), off ends the break and restores
the volume.

**How it works.** No station says "this is an ad" in its stream. Many do say what song is playing,
sometimes with its length. When a song ends and no other follows, the station is either airing ads
or the host is talking, and the time of the hour tells the two apart. For each station, the
integration learns the minutes of the hour its breaks (usually 4 to 8 minutes long; anything from
3 min 20 s to 15 min counts) start at, e.g.
:09–:14 and :34–:47 on OUI FM:

- **inside one of these windows**, a song ending with ~45 s of no music afterwards counts as a
  break. That delay lets the host talk before the ad jingle;
- **outside them**, the volume never drops on a mere lack of music: a feature, the news or an
  interview are not ads. Only the station's ad jingle, once learned, can open a break there;
- the break ends when the next song starts, with a 10-minute safety limit.

The windows depend on the day and the hour: weekdays, Saturdays and Sundays each have their own,
and an hour in which the station usually airs no ads (evenings, nights) has none. The learning is
continuous: while the station is followed, its playlist history is read again every hour, and
everything comes from the last 2 weeks (every day of the week seen twice). A schedule change is
picked up within days. The hours without ads are only learned on stations that publish their
playlist history; elsewhere, every hour keeps the windows.

**The ad jingle.** Each station opens its breaks with the same jingle (on OUI FM, "stay with us
during the ads"). While a station plays, the integration decodes its stream (ffmpeg) and compares
the sound of its breaks with each other. The sound found in most of them, even under the host's
voice, becomes the station's jingle. It is only observed at first, and becomes active after 2
detections followed by a real break. From then on the volume drops **at the jingle** instead of
after 45 s, and the host is no longer ducked. A break that comes without its jingle is still
caught by the windows rule. Expect a few hours of listening (3 long breaks), or 3
times switching **Radio ad break** on right after the jingle. A jingle that starts giving false alarms is
forgotten and learned again.

**A jingle that no longer airs.** Each break found from the song titles also checks the active
jingles. Only a break the integration detected counts: **Radio ad break** switched on for that
song end, by the ad window, the start jingle or a press. A long host talk with no break does not
count.

- The start jingle must air between the song end and 90 s after it.
- The end jingle must air within the 150 s (2 min 30) before the next song. This is also the delay
  that confirms its detections: the host may talk after the ads.
- A margin of 10 s is added on each side. It covers the delay between the receiver and the decoded
  stream when that stream is Icecast (about 2 s). An HLS stream runs further ahead (about 30 s).

Otherwise it is a **miss**. A break whose sound was not heard in full (listening started midway,
stream cut) does not count. The integration keeps the result of the last 10 breaks. The log notes
each miss with the best similarity seen.

- **Fallback wait.** With a reliable start jingle, a break without the jingle is taken 90 s after
  the song end instead of 45 s: the jingle is given time to air. Reliable means heard in at least
  80 % of the breaks, over at least 5 breaks. Otherwise the wait is the host talk learned (45 s, or
  the one of that hour), as with no jingle. A newly activated jingle is therefore not reliable yet.
  Its detections still lower the volume.
- **Back to observation.** An active jingle missed in more than half of its last 6 breaks goes
  back to observation. It keeps its sound, but its detections no longer act on the volume: the
  start jingle no longer lowers it, the end jingle no longer brings it back. The volume then comes
  back with the next song. The jingle must be confirmed twice again. If the next breaks share
  another sound, that one replaces it.

**Where song changes come from:**

- **HEOS metadata**: for any station that provides it (e.g. Radio Paradise through TuneIn). Song
  lengths are looked up on Deezer.
- **A dedicated feed**: for stations whose stream carries none. That is the case of **OUI FM**,
  followed through the live feed of its own website (title, artist, exact length). The title then
  also shows in "Now playing", instead of just the station's name. Its ad windows are learned from the ~3
  days of playlist history the site publishes, as soon as the station is first played (also for
  Voltage, Alouette, Hit West and the other stations of the Les Indés Radios platform).
- **Nothing at all** (some TuneIn stations): switch **Radio ad break** on when the ads start,
  and off when they end. After a few marked breaks the integration knows the station's schedule
  and lowers the volume at those times on its own. This is less precise than with song changes,
  since it cannot tell when the music actually stops.
  Switch it on right after the opening jingle, off right after the closing one: the integration learns
  both (they may differ). With no song changes to check them against, a detected jingle only
  counts when it falls in one of the station's ad windows or you switch it on right after it; the
  closing one, when it falls during a break.

On a station with song changes, switching **Radio ad break** on also fine-tunes the delay: do it at the ad
jingle and the integration learns the jingle itself and how long the host talks before the ads,
hour by hour. For
instance, OUI FM mornings have no host and the ads follow the song directly: two times at those
hours are enough for the volume to drop right away then.

**Known limit**: the end of a break is only known when the next song starts. If the host talks
again after the ads, that stays at the lowered volume until the song.

**Turning the radio on during the ads:**

- **with a station feed** (OUI FM…): caught within seconds — the feed gives the last song and its
  start, so the integration knows it ended without a next one, inside an ad window;
- **with no titles at all**: inside one of the station's ad windows, the break starts right away,
  for what is left of its usual length (counted from the window opening), unless less than
  30 s is left. Pausing then resuming during it does the same; once switched off by hand, that
  window stays off;
- **with HEOS titles**: not caught — the first title seen has no known start, so its end is
  unknown, and lowering the volume on a guess would also do it on music. The integration is back
  on track at the next song; switch **Radio ad break** on meanwhile if you like.

**Your volume always comes back.** A break never lasts more than 10 minutes. If the integration
stops or restarts during a break (update, configuration change), the volume is restored on the
way out. If the connection to the receiver drops, it is restored as soon as HEOS answers again
(given up after an hour, or if the volume was changed meanwhile). A "Speak on a speaker"
announcement during a break ends it first: the announcement plays at your normal volume, which
comes back afterwards.

**What was learned.** Add a **Radio** widget with **Show: Radio ad breaks** to the dashboard.
It shows the station playing (else the last one played):

- whether a break is on right now, or when the next ad window is (`Next ad window 14:34–14:47`);
- the breaks heard over the last 14 days, their typical length, today's breaks;
- each jingle: _active_ (with the number of recent breaks it was heard in, for example "heard in
  3 of the last 10 breaks"), _observing_, or not learned yet. The detail says whether the 90 s wait
  is used, and when a jingle went back to observation;
- where the song changes come from, how long the host usually talks before the ads, the volume
  lowered right now;
- one card per day type (weekdays, Saturday, Sunday): the hours with ads and their minute
  windows (`6h–21h · :09–:14, :34–:47`); open it for the detail hour by hour, with the breaks
  heard in each hour;
- the recent breaks (date, time, length, how they were found) and the details of each jingle
  (where it sits, when it was learned);
- an **It's an ad!** / **Ads are over** button, the same as the **Radio ad break** switch.

**The usual schedule in a chart.** The device also has a **Radio ad window** feature: 1 while the
station (playing, else the last one played) is inside one of its usual ad windows, 0 outside —
the learned schedule, minute by minute. Add Gladys' own **Chart** widget, type **Binary**, with
**Radio ad window** and **Radio ad break** (the real breaks): over 24 hours or a week, the bands
show when the ads usually come and when they actually came. The chart draws the past only; the
next window is in the Radio widget. Like the switch, it needs the device updated from Discovery,
and the detection on.

The **Ad-break report** button of the Configuration screen sums up every station learned the same
way, as text. Times are shown, and learned, in the **Time zone** of the configuration (Europe/Paris
by default): Gladys runs integrations in UTC.

**What it costs**, only while a station plays with the detection on:

- internet requests to TuneIn (once per station), Deezer (song lengths) and, for stations like
  OUI FM, their website (live song feed, hourly playlist history);
- with **Recognize the ad jingles** on: the radio stream is downloaded a second time and decoded
  (about 30 to 90 MB per hour, depending on the station's quality), and after each break a few
  seconds of processing, kept off the integration's main thread. Switch it off to save the
  bandwidth: breaks are then only caught by the windows rule.

Switched off, the detection costs nothing; only the song title of stations whose stream carries
none (OUI FM...) is still read from their website while they play. What is learned is kept in the
integration's data folder (`/data/ad-breaks.json`, `/data/ad-jingles/`).

## Prerequisites

- **Gladys 5.3.0 or newer** (music player; the integration's own widgets and scene
  actions/triggers). On an older version, Gladys keeps the last release of the integration that
  supports it (1.2.3).
- A Denon or Marantz AV receiver with a network (Ethernet/Wi-Fi) connection.
- **Network Standby** (sometimes labelled "ECO" standby) enabled in the receiver's setup menu.
  Without it, the receiver drops off the network entirely when powered off and Gladys cannot
  reach it (including to turn it back on).
- Gladys and the receiver on the same LAN/VLAN, with multicast allowed between them (needed for
  automatic discovery — see below).

## Configuration

1. Open the **Discovery** tab of the integration and run a scan. Denon/Marantz receivers answer
   automatically (SSDP/UPnP) — no IP to type, no account. The receiver should appear with its
   real name and model.
2. Add the discovered device. Gladys keeps a persistent connection to it from then on. If the
   receiver later gets a new IP address (DHCP), run a Discovery scan again and click **Update** on
   the device: the connection moves to the new address right away, no restart needed.
3. **If nothing is found**: your network likely blocks multicast between segments (VLANs, several
   network interfaces on the Gladys host, some mesh Wi-Fi setups...). Open the integration's
   **Configuration** tab and fill in the receiver's IP address manually, save, then scan again —
   it will show up as a fallback entry. Several receivers the scan can't reach (e.g. on different
   networks)? Enter their addresses separated by commas, e.g. `192.168.1.50, 192.168.2.50` — each
   one becomes its own fallback entry. A fixed IP or a DHCP reservation for every receiver is
   recommended in that case, since the manual entry does not track IP changes automatically.
4. Three actions are available from the Configuration screen for any AVR you added:
   - **Test connection** — queries the receiver and reports its current power/volume/mute/source
     (with its index, see "Source index" above)/sound mode.
   - **Select input** — pick an input from the standard list of Denon/Marantz source codes and
     switch to it.
   - **HEOS services and Qobuz: check** — the services HEOS sees (state, search) and what it
     shows of Qobuz on this receiver, see
     "Qobuz" above.
5. **Rename or hide sources on the dashboard dropdown** (Configuration tab, advanced): the
   dropdown shows generic codes like `SAT/CBL` or `GAME`, not what you actually plugged in. Fill
   in `CODE=Label` pairs separated by commas to rename them — e.g. `SAT/CBL=Chromecast` if that's
   what's on that input — or `CODE=` (nothing after the `=`) to remove an entry you never use,
   e.g. `SAT/CBL=Chromecast, GAME=`. After saving, run a Discovery scan again and click **Update**
   on the device — the dropdown's choices are part of the device's structure, so they don't
   refresh just because the configuration changed.
6. **Zone** (Configuration tab): which zone of a multi-zone receiver Gladys drives — **Main zone**
   by default, which is what you want in almost every case. Power, volume (and Volume up/down),
   mute, source (and Source index, Select input) all target that zone only, and only that zone's
   state is shown on the dashboard. A **"Speak on a speaker"** announcement first switches that
   zone on and to the network/HEOS input (`NET`), so it always plays there — never on whichever
   zone HEOS happened to use last. Pick **Zone 2**/**Zone 3** only to drive that zone instead
   (sound mode and the Setup-menu keys always act on the main zone, the only one with an on-screen
   menu). The change applies immediately, no need to re-add the device.
7. **Announcements** (Configuration tab): **Announcement volume** (0 = keep the current volume),
   **Delay after power on before an announcement (seconds)** (0 to 15, 4 by default: raise it if
   the start of a message from standby is cut off, since some receivers report being on before
   their audio output is ready; a value out of range or unreadable keeps the default) and
   **Restore the receiver after an announcement**, for the "Speak on a speaker" action — see
   "Play notification" above.
   **Music player** (Configuration tab): **Preferred music service for the search** (Automatic by
   default: Qobuz when signed in, else every service) — see "Gladys music player" above.
8. **Radio ad breaks** (Configuration tab): off by default, see "Radio ad breaks" above — then
   **Update** the device from Discovery to get its **Radio ad break** switch. **Time zone**: of
   the ad-break hours (an IANA name, Europe/Paris by default). **Ad-break report**: what was
   learned of every station.

## Troubleshooting

- **"The action failed" after several quick taps in a widget, then no button answers for a
  while**: a Gladys limit, not the receiver's. Gladys takes at most 30 widget taps a minute per
  integration, and reloads the widget content after each tap (at most 30 reloads a minute).
  Beyond that, every widget button of this integration is refused until the current minute ends
  (60 s at most), then everything comes back on its own. The reloads the integration asks for
  itself count too: since 1.2.1 a card is only reloaded for the device it shows, once per burst of
  changes, so a speaker playing music no longer uses up the taps of the amplifier's card. Since this version a Vol −/+ tap moves
  2 dB instead of 0.5 dB, so four times fewer taps for the same change; for a big change, prefer
  the volume slider of the Gladys "Devices" card: one setting instead of several taps.

- **The device badge** (device list) tells each receiver's state: _local_ = reachable;
  _unreachable_ = neither the Telnet control nor HEOS answers (receiver unplugged, network standby
  off, wrong IP); an **orange dot** flags a degraded mode, with the reason on hover — HEOS lists
  no player at the receiver's IP ("Speak on a speaker" will not work), or only HEOS answers on a
  receiver (port 23 closed or held by another controller, for at least three attempts; a
  recognized HEOS speaker has no orange dot, see "HEOS speakers"), or the receiver did not report
  its power back within 5 s after an on/off command, even when asked again after 2 s (the command
  is named; the dot goes away as soon as the receiver reports its power again).
- **On/Off does nothing**: look in the logs for `power on (device command) -> sent ...`. `ZMON`/
  `ZMOFF` on a stereo amplifier means it was not recognised as a receiver without zones: send the
  log lines that follow `connected (main zone)` and those with `DeviceZones` or `power mode`, and
  what `http://<ip>/goform/Deviceinfo.xml` (or port 8080) shows (or run
  `node scripts/debug-telnet.js <ip>` and type `ZM?` then `PW?`). "Test connection" also shows
  which power commands are used.

- **Receiver swapped for another at the same IP address** (for instance an AV receiver for a
  stereo amplifier): delete the device in Gladys and add it again from the Discovery tab. The
  "with zones" verdict kept for the old one does not carry over to the new one.
- **Nothing found by the scan**: check that Gladys and the receiver are on the same network
  segment and that multicast/UPnP is not filtered by your router or switches, then use the
  manual IP fallback (see above).
- **Discovered but commands don't apply / no feedback**: make sure Telnet (port 23) isn't
  disabled or firewalled on the receiver's network interface, and that no other controller is
  hogging the Telnet session in a way that blocks new ones (rare, but some models cap concurrent
  Telnet clients).
- **Receiver unreachable while powered off**: enable Network Standby / ECO standby in the
  receiver's setup menu (see Prerequisites).
- The integration logs everything it does: check the integration logs from the Gladys UI (or
  `docker logs` on the host). Note that Gladys itself has no way to set `LOG_LEVEL=debug` on an
  installed integration's container (it isn't one of the fixed environment variables Gladys sets,
  nor a config field) — that flag only applies when running this integration yourself outside
  Gladys (see "Run it locally" in the developer README). Every log line that actually matters for
  troubleshooting (a receiver connecting, a HEOS player id being matched, a "Speak on a speaker"
  stream being accepted or rejected...) is deliberately kept at `info` level or above for exactly
  this reason, so it shows up without `debug`; only the very verbose Telnet-line-by-line detail is
  `debug`-only and effectively out of reach from a normal Gladys install.
- **Sound mode, playback buttons or now-playing don't work as expected**: these rely on parts of
  the protocol that vary more across models/firmware than power/volume/mute/source. Compare what
  your remote actually sends against what this integration expects — since the raw line-by-line
  detail needed for that is `debug`-only (see above), use
  [`scripts/debug-telnet.js`](../scripts/debug-telnet.js)/
  [`scripts/debug-heos.js`](../scripts/debug-heos.js) directly against the receiver instead of the
  container logs.
- **Playback buttons still do nothing on Qobuz/Spotify Connect/TIDAL**: check the logs for
  a line mentioning "HEOS player id ... matched" shortly after the AVR connects — if it's not
  there, this receiver's HEOS CLI service (port 1255) wasn't reachable (firewall, older
  non-HEOS model, or HEOS momentarily not ready) and the integration silently fell back to the
  classic commands, which don't reach HEOS-managed sources.
- **"Speak on a speaker" doesn't show up in the speaker list at all**: the device was likely
  created before this feature shipped — open this integration's Discovery tab, scan, and click
  **Update** on the device (see "Re-publishing a device" under Discovery).
- **The scene runs with no error, but nothing plays on the Denon**: this is normal-looking on the
  Gladys side even on failure — a scene logs a failed action and reports as having run either way,
  it never surfaces an error to the user for this particular action. Check, in order:
  1. Run **Test connection** from this integration's Configuration screen: its reply now ends with
     a line like `HEOS: player id 12345 matched` or `HEOS: not connected`/`no player id matched`.
     Anything other than "player id ... matched" means HEOS itself is the problem — same
     requirement, same causes as the playback buttons above (firewalled port 1255, older non-HEOS
     model, or HEOS not ready yet after a restart).
  2. If HEOS is connected but reports **no player id matched**, check the logs for a line
     naming the IPs HEOS actually sees (`HEOS reports: ...`) — a receiver with more than one
     network interface (Ethernet + Wi-Fi) can advertise a different address to HEOS than the one
     this integration is using, which prevents the match forever.
  3. If a player id **is** matched, check the logs for the outcome of the stream itself: a
     line saying HEOS _rejected_ the stream (with an error code/text from the receiver) means the
     TTS URL wasn't playable as far as the receiver is concerned (unreachable from the receiver's
     own network, wrong format...). A line saying HEOS _accepted_ it and you still hear nothing
     should not happen any more (confirmed and fixed on real hardware: an earlier version
     percent-encoded the stream URL, which some receivers accept without complaint — result:
     success, a generic "Url Stream" placeholder even shows up as the current track — and then
     never actually fetch, so nothing plays no matter the input, power, volume, or mute state; see
     the developer README's "Speak on a speaker" section for the root cause). If it still happens
     on an up-to-date install, please report it.
