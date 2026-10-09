// -----------------------------------------------------------------------------
// In-memory stand-ins for one AVR's sessions, injected through the
// registry's test hooks (src/devices/registry.js) so the controls, the
// announcements, the scene actions and the widgets can be tested without a
// socket.
// -----------------------------------------------------------------------------

/** A legacy Telnet client: records every command sent while "connected". */
export function createFakeTelnetClient() {
  const sent = [];
  let connected = true;
  return {
    sent,
    send(command) {
      if (!connected) {
        return false;
      }
      sent.push(command);
      return true;
    },
    isConnected: () => connected,
    stop: () => {
      connected = false;
    },
    setConnected(value) {
      connected = value;
    },
  };
}

/** A matched HEOS session (`{ pid, client }`): records every `heos://` path sent. */
export function createFakeHeosSession(pid = 12345) {
  const sent = [];
  let connected = true;
  return {
    pid,
    sent,
    client: {
      sendCommand(commandPath) {
        if (!connected) {
          return false;
        }
        sent.push(commandPath);
        return true;
      },
      isConnected: () => connected,
    },
    setConnected(value) {
      connected = value;
    },
    forget() {},
  };
}
