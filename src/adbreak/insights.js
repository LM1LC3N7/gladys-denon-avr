// -----------------------------------------------------------------------------
// What the integration learned about a station's ad breaks, for people: the
// dashboard widget (src/widgets/ad-breaks.js) and the "Ad-break report"
// action of the Configuration screen. Pure — the statistics (stats.js) and
// the jingle state (jingles.js) in, plain data and bilingual texts out.
//
// Every time is local: the time zone of the configuration (applyTimezone()
// in src/config.js), the one the hours were learned in.
// -----------------------------------------------------------------------------

import {
  LEARNING_DAYS,
  dayType,
  isInWindow,
  learnedSchedule,
  preBreakTalkSeconds,
  typicalBreakSeconds,
  windowsAt,
} from './stats.js';

export const DAY_TYPES = ['week', 'sat', 'sun'];
export const DAY_TYPE_LABELS = {
  week: { en: 'Weekdays', fr: 'En semaine' },
  sat: { en: 'Saturday', fr: 'Samedi' },
  sun: { en: 'Sunday', fr: 'Dimanche' },
};
const LOCALES = { en: 'en-GB', fr: 'fr-FR' };
const MINUTE = 60_000;
const RECENT_BREAKS = 15;

/** Each language of `fn(language)`, as a bilingual text. */
export function bilingual(fn) {
  return { en: fn('en'), fr: fn('fr') };
}

/** ":09–:14, :34–:47" — minute windows (an end past 60 wraps the hour). */
export function formatWindows(windows) {
  const minute = (m) => `:${String(m % 60).padStart(2, '0')}`;
  return windows.map(([from, to]) => `${minute(from)}–${minute(to)}`).join(', ');
}

/** "6h–21h, 23h–0h" — the hours set in a 24-entry boolean array. */
export function formatHours(hours) {
  const ranges = [];
  for (let h = 0; h < 24; h++) {
    if (hours[h] && !hours[h - 1]) {
      let end = h;
      while (end < 24 && hours[end]) {
        end += 1;
      }
      ranges.push(`${h}h–${end % 24}h`);
    }
  }
  return ranges.join(', ');
}

