// -----------------------------------------------------------------------------
// The manifest `actions` of the Configuration screen: "Test connection",
// "Select input", "Ad-break report" and "Qobuz: check" (gladys.onAction in
// index.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { adBreakReport } from '../adbreak/index.js';
import { reportText } from '../adbreak/insights.js';
import { POWER_MODE, ZONE, buildSourceCommand, normalizeZone } from '../denon/protocol.js';
import { visibleSourceCodes } from './features.js';
import { getHeos, getState, getTelnet } from './registry.js';
import { initialQueries } from './session.js';
import { describePowerMode, getPowerMode } from './power.js';
import { QobuzUnavailableError, listQobuzPlaylists } from './qobuz.js';

const logger = createLogger({ name: 'avr' });

// The French twin of describePowerMode() (./power.js), for "Test connection".
const POWER_MODE_FR = {
  [POWER_MODE.UNKNOWN]: 'zones pas encore détectées : ZMON/ZMOFF',
  [POWER_MODE.ZONE]: 'ampli à zones : ZMON/ZMOFF',
  [POWER_MODE.SYSTEM]: 'ampli sans zones : PWON/PWSTANDBY',
};

// Playlist names shown by "Qobuz: check" (the rest is counted).
const SHOWN_PLAYLISTS = 30;

/**
 * `test_connection` manifest action: query the device and report its last
 * known state. `config` is optional (same rationale as onSetValue() in ./commands.js)
 * so the source index line is simply omitted for a caller that doesn't pass
 * it.
 */
export async function runTestConnectionAction(gladys, { fields, config }) {
  const externalId = fields.device;
  const telnet = getTelnet(externalId);
  if (!telnet || !telnet.isConnected()) {
    return {
      en: 'Not connected to this AVR. Check the host/network and the integration logs.',
      fr: "Pas de connexion à cet ampli. Vérifiez l'hôte/le réseau et les logs de l'intégration.",
    };
  }

  const zone = normalizeZone(config?.zone);
  for (const query of initialQueries(zone)) {
    telnet.send(query);
  }
  // Bounded pause: the replies are asynchronous pushed lines, not a
  // request/response pair — give them a moment to land before reading the
  // (fresh-by-then) cache back.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const state = getState(externalId);
  const power = state.power === 1 ? 'ON' : state.power === 0 ? 'STANDBY' : '?';
  const mute = state.mute === 1 ? 'ON' : state.mute === 0 ? 'OFF' : '?';
  // Same visible-list computation as buildFeatures()/onSetValue() — reports
  // "?" rather than a wrong number when the current source isn't in it
  // (hidden by source_overrides, or not yet known).
  const sourceIndex = visibleSourceCodes(config?.sourceOverrides).findIndex(
    (code) => code.value === state.source,
  );
  const sourceIndexText = sourceIndex === -1 ? '?' : sourceIndex;

  // Surfaced here specifically so a user whose "Speak on a speaker"/playback
  // buttons silently do nothing has one place to check without digging
  // through debug logs: those features require a matched HEOS player id
  // (see FEATURE.PLAY_NOTIFICATION/onSetValue()), and a scene swallows a
  // failed action without showing an error, so this line is often the only
  // visible confirmation of whether HEOS actually works for this receiver.
  const heos = getHeos(externalId);
  const heosStatusEn =
    heos?.pid != null
      ? `player id ${heos.pid} matched${heos.client?.isConnected() ? '' : ', but currently disconnected'}`
      : heos?.client?.isConnected()
        ? 'connected, but no player id matched — Speak on a speaker will not work on this receiver'
        : 'not connected (no HEOS module, unreachable, or not confirmed yet)';
  const heosStatusFr =
    heos?.pid != null
      ? `identifiant lecteur ${heos.pid} trouvé${heos.client?.isConnected() ? '' : ', mais actuellement déconnecté'}`
      : heos?.client?.isConnected()
        ? 'connecté, mais aucun identifiant lecteur trouvé — Parler sur une enceinte ne fonctionnera pas sur cet ampli'
        : 'non connecté (pas de module HEOS, injoignable, ou pas encore confirmé)';

  // Which power commands the main zone gets (./power.js); a secondary zone
  // always gets its own Z2/Z3 ones.
  const isMain = zone === ZONE.MAIN;
  const powerModeEn = isMain ? ` (${describePowerMode(externalId)})` : '';
  const powerModeFr = isMain ? ` (${POWER_MODE_FR[getPowerMode(externalId)]})` : '';

  return {
    en: `Zone: ${zone}. Power: ${power}${powerModeEn}, Volume: ${state.volume ?? '?'}%, Mute: ${mute}, Source: ${state.source ?? '?'} (index ${sourceIndexText}), Sound mode: ${state.sound_mode ?? '?'}. HEOS: ${heosStatusEn}.`,
    fr: `Zone : ${zone}. Alimentation : ${power}${powerModeFr}, Volume : ${state.volume ?? '?'}%, Muet : ${mute}, Source : ${state.source ?? '?'} (index ${sourceIndexText}), Mode sonore : ${state.sound_mode ?? '?'}. HEOS : ${heosStatusFr}.`,
  };
}

