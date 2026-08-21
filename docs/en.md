# Denon / Marantz AVR

Control a Denon or Marantz AV receiver from Gladys: power, volume, mute and input source. Works
with the "AVR Control" protocol shared by (almost) the whole Denon/Marantz networked receiver
lineup — not tied to a specific model.

## Overview

The integration talks directly to your receiver over the local network (Telnet, TCP port 23) —
no cloud account, no internet dependency. The receiver itself pushes every state change
(power, volume, mute, source) as soon as it happens, whether triggered from Gladys, the
physical remote, or the Denon/HEOS app, so the dashboard stays in sync in real time.

Four things show up per receiver:

- **Power** — on/off, controllable.
- **Volume** — 0-100%, controllable (mapped from the receiver's internal -80 dB to +18 dB scale).
- **Mute** — on/off, controllable.
- **Source** — a dropdown of the receiver's input codes (e.g. `TUNER`, `BD`, `NET`), directly on
  the dashboard. The **Select input** action described below does the exact same thing and stays
  available as an alternative — useful if your Gladys instance is on an older version that
  doesn't render the dropdown yet.

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
   - **Test connection** — queries the receiver and reports its current power/volume/mute/source.
   - **Select input** — pick an input from the standard list of Denon/Marantz source codes and
     switch to it.

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
