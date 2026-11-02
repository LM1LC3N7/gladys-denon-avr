// -----------------------------------------------------------------------------
// Coalesced widget refresh nudges. gladys.requestWidgetRefresh(key) asks
// Gladys to drop its cached content and re-pull it, but the core keeps at
// most 1 nudge per 10 s per widget key and silently drops the others — and a
// receiver pushes several lines per change (input, then sound mode, then
// volume…). Every nudge also costs a content pull, and the core allows 30
// pulls a minute per integration, widget actions' own re-pulls included
// (forum topic 10722, post 39: "L'action a échoué"). So a nudge waits a
// short settle time to carry the whole burst of lines, and the later ones of
// a window collapse into a single trailing nudge right after the window: the
// card always ends on the last state, without losing a nudge to the limit.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'widgets' });

// The core's window, plus a margin for the two clocks.
const DEFAULT_MIN_INTERVAL_MS = 10_500;
// Lines of one change arrive within a few tens of ms (Telnet) to a few
// hundred (HEOS now-playing: event, then the media query).
const DEFAULT_SETTLE_MS = 400;

export function createRefresher(
  request,
  { minIntervalMs = DEFAULT_MIN_INTERVAL_MS, settleMs = DEFAULT_SETTLE_MS } = {},
) {
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
      const wait = Math.max(
        settleMs,
        (lastSent.get(key) ?? -Infinity) + minIntervalMs - Date.now(),
      );
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
