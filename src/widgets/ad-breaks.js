// -----------------------------------------------------------------------------
// The "Radio" widget set to show the ad breaks (its `show` setting, see
// RADIO_VIEWS in ./common.js): what the ad-break detection (src/adbreak/) knows of
// the station playing on the receiver, else of the last one played. Pure:
// `insights` comes from the controller (adBreakInsights() in
// src/devices/heos-session.js), see src/adbreak/insights.js.
//
//   heading   the station
//   caption   in a break since… / in an ad window until… / next ad window…
//   tiles     breaks over the learning period, typical length, today
//   status    start and end jingles, where song changes come from, host
//             talk before the ads, the volume lowered right now
//   card-list one card per day type (hours with ads and minute windows,
//             the detail per hour), the recent breaks, each jingle
//   button    "It's an ad!" / "Ads are over" (the Radio ad break switch)
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { FEATURE } from '../devices/avr.js';
import {
  DAY_TYPES,
  DAY_TYPE_LABELS,
  bilingual,
  dayDetailText,
  dayLine,
  formatDateTime,
  formatDuration,
  formatTime,
  formatWhen,
  jingleDetailText,
  jingleStateText,
  recentBreaksText,
} from '../adbreak/insights.js';
import { LEARNING_DAYS } from '../adbreak/stats.js';
import { WIDGET, WIDGET_TTL_SECONDS, fit, heading } from './common.js';

export const AD_TEXTS = {
  noHeos: {
    en: 'Radio ad breaks are only followed on stations played through HEOS, and HEOS is not connected to this receiver.',
    fr: 'Les coupures pub ne sont suivies que sur les radios écoutées via HEOS, et HEOS n’est pas connecté à cet ampli.',
  },
  off: {
    en: 'Radio ad-break detection is off: switch it on in the integration’s configuration, then play a radio station through HEOS.',
    fr: 'La détection des coupures pub est désactivée : activez-la dans la configuration de l’intégration, puis écoutez une radio via HEOS.',
  },
  noStation: {
    en: 'No radio station played yet: play one through HEOS (TuneIn, a favorite, a stream URL).',
    fr: 'Aucune radio écoutée pour l’instant : lancez-en une via HEOS (TuneIn, un favori, une URL de flux).',
  },
  breaks: { en: `Breaks, ${LEARNING_DAYS} days`, fr: `Pubs sur ${LEARNING_DAYS} j` },
  typical: { en: 'Typical length', fr: 'Durée type' },
  today: { en: 'Today', fr: 'Aujourd’hui' },
  startJingle: { en: 'Start jingle', fr: 'Jingle de début' },
  endJingle: { en: 'End jingle', fr: 'Jingle de fin' },
  songs: { en: 'Song changes', fr: 'Changements de titre' },
  songSource: {
    feed: { en: 'Station feed', fr: 'Flux de la station' },
    heos: { en: 'HEOS titles', fr: 'Titres HEOS' },
    none: { en: 'None: switched by hand', fr: 'Aucun : à signaler' },
  },
  hostTalk: { en: 'Host talk before ads', fr: 'Animateur avant la pub' },
  volume: { en: 'Volume', fr: 'Volume' },
  recent: { en: 'Recent breaks', fr: 'Dernières pubs' },
  noBreak: { en: 'None yet', fr: 'Aucune pour l’instant' },
  todayBadge: { en: 'Today', fr: 'Aujourd’hui' },
  active: { en: 'Active', fr: 'Actif' },
  observing: { en: 'Observing', fr: 'Observé' },
  itsAnAd: { en: 'It’s an ad!', fr: 'C’est la pub !' },
  adsOver: { en: 'Ads are over', fr: 'Fin de la pub' },
};

function textOnly(text) {
  return {
    version: 1,
    ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.RADIO],
    components: [{ type: 'text', variant: 'body', text }],
  };
}

/** The caption under the station name: the live state in one line. */
function captionOf(insights, now) {
  const { station } = insights;
  if (insights.inBreak) {
    return bilingual((l) =>
      l === 'fr'
        ? `Pub en cours depuis ${formatTime(insights.breakSince, l)}`
        : `Ad break since ${formatTime(insights.breakSince, l)}`,
    );
  }
  if (!insights.detection) {
    return bilingual((l) =>
      l === 'fr' ? 'Détection désactivée : ce qui a été appris' : 'Detection off: what was learned',
    );
  }
  const next = station.nextWindow;
  if (!next) {
    return bilingual((l) =>
      l === 'fr' ? 'Pas encore de fenêtre de pub apprise' : 'No ad window learned yet',
    );
  }
  const prefix = (l) => {
    if (insights.playing) {
      return '';
    }
    return l === 'fr' ? 'Pas en écoute · ' : 'Not playing · ';
  };
  if (next.current) {
    return bilingual((l) =>
      l === 'fr'
        ? `${prefix(l)}Fenêtre de pub jusqu’à ${formatTime(next.to, l)}`
        : `${prefix(l)}In an ad window until ${formatTime(next.to, l)}`,
    );
  }
  return bilingual(
    (l) =>
      `${prefix(l)}${l === 'fr' ? 'Prochaine pub' : 'Next ad window'} ${formatWhen(next.from, now, l)}–${formatTime(next.to, l)}`,
  );
}

