// -----------------------------------------------------------------------------
// HEOS-only speakers: a Denon Home, a HEOS 1/3/5/7, a HEOS Link/Amp/Drive...
// run the HEOS CLI (port 1255) but no "AVR Control" service at all: port 23
// is refused, for good (forum topic 10722, post 37, Denon Home 150).
//
// Such a device is driven over HEOS only: volume, mute, playback and "Speak
// on a speaker". HEOS CLI has no power, input or sound mode command, so
// these are not offered (Discovery) or refused with a clear message (a
// device added before), never sent over a Telnet that will never answer.
//
// A receiver whose Telnet ever came up in the session is never HEOS-only:
// an AVR keeps every feature whatever HEOS says.
// -----------------------------------------------------------------------------

// Refused Telnet attempts before an unknown model, with HEOS matched, is
// taken for a HEOS-only speaker (a receiver waking up refuses for a few
// seconds at most; the backoff makes 3 attempts about a minute).
export const HEOS_ONLY_REFUSALS = 3;

// How often Telnet is retried on a HEOS-only speaker: it may come back (a
// firmware that adds it, a wrong guess), but rarely enough to stay quiet.
export const HEOS_ONLY_TELNET_RETRY_MS = 5 * 60_000;

/**
 * Whether a model name (SSDP modelName, HEOS get_players `model`) is a
 * HEOS speaker with no AVR Control: "Denon Home 150", "HEOS 1", "HEOS Link",
 * "HEOS Bar". An AV receiver ("HEOS AVR", "AVR-X2700H", "SR6015",
 * "PM7000N") never matches. Pure.
 */
export function isHeosOnlyModel(model) {
  if (typeof model !== 'string') {
    return false;
  }
  const name = model.trim();
  if (/avr|receiver|\b(sr|nr|av|pm|cinema)\s?\d/i.test(name)) {
    return false;
  }
  return /\bdenon home\b/i.test(name) || /(^|[\s(])heos\b/i.test(name);
}

/**
 * Whether one device is driven as a HEOS-only speaker. Pure.
 *
 * @param {object} facts
 * @param {boolean} facts.telnetEverUp Telnet came up at least once this session
 * @param {number} facts.refusals consecutive refused Telnet attempts (ECONNREFUSED)
 * @param {boolean} facts.heosMatched HEOS answers and lists a player at this IP
 * @param {string|null} [facts.model] the model HEOS reports for that player
 */
export function decideHeosOnly({ telnetEverUp, refusals, heosMatched, model }) {
  if (telnetEverUp || !heosMatched || refusals < 1) {
    return false;
  }
  if (typeof model === 'string' && model.trim() !== '') {
    // A known AVR model with port 23 refused stays an AVR (Telnet off or
    // held by another controller): the badge says what still works.
    return isHeosOnlyModel(model);
  }
  return refusals >= HEOS_ONLY_REFUSALS;
}
