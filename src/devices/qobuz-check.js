// -----------------------------------------------------------------------------
// What the "Qobuz: check" button logs: the raw structure HEOS shows of Qobuz
// on one receiver (sources, first level and its options, the containers
// opened for the playlists, the search criteria, and — with an artist — the
// artist search, the artist container and what "latest album" and "artist"
// would play, without playing anything). Written without a receiver showing
// Qobuz: this is what a user sends back to replace the guesses of
// src/heos/qobuz.js with the real names.
//
// Never logged: the account name HEOS lists (`service_username`, hidden
// wherever it appears) and the image URLs (only whether there is one).
// Every step is caught: one failing step is logged and the next one runs.
// -----------------------------------------------------------------------------

import { buildGetMusicSourcesCommand, buildSearchCommand } from '../heos/protocol.js';
import {
  accountNames,
  browseItems,
  criteriaOf,
  describeItem,
  parseOptions,
  pickByName,
  redact,
  sourceSummaries,
} from '../heos/qobuz.js';
import { HEOS_SOURCES, isBrowsable, isSpotify } from '../heos/services.js';
import { requireHeos } from './control.js';
import {
  browsePage,
  heosSources,
  resolveArtist,
  resolveLatestAlbum,
  searchCriteria,
  searchKind,
} from './qobuz.js';

/**
 * Every source HEOS lists on one receiver, with its state and its search
 * criteria: `{ en, fr, lines }` — two short texts for the answer, and the
 * log lines (no account name). Never throws: a failure is the answer.
 */
export async function servicesReport(externalId) {
  let sources;
  try {
    const heos = requireHeos(externalId, 'check the HEOS services');
    sources = await heosSources(externalId, { refresh: true });
    const entries = [];
    for (const source of sources.list) {
      const entry = { sid: source.sid, name: source.name, available: source.available };
      if (isSpotify(source)) {
        entry.note = 'spotify_connect';
      } else if (source.available && isBrowsable(source) && source.sid < HEOS_SOURCES.LOCAL) {
        try {
          const criteria = await searchCriteria(externalId, heos, source.sid, { refresh: true });
          entry.search = criteria.map((item) => String(item?.name ?? '?'));
        } catch (err) {
          entry.search = [];
          entry.searchError = err.message;
        }
      }
      entries.push(entry);
    }
    const describe = (entry, fr) => {
      const state = entry.available
        ? fr
          ? 'connecté'
          : 'signed in'
        : fr
          ? 'non connecté'
          : 'not signed in';
      if (entry.note) {
        return `${entry.name} (${fr ? 'Spotify Connect seulement, pas de catalogue' : 'Spotify Connect only, no catalog'})`;
      }
      if (!entry.search) {
        return `${entry.name} (${state})`;
      }
      let search = fr ? 'pas de recherche' : 'no search';
      if (entry.search.length) {
        search = fr ? `recherche : ${entry.search.join('/')}` : `search: ${entry.search.join('/')}`;
      }
      return `${entry.name} (${state}, ${search})`;
    };
    return {
      en: `HEOS services: ${entries.map((entry) => describe(entry, false)).join(', ') || '-'}.`,
      fr: `Services HEOS : ${entries.map((entry) => describe(entry, true)).join(', ') || '-'}.`,
      lines: [clip(redact(`services: ${JSON.stringify(entries)}`, sources.hidden))],
    };
  } catch (err) {
    const message = redact(err.message, sources?.hidden ?? []);
    return {
      en: `HEOS services could not be read: ${message}.`,
      fr: `Impossible de lire les services HEOS : ${message}.`,
      lines: [clip(`services failed: ${message}`)],
    };
  }
}

// Items described per list, and the longest log line.
const SHOWN_ITEMS = 30;
const MAX_LINE = 4000;

const clip = (text) => (text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text);

/**
 * Run the diagnostics of one receiver: `{ lines, artist }` — `lines` the
 * log lines (already free of account names), `artist` the summary of the
 * artist test (`{ name, latest, latestMethod, playMethod, error }`) or null.
 */