function jingleItem(jingle, label) {
  return {
    label,
    value: bilingual((l) => fit(jingleStateText(jingle, l), 40)),
    color:
      jingle.state === 'active'
        ? WIDGET_COLORS.SUCCESS
        : jingle.state === 'observing'
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.NEUTRAL,
  };
}

function statusItems(insights) {
  const { station } = insights;
  const items = [];
  if (insights.jinglesEnabled) {
    items.push(jingleItem(station.jingles.start, AD_TEXTS.startJingle));
    items.push(jingleItem(station.jingles.end, AD_TEXTS.endJingle));
  }
  if (insights.songSource) {
    items.push({ label: AD_TEXTS.songs, value: AD_TEXTS.songSource[insights.songSource] });
  }
  if (insights.songSource !== 'none') {
    items.push({
      label: AD_TEXTS.hostTalk,
      value: bilingual(
        (l) =>
          `${formatDuration(station.hostTalkSeconds)}${station.hostTalkLearned ? '' : l === 'fr' ? ' (par défaut)' : ' (default)'}`,
      ),
    });
  }
  if (insights.ducked) {
    items.push({
      label: AD_TEXTS.volume,
      value: `${insights.ducked.saved} → ${insights.ducked.ducked}`,
      color: WIDGET_COLORS.INFO,
    });
  }
  return items;
}

function cards(insights) {
  const { station } = insights;
  const items = DAY_TYPES.map((type) => {
    const day = station.days[type];
    const item = {
      title: DAY_TYPE_LABELS[type],
      subtitle: bilingual((l) => fit(dayLine(day, l), 80)),
      description: bilingual((l) => fit(dayDetailText(day, l), 2000)),
    };
    if (type === station.today) {
      item.badge = { text: AD_TEXTS.todayBadge, color: WIDGET_COLORS.PRIMARY };
    }
    return item;
  });
  const [last] = station.recentBreaks;
  items.push({
    title: AD_TEXTS.recent,
    subtitle: last
      ? bilingual(
          (l) =>
            `${formatDateTime(last.at, l)}${last.durationSeconds ? ` · ${formatDuration(last.durationSeconds)}` : ''}`,
        )
      : AD_TEXTS.noBreak,
    ...(last ? { description: bilingual((l) => fit(recentBreaksText(station, l), 2000)) } : {}),
  });
  if (insights.jinglesEnabled) {
    for (const side of ['start', 'end']) {
      const jingle = station.jingles[side];
      const item = {
        title: side === 'start' ? AD_TEXTS.startJingle : AD_TEXTS.endJingle,
        subtitle: bilingual((l) => fit(jingleStateText(jingle, l), 80)),
        description: bilingual((l) => fit(jingleDetailText(jingle, side, l), 2000)),
      };
      if (jingle.state !== 'none') {
        item.badge =
          jingle.state === 'active'
            ? { text: AD_TEXTS.active, color: WIDGET_COLORS.SUCCESS }
            : { text: AD_TEXTS.observing, color: WIDGET_COLORS.WARNING };
      }
      items.push(item);
    }
  }
  return { type: 'card-list', display: 'list', items: items.slice(0, 8) };
}

/**
 * The "Radio" widget's ad-break view. `insights`: adBreakInsights() of the receiver,
 * null when it has no HEOS session.
 */
export function adBreaksContent(view, insights, now = Date.now()) {
  if (!insights) {
    return textOnly(AD_TEXTS.noHeos);
  }
  if (!insights.station) {
    return textOnly(insights.detection ? AD_TEXTS.noStation : AD_TEXTS.off);
  }
  const { station } = insights;
  const components = [
    heading(station.name),
    { type: 'text', variant: 'caption', text: fit(captionOf(insights, now), 80) },
    { type: 'value', label: AD_TEXTS.breaks, value: station.breaksLearned },
    {
      type: 'value',
      label: AD_TEXTS.typical,
      value: station.typicalBreakSeconds ? formatDuration(station.typicalBreakSeconds) : '—',
    },
    { type: 'value', label: AD_TEXTS.today, value: station.breaksToday },
    { type: 'status', items: statusItems(insights) },
    cards(insights),
  ];
  if (insights.detection && insights.playing) {
    components.push({
      type: 'button',
      label: insights.inBreak ? AD_TEXTS.adsOver : AD_TEXTS.itsAnAd,
      icon: insights.inBreak ? 'music' : 'volume-1',
      device_feature: `${view.externalId}:${FEATURE.AD_BREAK}`,
      value: insights.inBreak ? 0 : 1,
    });
  }
  return {
    version: 1,
    ttl_seconds: WIDGET_TTL_SECONDS[WIDGET.RADIO],
    components,
  };
}
