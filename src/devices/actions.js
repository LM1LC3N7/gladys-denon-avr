// -----------------------------------------------------------------------------
// The manifest `actions` of the Configuration screen: "Test connection" and
// "Select input" (gladys.onAction in index.js).
// -----------------------------------------------------------------------------

import { buildSourceCommand, normalizeZone } from '../denon/protocol.js';
import { visibleSourceCodes } from './features.js';
import { getHeos, getState, getTelnet } from './registry.js';
import { initialQueries } from './session.js';

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

  return {
    en: `Zone: ${zone}. Power: ${power}, Volume: ${state.volume ?? '?'}%, Mute: ${mute}, Source: ${state.source ?? '?'} (index ${sourceIndexText}), Sound mode: ${state.sound_mode ?? '?'}. HEOS: ${heosStatusEn}.`,
    fr: `Zone : ${zone}. Alimentation : ${power}, Volume : ${state.volume ?? '?'}%, Muet : ${mute}, Source : ${state.source ?? '?'} (index ${sourceIndexText}), Mode sonore : ${state.sound_mode ?? '?'}. HEOS : ${heosStatusFr}.`,
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