export async function qobuzDiagnostics(
  externalId,
  { sid, opened = [], artist = '', hidden: known = [] },
) {
  const heos = requireHeos(externalId, 'check Qobuz');
  const lines = [];
  // The account names already known (the source lookup): hidden even when
  // the sources step below fails.
  let hidden = [...known];
  const log = (label, value) =>
    lines.push(clip(redact(`${label}: ${JSON.stringify(value)}`, hidden)));
  const step = async (label, run) => {
    try {
      await run();
    } catch (err) {
      lines.push(clip(redact(`${label} failed: ${err.message}`, hidden)));
    }
  };
  const describe = (raw) => raw.slice(0, SHOWN_ITEMS).map((item) => describeItem(item, hidden));

  await step('sources', async () => {
    const answer = await heos.request(buildGetMusicSourcesCommand());
    hidden = [...new Set([...known, ...accountNames(answer.payload)])];
    log('sources', sourceSummaries(answer.payload));
  });

  await step('first level', async () => {
    const page = await browsePage(heos, sid, null);
    log('first level options', page.options);
    log(`first level (${page.raw.length} items)`, describe(page.raw));
    for (const name of opened.slice(0, 2)) {
      const container = page.items.find((item) => item.name === name);
      if (container?.cid) {
        const inner = await browsePage(heos, sid, container.cid, 0, 50);
        log(`"${name}" options`, inner.options);
        log(`"${name}" (${inner.raw.length} items, count ${inner.count})`, describe(inner.raw));
      }
    }
  });

  await step('search criteria', async () => {
    log('search criteria', await searchCriteria(externalId, heos, sid, { refresh: true }));
  });

  const wanted = String(artist ?? '').trim();
  if (!wanted) {
    return { lines, artist: null };
  }
  const summary = { name: wanted, latest: '', latestMethod: '', playMethod: '', error: '' };
  await step(`artist search "${wanted}"`, async () => {
    const criteria = criteriaOf(await searchCriteria(externalId, heos, sid), 'artist');
    if (!criteria) {
      lines.push('artist search: no "Artist" search criteria');
      return;
    }
    const answer = await heos.request(buildSearchCommand(sid, criteria.scid, wanted, [0, 9]));
    const raw = Array.isArray(answer.payload) ? answer.payload : [];
    log(`artist search "${wanted}" (${raw.length} items)`, describe(raw));
    log('artist search options', parseOptions(answer.options));
    const found = pickByName(
      browseItems(raw).filter((item) => item.container && item.cid !== null),
      wanted,
    );
    if (found) {
      const page = await browsePage(heos, sid, found.cid, 0, 50);
      log(`artist "${found.name}" options`, page.options);
      log(
        `artist "${found.name}" (${page.raw.length} items, count ${page.count})`,
        describe(page.raw),
      );
    }
  });
  await step(`album search "${wanted}"`, async () => {
    const { items } = await searchKind(externalId, heos, sid, 'album', wanted, { limit: 10 });
    log(
      `album search "${wanted}"`,
      items.map((item) => ({
        name: item.name,
        artist: item.artist,
        type: item.type,
        year: item.year,
      })),
    );
  });
  await step(`latest album of "${wanted}"`, async () => {
    try {
      const latest = await resolveLatestAlbum(externalId, heos, sid, wanted);
      summary.latest = latest.album.name;
      summary.latestMethod = latest.method;
      log(`latest album of "${wanted}"`, { album: latest.album.name, method: latest.method });
    } catch (err) {
      summary.error = err.message;
      throw err;
    }
  });
  await step(`artist play "${wanted}"`, async () => {
    const plan = await resolveArtist(externalId, heos, sid, wanted);
    summary.playMethod = plan.method;
    log(`artist play "${wanted}"`, {
      method: plan.method,
      station: plan.play.station?.name ?? null,
      cid: plan.play.cid ?? null,
    });
  });
  return { lines, artist: summary };
}
