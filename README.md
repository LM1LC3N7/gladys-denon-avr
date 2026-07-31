# gladys-denon-avr

External integration for [Gladys Assistant](https://gladysassistant.com) to control a Denon or
Marantz AV receiver: power, volume, mute and input source. Built on the JavaScript SDK
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js), from
the official [`integration-template-js`](https://github.com/GladysAssistant/integration-template-js).

Talks the "AVR Control" protocol shared by (almost) the whole Denon/Marantz networked receiver
lineup (Telnet, TCP port 23) — not hardcoded to a specific model.

## What it does

- **Discovery**: SSDP/UPnP, mediated by the Gladys core (`network_discovery: ["ssdp"]` in the
  manifest) — receivers are found automatically on the LAN, whether powered on or in standby
  (Network Standby required). A manual IP fallback is available in the Configuration screen for
  networks that block multicast.
- **Power / Volume / Mute**: controllable features (`TELEVISION` category), fed in real time by
  the Telnet session the receiver itself pushes state changes to — no polling.
- **Input source**: a read-only status feature (shows the exact code the receiver reports) plus
  a **Select input** manifest action with the standard Denon/Marantz source codes, since the
  Gladys front-end's rendering of a generic `TELEVISION.SOURCE` control isn't reliable enough
  yet to be the only path (see the design notes in
  [`src/devices/avr.js`](./src/devices/avr.js)).
- **Test connection** action: on-demand query + a summary of the receiver's current state.

## New to this codebase? Start here

An "external integration" is just a small Node.js program that Gladys (the home automation
hub) runs as its own **Docker container**, next to the main Gladys server. The two only ever
talk over **one WebSocket connection**, opened by the SDK
([`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js)) —
you never touch that connection directly, you just react to the events it emits (`onScanRequest`,
`onSetValue`, `onDeviceCreated`...) and call its methods (`publishState`, `getConfig`...).

This integration then opens a **second, completely separate connection**: a plain TCP/Telnet
socket (port 23) straight to the AV receiver on the local network. That's the actual point of
the project — everything in `src/denon/` and `src/devices/avr.js` exists to manage that second
connection and translate between "what the receiver says" and "what Gladys understands".

```
┌────────────┐   WebSocket (SDK, handled for you)   ┌──────────────────────┐   Telnet :23   ┌──────────┐
│ Gladys hub │ ───────────────────────────────────▶ │  This integration    │ ─────────────▶ │ Denon/   │
│ (the app)  │ ◀─────────────────────────────────── │  (this repo, in a    │ ◀───────────── │ Marantz  │
└────────────┘   events / commands / config          │  Docker container)   │   plain-text    │ AVR      │
                                                       └──────────────────────┘   lines         └──────────┘
```

Recommended reading order, each file assumes only the one(s) before it:

1. [`src/denon/protocol.js`](./src/denon/protocol.js) — no dependencies, no I/O: just
   string-in/string-out functions that translate a Telnet line to a Gladys value and back. Read
   this first to understand the receiver's language.
2. [`src/denon/telnet.js`](./src/denon/telnet.js) — opens the actual TCP socket, splits the
   incoming stream into lines, and reconnects automatically if the connection drops. Knows
   nothing about Denon's protocol or about Gladys.
3. [`src/denon/discovery.js`](./src/denon/discovery.js) — how a receiver is found on the LAN
   before you even have its IP address (SSDP/UPnP).
4. [`src/devices/avr.js`](./src/devices/avr.js) — the glue: keeps one Telnet client per AVR the
   user added, and wires `protocol.js` + `telnet.js` to what the SDK expects (features, actions).
5. [`src/devices/index.js`](./src/devices/index.js) and [`src/config.js`](./src/config.js) —
   small composition/config-normalization helpers used by the entry point.
6. [`index.js`](./index.js) — the entry point. On purpose the shortest, least interesting file:
   it only creates the SDK client and wires its events to the functions above.

## Dependencies

This project intentionally has a **single runtime dependency**:

| Package                                                                                              | Role                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@gladysassistant/integration-sdk`](https://www.npmjs.com/package/@gladysassistant/integration-sdk) | Everything about talking to the Gladys hub: authentication, the WebSocket connection and its reconnection, and the event/method API used in `index.js` (`onScanRequest`, `publishState`, ...). |

Everything else needed at runtime is a Node.js built-in, on purpose (fewer dependencies = fewer
things that can break or need updating): `node:net` for the Telnet socket
([`src/denon/telnet.js`](./src/denon/telnet.js)) and the global `fetch` for reading a receiver's
UPnP description ([`src/denon/discovery.js`](./src/denon/discovery.js)).

Dev-only dependencies (never shipped in the Docker image, see the `Dockerfile`'s
`npm ci --omit=dev`):

| Package                                                        | Role                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `eslint` + `@eslint/js` + `eslint-config-prettier` + `globals` | Linting (`npm run lint`) — catches real bugs (undefined vars, dead code...). |
| `prettier`                                                     | Code formatting (`npm run format` / `format:check`) — no style debates.      |

Testing uses no library at all: `npm test` runs Node's own built-in test runner (`node --test`,
requires no dependency), see `test/` and the "Quality checks" section below.

## Project structure

```
.
├─ index.js                          # SDK bootstrap + event wiring (no protocol logic)
├─ src/
│  ├─ devices/
│  │  ├─ avr.js                      # discovery payloads, Telnet connection registry, onSetValue, actions
│  │  └─ index.js                    # composes SSDP discovery + the manual host fallback
│  ├─ denon/
│  │  ├─ protocol.js                 # PURE: parse Telnet lines <-> feature values, build commands
│  │  ├─ telnet.js                   # raw net.Socket client: line framing, reconnect w/ backoff
│  │  └─ discovery.js                # SSDP scan + UPnP description.xml parsing
│  └─ config.js                      # config defaults + normalization
├─ test/                             # one *.test.js per src/ file above, node --test, no library
│  └─ helpers/fakeGladys.js          # minimal in-memory stand-in for the SDK client, used by tests
├─ docs/
│  └─ en.md / fr.md                  # END-USER documentation, re-hosted by Gladys itself in its
│                                     # UI (not this README) — what someone installing the
│                                     # integration from the Gladys store reads, not a developer
├─ gladys-assistant-integration.json # the "manifest": declares the integration to the Gladys
│                                     # store/hub (name, version, Docker image, the config form
│                                     # and actions you see in the Configuration screen)
├─ Dockerfile                        # packages index.js + src/ into the image Gladys runs,
│                                     # Node 24 Alpine, prod dependencies only
└─ cover.png                         # catalog cover, 800×534 px, ≤150 KB
```

## Run it locally

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="denon-avr" \
LOG_LEVEL=debug \
npm start
```

## Quality checks

```bash
npm run format:check   # Prettier
npm run format          # Prettier, write
npm run lint             # ESLint
npm test                 # node --test
```

`protocol.js` and `telnet.js`/`discovery.js` are unit-tested without a real receiver: pure
parsing/building functions, a local fake Telnet server (`net.createServer`), and a mocked
`fetch`/`scanNetwork`. See [`test/`](./test).

## Validate before publishing

```bash
npx github:GladysAssistant/integration-store .
```

## Publish

Add the GitHub topic `gladys-assistant-integration`, then **Actions → Release → Run workflow**
(bumps `package.json` + the manifest, tags, builds the multi-arch image). See the
[integration-template-js README](https://github.com/GladysAssistant/integration-template-js) for
the full publishing flow — unchanged from the template.

## v1 scope

Power, volume, mute, input source (status + selection), SSDP discovery. Deliberately out of
scope for now: sound/surround mode, multi-zone, HEOS "now playing" metadata, and an HTTP
fallback control channel — see the design notes at the top of
[`src/devices/avr.js`](./src/devices/avr.js) and [`src/denon/discovery.js`](./src/denon/discovery.js).

## License

Apache-2.0