/** "6 min", "6 min 12 s", "45 s". */
export function formatDuration(seconds) {
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  if (minutes === 0) {
    return `${rest} s`;
  }
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

/** "14:35" (local). */
export function formatTime(at, language) {
  return new Date(at).toLocaleTimeString(LOCALES[language], { hour: '2-digit', minute: '2-digit' });
}

/** "sat. 11 Oct., 14:35" / "Sat 11 Oct, 14:35" (local). */
export function formatDateTime(at, language) {
  return new Date(at).toLocaleString(LOCALES[language], {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Same local calendar day? */
function sameDay(a, b) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/** "14:34", or "tomorrow 06:09" / "sat. 06:09" beyond today. */
export function formatWhen(at, now, language) {
  const time = formatTime(at, language);
  if (sameDay(at, now)) {
    return time;
  }
  if (sameDay(at, now + 86_400_000)) {
    return `${language === 'fr' ? 'demain' : 'tomorrow'} ${time}`;
  }
  const day = new Date(at).toLocaleDateString(LOCALES[language], { weekday: 'short' });
  return `${day} ${time}`;
}

/**
 * The ad window `now` is in, or the next one within a day: `{from, to,
 * current}` (epoch ms, minute-aligned), or null when none is learned.
 */
export function nextAdWindow(schedule, now) {
  const inAds = (t) => isInWindow(new Date(t).getMinutes(), windowsAt(schedule, t));
  const start = Math.floor(now / MINUTE) * MINUTE;
  let from = null;
  if (inAds(start)) {
    from = start;
    while (from - MINUTE >= start - 60 * MINUTE && inAds(from - MINUTE)) {
      from -= MINUTE;
    }
  } else {
    for (let t = start + MINUTE; t <= start + 24 * 60 * MINUTE; t += MINUTE) {
      if (inAds(t)) {
        from = t;
        break;
      }
    }
  }
  if (from === null) {
    return null;
  }
  let to = Math.max(from, start);
  while (inAds(to) && to < from + 60 * MINUTE) {
    to += MINUTE;
  }
  return { from, to, current: from <= now };
}

/**
 * One jingle side of a station, from its learned state (jingles.js):
 * `{ state: 'active' | 'observing' | 'none', samples, ... }`.
 */
export function jingleSummary(jingle, samples = []) {
  if (!jingle) {
    return { state: 'none', samples: samples.length };
  }
  return {
    state: jingle.active ? 'active' : 'observing',
    samples: samples.length,
    offsetSeconds: jingle.offsetSeconds,
    confirmed: jingle.confirmed ?? 0,
    hits: jingle.hits ?? 0,
    support: jingle.support,
    score: jingle.score,
    learnedAt: jingle.learnedAt ?? null,
  };
}

/**
 * What is known of one station's ad breaks.
 * @param {object} opts
 * @param {string} opts.key
 * @param {string} [opts.name]
 * @param {object} opts.stats       its statistics (stats.js), name included
 * @param {object|null} [opts.jingles] its learned jingle state (jingles.js)
 * @param {number} [opts.now]
 */
export function describeStation({ key, name, stats, jingles = null, now = Date.now() }) {
  const recent = stats.breaks.filter((b) => b.at >= now - LEARNING_DAYS * 86_400_000);
  const schedule = learnedSchedule(stats, { coveredFrom: stats.historyFrom ?? null, now });
  const days = {};
  for (const type of DAY_TYPES) {
    const windows = schedule.windows[type];
    const hours = schedule.hours?.[type] ?? null;
    days[type] = {
      windows,
      // null: every hour (no full playlist history to tell the hours apart)
      hours: hours && windows.length ? hours : null,
      hasAds: windows.length > 0 && (!hours || hours.some(Boolean)),
      perHour: Array.from({ length: 24 }, (_, hour) =>
        recent.filter((b) => dayType(b.at) === type && new Date(b.at).getHours() === hour),
      ).map((breaks) => breaks.length),
    };
  }
  const bySource = {};
  for (const b of recent) {
    bySource[b.source] = (bySource[b.source] ?? 0) + 1;
  }
  const marks = stats.markOffsets ?? [];
  return {
    key,
    name: name || stats.name || key,
    breaksLearned: recent.length,
    breaksToday: recent.filter((b) => sameDay(b.at, now)).length,
    bySource,
    typicalBreakSeconds: typicalBreakSeconds(stats),
    hostTalkSeconds: preBreakTalkSeconds(stats),
    hostTalkLearned: marks.length >= 3,
    today: dayType(now),
    days,
    nextWindow: nextAdWindow(schedule, now),
    recentBreaks: [...recent].sort((a, b) => b.at - a.at).slice(0, RECENT_BREAKS),
    feedSite: stats.feed?.site ?? null,
    jingles: {
      start: jingleSummary(jingles?.jingles?.start, jingles?.samples?.start),
      end: jingleSummary(jingles?.jingles?.end, jingles?.samples?.end),
    },
  };
}

const SOURCE_LABELS = {
  auto: { en: 'heard', fr: 'entendue' },
  history: { en: 'playlist history', fr: 'historique' },
  manual: { en: 'switched by hand', fr: 'signalée' },
};

/** "Sat 11 Oct, 14:35 · 6 min 12 s · heard" per line, newest first. */
export function recentBreaksText(station, language) {
  return station.recentBreaks
    .map((b) =>
      [
        formatDateTime(b.at, language),
        b.durationSeconds ? formatDuration(b.durationSeconds) : null,
        SOURCE_LABELS[b.source]?.[language] ?? b.source,
      ]
        .filter(Boolean)
        .join(' · '),
    )
    .join('\n');
}

/** "6h–21h · :09–:14, :34–:47" — one day type, in one line. */
export function dayLine(day, language) {
  if (!day.hasAds) {
    return language === 'fr' ? 'pas de pub apprise' : 'no ads learned';
  }
  const hours = day.hours
    ? formatHours(day.hours)
    : language === 'fr'
      ? 'toutes les heures'
      : 'every hour';
  return `${hours} · ${formatWindows(day.windows)}`;
}

/** One line per hour with ads: "09h  :09–:14, :34–:47  (5 breaks)". */
export function dayDetailText(day, language) {
  if (!day.hasAds) {
    return language === 'fr'
      ? 'Aucune fenêtre de pub apprise pour ces jours-là.'
      : 'No ad window learned for these days yet.';
  }
  const windows = formatWindows(day.windows);
  const lines = [];
  for (let hour = 0; hour < 24; hour++) {
    if (day.hours && !day.hours[hour]) {
      continue;
    }
    const count = day.perHour[hour];
    const heard = count
      ? language === 'fr'
        ? ` (${count} pub${count > 1 ? 's' : ''} en ${LEARNING_DAYS} j)`
        : ` (${count} break${count > 1 ? 's' : ''} in ${LEARNING_DAYS} d)`
      : '';
    lines.push(`${String(hour).padStart(2, '0')}h  ${windows}${heard}`);
  }
  if (!day.hours) {
    lines.unshift(
      language === 'fr'
        ? 'Mêmes fenêtres à toutes les heures (sans historique complet, les heures sans pub ne sont pas connues) :'
        : 'Same windows every hour (without a full playlist history, the hours without ads are unknown):',
    );
  }
  return lines.join('\n');
}

/** "Active · 5/6 confirmed", "Observing · 1/2", "Not learned (2/3 samples)". */
export function jingleStateText(jingle, language) {
  const fr = language === 'fr';
  if (jingle.state === 'active') {
    return fr
      ? `Actif · ${jingle.confirmed}/${jingle.hits} confirmés`
      : `Active · ${jingle.confirmed}/${jingle.hits} confirmed`;
  }
  if (jingle.state === 'observing') {
    return fr
      ? `En observation · ${jingle.confirmed}/${jingle.hits}`
      : `Observing · ${jingle.confirmed}/${jingle.hits}`;
  }
  return fr
    ? `Pas encore appris (${Math.min(jingle.samples, 3)}/3 échantillons)`
    : `Not learned yet (${Math.min(jingle.samples, 3)}/3 samples)`;
}

/** Where the jingle sits, how it was learned. */
export function jingleDetailText(jingle, side, language) {
  const fr = language === 'fr';
  if (jingle.state === 'none') {
    return fr
      ? `Il faut ${side === 'start' ? 'trois coupures entendues (ou trois signalements juste après le jingle)' : 'trois coupures entendues jusqu’au titre suivant'} pour le chercher. Échantillons : ${jingle.samples}.`
      : `${side === 'start' ? 'Three breaks heard (or three switches right after the jingle)' : 'Three breaks heard up to the next song'} are needed to look for it. Samples: ${jingle.samples}.`;
  }
  const where =
    side === 'start'
      ? fr
        ? `~${Math.abs(jingle.offsetSeconds)} s ${jingle.offsetSeconds < 0 ? 'avant' : 'après'} la fin du titre`
        : `~${Math.abs(jingle.offsetSeconds)} s ${jingle.offsetSeconds < 0 ? 'before' : 'after'} the song end`
      : fr
        ? `~${Math.abs(jingle.offsetSeconds)} s avant le titre suivant`
        : `~${Math.abs(jingle.offsetSeconds)} s before the next song`;
  const lines = [
    where,
    fr
      ? `Trouvé dans ${jingle.support} échantillons sur ${jingle.samples}, ressemblance ${jingle.score}`
      : `Found in ${jingle.support} of ${jingle.samples} samples, similarity ${jingle.score}`,
    fr
      ? `Détections confirmées : ${jingle.confirmed} sur ${jingle.hits}`
      : `Confirmed detections: ${jingle.confirmed} of ${jingle.hits}`,
  ];
  if (jingle.learnedAt) {
    lines.push(
      fr
        ? `Appris le ${formatDateTime(jingle.learnedAt, language)}`
        : `Learned ${formatDateTime(jingle.learnedAt, language)}`,
    );
  }
  lines.push(
    jingle.state === 'active'
      ? fr
        ? 'Actif : le volume baisse dès qu’il passe.'
        : 'Active: the volume drops as soon as it airs.'
      : fr
        ? 'En observation : actif après 2 détections suivies d’une vraie coupure.'
        : 'Observing: active after 2 detections followed by a real break.',
  );
  return lines.join('\n');
}

/** The "Ad-break report" text of every station learned, one paragraph each. */
export function reportText(stations, language) {
  const fr = language === 'fr';
  if (stations.length === 0) {
    return fr
      ? 'Rien d’appris pour l’instant : activez la détection des coupures pub et écoutez une radio via HEOS.'
      : 'Nothing learned yet: switch the ad-break detection on and play a radio station through HEOS.';
  }
  const colon = fr ? ' : ' : ': ';
  const jingleLabels = fr
    ? { start: 'Jingle de début', end: 'Jingle de fin' }
    : { start: 'Start jingle', end: 'End jingle' };
  return stations
    .map((station) => {
      const typical = station.typicalBreakSeconds
        ? formatDuration(station.typicalBreakSeconds)
        : null;
      const summary = fr
        ? `${station.breaksLearned} pub${station.breaksLearned > 1 ? 's' : ''} sur ${LEARNING_DAYS} jours${typical ? `, ${typical} en général` : ''}`
        : `${station.breaksLearned} break${station.breaksLearned === 1 ? '' : 's'} in ${LEARNING_DAYS} days${typical ? `, typically ${typical}` : ''}`;
      const lines = [`${station.name} — ${summary}`];
      for (const type of DAY_TYPES) {
        lines.push(
          `  ${DAY_TYPE_LABELS[type][language]}${colon}${dayLine(station.days[type], language)}`,
        );
      }
      for (const side of ['start', 'end']) {
        lines.push(
          `  ${jingleLabels[side]}${colon}${jingleStateText(station.jingles[side], language)}`,
        );
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
