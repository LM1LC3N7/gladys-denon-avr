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

- **Power** — on/off, controllable.
- **Volume** — 0-100%, controllable (mapped from the receiver's internal -80 dB to +18 dB scale).
- **Mute** — on/off, controllable.
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
  no `Source index` either): this most likely means the device was added before this integration
  shipped `Source index`, combined with a Gladys core older than 4.86.1. Open this integration's
  **Discovery** tab, run a scan, and click **Update** on the device — a new feature never appears
  on an already-added device on its own, the same as any other structural change (see
  Configuration below).

## HEOS support

Denon/Marantz receivers with a HEOS module (most current network models) run HEOS as a separate
service alongside the classic Telnet control used for everything else on this page. Streaming
sources like Qobuz, Spotify Connect, TIDAL or TuneIn are actually played back _through_ HEOS —
the classic transport commands this integration used before have no effect on them at all.

Starting with this version, the Play/Pause/Next/Previous buttons talk to HEOS automatically when
the receiver supports it: no configuration needed, nothing to turn on. If HEOS isn't reachable
(no HEOS module, or its network port is blocked), the buttons transparently fall back to the
classic commands, which still work for the receiver's own non-HEOS Net/USB sources.

Once HEOS is confirmed for your receiver, it also becomes the source for the playback state and
the "Now playing" title/artist — refreshed both when HEOS pushes a change and on a background
check every 30 seconds, so the dashboard catches up on its own within half a minute even if a
push notification is missed (this can happen if the HEOS connection drops briefly, which is a
known HEOS behavior on an idle connection).

**Limits**: this is implemented from HEOS's own (unofficial, but widely used) network protocol,
cross-checked against the library behind Home Assistant's official HEOS integration — not tested
by the developer against a live HEOS streaming session, since that requires an actual paid
streaming account. If the buttons don't do anything on your setup even though the receiver is
reachable, please report it (with the debug logs mentioned below) so it can be fixed.

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
  `docker logs` on the host) with `LOG_LEVEL=debug` for the full detail, including every Telnet
  line sent and received.
- **Sound mode, playback buttons or now-playing don't work as expected**: these rely on parts of
  the protocol that vary more across models/firmware than power/volume/mute/source. Compare what
  your remote actually sends against what this integration expects using the debug logs above.
- **Playback buttons still do nothing on Qobuz/Spotify Connect/TIDAL**: check the debug logs for
  a line mentioning "HEOS player id ... matched" shortly after the AVR connects — if it's not
  there, this receiver's HEOS CLI service (port 1255) wasn't reachable (firewall, older
  non-HEOS model, or HEOS momentarily not ready) and the integration silently fell back to the
  classic commands, which don't reach HEOS-managed sources.