/** `select_source` manifest action: switch the receiver's input. */
export async function runSelectSourceAction(gladys, { fields, config }) {
  const telnet = getTelnet(fields.device);
  if (!telnet || !telnet.isConnected()) {
    throw new Error('This AVR is not connected');
  }
  if (!telnet.send(buildSourceCommand(fields.source, normalizeZone(config?.zone)))) {
    throw new Error('Failed to send the source command');
  }
  return {
    en: `Source command sent: ${fields.source}.`,
    fr: `Commande source envoyée : ${fields.source}.`,
  };
}

/**
 * "Ad-break report" manifest action: what the radio ad-break detection
 * learned of every station (src/adbreak/insights.js), as text.
 */
export async function runAdBreakReportAction() {
  const stations = await adBreakReport();
  return { en: reportText(stations, 'en'), fr: reportText(stations, 'fr') };
}

/**
 * "Qobuz: check" manifest action: what HEOS shows of Qobuz on one receiver
 * (the source, the first level of its tree, the playlists found), as text
 * and as one log line. Built without a receiver showing Qobuz: this is what
 * a user reports to fix the lookup rules of src/heos/qobuz.js.
 */
export async function runQobuzCheckAction({ fields }) {
  const externalId = fields.device;
  let result;
  try {
    result = await listQobuzPlaylists(externalId, { refresh: true });
  } catch (err) {
    logger.warn(`${externalId}: Qobuz check failed: ${err.message}`);
    if (err instanceof QobuzUnavailableError && err.reason === 'missing') {
      const seen = err.sources.join(', ') || '-';
      return {
        en: `HEOS lists no Qobuz source on this receiver (sources seen: ${seen}). Add Qobuz in the HEOS app (Music services, Add more music), then restart the integration: HEOS only shows a newly added service to a new connection.`,
        fr: `HEOS ne liste pas de source Qobuz sur cet ampli (sources vues : ${seen}). Ajoutez Qobuz dans l'application HEOS (Services de musique, Ajouter des services), puis redémarrez l'intégration : HEOS ne montre un service ajouté qu'à une nouvelle connexion.`,
      };
    }
    if (err instanceof QobuzUnavailableError) {
      return {
        en: 'HEOS lists Qobuz, but no Qobuz account is signed in: sign in to Qobuz in the HEOS app, then try again.',
        fr: "HEOS liste Qobuz, mais aucun compte Qobuz n'y est connecté : connectez-vous à Qobuz dans l'application HEOS, puis réessayez.",
      };
    }
    return {
      en: `Qobuz could not be read through HEOS: ${err.message}`,
      fr: `Impossible de lire Qobuz via HEOS : ${err.message}`,
    };
  }
  const { source, topLevel, opened, playlists } = result;
  const names = playlists.slice(0, SHOWN_PLAYLISTS).map((item) => item.name);
  const more = playlists.length - names.length;
  const list = names.join(', ') + (more > 0 ? ` (+${more})` : '');
  logger.info(
    `${externalId}: Qobuz check: source ${source.sid} "${source.name}", top level [${topLevel.join(' | ')}], opened [${opened.join(' | ')}], ${playlists.length} playlists`,
  );
  return {
    en: `Qobuz found (HEOS source ${source.sid}). First level: ${topLevel.join(', ') || '-'}. ${playlists.length} playlists${playlists.length ? `: ${list}` : ' found: tell the integration author which entry above holds them'}.`,
    fr: `Qobuz trouvé (source HEOS ${source.sid}). Premier niveau : ${topLevel.join(', ') || '-'}. ${playlists.length} playlists${playlists.length ? ` : ${list}` : " trouvées : indiquez à l'auteur de l'intégration quelle entrée ci-dessus les contient"}.`,
  };
}
