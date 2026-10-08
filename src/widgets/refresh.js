// -----------------------------------------------------------------------------
// Coalesced widget refresh nudges. gladys.requestWidgetRefresh(key) asks
// Gladys to drop its cached content and re-pull it, but the core keeps at
// most 1 nudge per 10 s per widget key and silently drops the others — and a
// receiver pushes several lines per change (input, then sound mode, then
// volume…). So the first nudge of a window goes out at once and the later
// ones collapse into a single trailing nudge right after the window: the
// card always ends on the last state, without losing a nudge to the limit.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'widgets' });

// The core's window, plus a margin for the two clocks.
const DEFAULT_MIN_INTERVAL_MS = 10_500;

export function createRefresher(request, { minIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
  const lastSent = new Map();
  const timers = new Map();

  function send(key) {
    lastSent.set(key, Date.now());
    try {
      request(key);
    } catch (err) {
      logger.warn(`Widget refresh of ${key} failed: ${err.message}`);
    }
  }

  return {
    request(key) {
      if (timers.has(key)) {
        return; // A trailing nudge is already scheduled: it will carry this change.
      }
      const wait = (lastSent.get(key) ?? -Infinity) + minIntervalMs - Date.now();
      if (wait <= 0) {
        send(key);
        return;
      }
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          send(key);
        }, wait),
      );
    },
    stop() {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    },
  };
}
