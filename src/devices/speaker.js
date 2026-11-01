// -----------------------------------------------------------------------------
// HEOS-only speakers: a Denon Home (forum topic 10722, post 37, Denon Home
// 150: port 23 refused, for good), a HEOS 1/3/5/7... run the HEOS CLI (port
// 1255) but no "AVR Control" service. Which other "HEOS ..." models lack
// Telnet is not verified: a model that does answer on port 23 is never
// treated as a speaker anyway (telnetEverUp below).
//
// Such a device is driven over HEOS only: volume, mute, playback and "Speak
// on a speaker". HEOS CLI has no power, input or sound mode command, so
// these are not offered (Discovery) or refused with a clear message (a
// device added before), never sent over a Telnet that will never answer.
//
// A receiver whose Telnet ever came up in the session is never HEOS-only:
// an AVR keeps every feature whatever HEOS says.
// -----------------------------------------------------------------------------

// How often Telnet is retried on a HEOS-only speaker: it may come back (a
// firmware that adds it), but rarely enough to stay quiet. Read from
// `timing.heosOnlyTelnetRetryMs` (./registry.js), 5 min.

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
 * Only on a model KNOWN to be a speaker (review r1, I3): a receiver whose
 * HEOS model is missing or unreadable, with port 23 refused for a while
 * (restarting, Telnet held elsewhere), stays a receiver — its power, inputs
 * and Zone 2 are never taken away on a guess; the badge says that only HEOS
 * answers, and Telnet keeps its usual backoff.
 *
 * @param {object} facts
 * @param {boolean} facts.telnetEverUp Telnet came up at least once this session
 * @param {boolean} facts.refused the last Telnet attempt was actively refused (ECONNREFUSED)
 * @param {boolean} facts.heosMatched HEOS answers and lists a player at this IP
 * @param {string|null} [facts.model] the model HEOS (or SSDP) reports for that player
 */
export function decideHeosOnly({ telnetEverUp, refused, heosMatched, model }) {
  if (telnetEverUp || !heosMatched || !refused) {
    return false;
  }
  return isHeosOnlyModel(model);
}
