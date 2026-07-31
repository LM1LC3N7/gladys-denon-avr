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
├─ docs/
│  ├─ en.md / fr.md                  # user documentation (re-hosted by Gladys)
├─ gladys-assistant-integration.json # manifest
├─ Dockerfile                        # Node 24 Alpine
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
