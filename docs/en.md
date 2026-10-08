# Denon / Marantz AVR

Control a Denon or Marantz AV receiver from Gladys: power, volume, mute and input source. Works
with the "AVR Control" protocol shared by (almost) the whole Denon/Marantz networked receiver
lineup — not tied to a specific model.

## Overview

The integration talks directly to your receiver over the local network (Telnet, TCP port 23) —
no cloud account, no internet dependency. The receiver itself pushes every state change
(power, volume, mute, source) as soon as it happens, whether triggered from Gladys, the
physical remote, or the Denon/HEOS app, so the dashboard stays in sync in real time.

These show up per receiver:

- **Power** — on/off, controllable. Only ever the **main zone** (or the zone picked in
  Configuration, see "Zone" below): turning the receiver on from Gladys can no longer wake it up
  on Zone 2, and turning it off no longer cuts a Zone 2 someone is listening to.
- **Volume** — 0-100%, controllable (mapped from the receiver's internal -80 dB to +18 dB scale).
  Confirmed on real hardware: one specific percent (25% on the default scale) can never stay put —
  setting it snaps to 26% instead. This is a genuine hardware limit (the receiver only has 99
  discrete volume steps for the 101 possible percent values), not a bug this integration can fix —
  and it only applies to this Telnet-based scale, not the HEOS fallback below. On a HEOS-equipped
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
  in that scene action has no effect here: Gladys does not forward it to this kind of integration
  (a core limitation, not something this integration can work around) — the announcement plays at
  the receiver's current volume. This is also one of the features here that works on a standalone
  HEOS speaker (Denon Home, HEOS 1/3/5/7, Bar...) added through the manual IP fallback in
  Configuration, not just a real AV receiver — alongside Volume, Mute and Play/Pause/Next/Previous
  (all of which have a real HEOS equivalent, see "HEOS support" below). Power, Source and Sound
  mode still need the Telnet-based "AVR Control" service those speakers don't have, so this
  integration is not full HEOS-speaker support — just the features that happen to have a HEOS
  equivalent already. Triggering this scene action repeatedly in quick succession replaces
  whatever is currently speaking rather than queuing behind it — the queue is cleared before every
  announcement, confirmed necessary on real hardware (without it, a burst of announcements played
  back one after another instead of just the last one).
- **Setup-menu remote control** — cursor Up/Down/Left/Right, Enter, Return, Info, Menu and
  relative Volume Up/Down, shown as clickable buttons directly in the device list (no extra
  dashboard box needed). Handy for navigating the receiver's on-screen Setup menu from Gladys
  instead of hunting for the physical remote. Don't want all of them cluttering a dashboard? Hide
  the ones you don't use the same way you'd hide any other device feature — nothing to configure
  on this integration's side.

## Automating source/sound mode from a scene

In a scene, the generic **"Control a device"** action is what sets `Source`/`Sound mode`/
`Source index` — there's no scene action for a manifest's own custom buttons (**Select input**
here), on any Gladys version.

- **On Gladys 4.86.1 or newer**, "Control a device" already shows a proper labeled dropdown for
  `Source` and `Sound mode`, exactly like the dashboard — just pick the device, then the feature,
  then the value. `Source index` still works too if you'd rather set a plain number.
- **On an older Gladys**, that dropdown either isn't offered or doesn't accept the value — use
  **Source index** instead: it's a plain number, which "Control a device" has always been able to
  set, and it maps to the same input as the dropdown (position in the _currently visible_ Source
  list, 0 = first entry).
- **If "Control a device" shows nothing at all for this AVR** (no `Source`/`Sound mode` dropdown,
  no `Source index` either): try a **hard refresh / clear your browser cache** first — confirmed
  once to be the actual cause, a stale cached front-end bundle showed a completely empty picker
  for this device while other integrations (MQTT, Zigbee2MQTT) still worked fine, fixed instantly
  by clearing the cache, no configuration change needed. Still nothing after that? The device was
  likely added before this integration shipped `Source index`, combined with a Gladys core older
  than 4.86.1 — open this integration's **Discovery** tab, run a scan, and click **Update** on the
  device, the same as any other structural change (see Configuration below).

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

## Radio ad breaks

While a radio station plays through HEOS (TuneIn, a favorite, a stream URL), the integration spots
its ad breaks and turns the device's **Ad break** state on during them. By default it also lowers
the volume by 20 steps, never below 20, then restores it when the music resumes. If you changed the volume by hand
meanwhile, your setting is kept. Everything is set in the "Radio ad breaks" section of the
configuration. To act in a scene of your own instead (switch station, mute…), switch off the
automatic volume drop and trigger your scene on the **Ad break** state.

**How it works.** No station says "this is an ad" in its stream. Many do say what song is playing,
sometimes with its length. When a song ends and no other follows, the station is either airing ads
or the host is talking, and the time of the hour tells the two apart. For each station, the
integration learns the minutes of the hour its breaks (4 to 8 minutes long) start at, e.g.
:09–:14 and :34–:47 on OUI FM:

- **inside one of these windows**, a song ending with ~45 s of no music afterwards counts as a
  break. That delay lets the host talk before the ad jingle;
- **outside them**, the volume never drops on a mere lack of music: a feature, the news or an
  interview are not ads. Only the station's ad jingle, once learned, can open a break there;
- the break ends when the next song starts, with a 10-minute safety limit.

The learning is continuous: while the station is followed, its playlist history is read again every
hour, and the windows come from the breaks of the last 3 days. A schedule change is picked up
within days.

**The ad jingle.** Each station opens its breaks with the same jingle (on OUI FM, "stay with us
during the ads"). While a station plays, the integration decodes its stream (ffmpeg) and compares
the sound of its breaks with each other. The sound found in most of them, even under the host's
voice, becomes the station's jingle. It is only observed at first, and becomes active after 2
detections followed by a real break. From then on the volume drops **at the jingle** instead of
after 45 s, and the host is no longer ducked. A break that comes without its jingle is still
caught by the windows rule. Expect a few hours of listening (3 long breaks), or 3
presses of **Mark ad break** right after the jingle. A jingle that starts giving false alarms is
forgotten and learned again.

**Where song changes come from:**

- **HEOS metadata**: for any station that provides it (e.g. Radio Paradise through TuneIn). Song
  lengths are looked up on Deezer.
- **A dedicated feed**: for stations whose stream carries none. That is the case of **OUI FM**,
  followed through the live feed of its own website (title, artist, exact length). The title then
  also shows in "Now playing", instead of just the station's name. Its ad windows are learned from the ~3
  days of playlist history the site publishes, as soon as the station is first played (also for
  Voltage, Alouette, Hit West and the other stations of the Les Indés Radios platform).
- **Nothing at all** (some TuneIn stations): press the **Mark ad break** button when the ads start,
  and again when they end. After a few marked breaks the integration knows the station's schedule
  and lowers the volume at those times on its own. This is less precise than with song changes,
  since it cannot tell when the music actually stops.

On a station with song changes, **Mark ad break** also fine-tunes the delay: press it at the ad
jingle and the integration learns the jingle itself and how long the host talks before the ads,
hour by hour. For
instance, OUI FM mornings have no host and the ads follow the song directly: two presses at those
hours are enough for the volume to drop right away then.

**Known limit**: the end of a break is only known when the next song starts. If the host talks
again after the ads, that stays at the lowered volume until the song.

## Prerequisites

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
2. Add the discovered device. Gladys keeps a persistent connection to it from then on.
3. **If nothing is found**: your network likely blocks multicast between segments (VLANs, several
   network interfaces on the Gladys host, some mesh Wi-Fi setups...). Open the integration's
   **Configuration** tab and fill in the receiver's IP address manually, save, then scan again —
   it will show up as a fallback entry. Several receivers the scan can't reach (e.g. on different
   networks)? Enter their addresses separated by commas, e.g. `192.168.1.50, 192.168.2.50` — each
   one becomes its own fallback entry. A fixed IP or a DHCP reservation for every receiver is
   recommended in that case, since the manual entry does not track IP changes automatically.
4. Two actions are available from the Configuration screen for any AVR you added:
   - **Test connection** — queries the receiver and reports its current power/volume/mute/source
     (with its index, see "Source index" above)/sound mode.
   - **Select input** — pick an input from the standard list of Denon/Marantz source codes and
     switch to it.
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

## Troubleshooting

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
