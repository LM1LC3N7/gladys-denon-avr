import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';

// Before anything formats a time: the user's clock, not the container's.
process.env.TZ = 'Europe/Paris';
const {
  describeStation,
  formatDuration,
  formatHours,
  formatWhen,
  formatWindows,
  jingleDetailText,
  jingleStateText,
  jingleSummary,
  nextAdWindow,
  recentBreaksText,
  reportText,
  dayDetailText,
  dayLine,
} = await import('../src/adbreak/insights.js');
const { emptyStats, recordBreak } = await import('../src/adbreak/stats.js');
const { adBreaksContent } = await import('../src/widgets/ad-breaks.js');

// Wednesday 7 Oct 2026, local time.
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime();
const NOW = at(7, 14, 20);

/** OUI FM-like: breaks at :10 and :35, 6h-20h, every day of the last week. */
function learnedStats({ withHistory = true } = {}) {
  let stats = emptyStats();
  for (let day = 1; day <= 7; day++) {
    for (let h = 6; h < 21; h++) {
      for (const m of [10, 35]) {
        const start = at(day, h, m);
        if (start < NOW) {
          stats = recordBreak(stats, { startedAt: start, durationSeconds: 372, source: 'history' });
        }
      }
    }
  }
  stats = recordBreak(stats, { startedAt: at(7, 14, 11), durationSeconds: 300, source: 'auto' });
  return {
    ...stats,
    name: 'OUI FM',
    markOffsets: [{ offset: 20, hour: 9 }, { offset: 30, hour: 9 }, 25],
    feed: { site: 'https://www.ouifm.fr' },
    ...(withHistory ? { historyFrom: at(1, 0), historyReadUntil: NOW } : {}),
  };
}

const JINGLES = {
  version: 2,
  samples: { start: [{}, {}, {}, {}], end: [{}] },
  jingles: {
    start: {
      active: true,
      offsetSeconds: 12,
      confirmed: 5,
      hits: 6,
      support: 4,
      score: 0.81,
      learnedAt: at(5, 9, 3),
    },
    end: null,
  },
};

test('formatting: minute windows, hours, durations, times', () => {
  assert.equal(
    formatWindows([
      [9, 14],
      [34, 47],
      [58, 63],
    ]),
    ':09–:14, :34–:47, :58–:03',
  );
  const hours = Array.from({ length: 24 }, (_, h) => (h >= 6 && h < 21) || h === 23);
  assert.equal(formatHours(hours), '6h–21h, 23h–0h');
  assert.equal(formatDuration(45), '45 s');
  assert.equal(formatDuration(360), '6 min');
  assert.equal(formatDuration(372), '6 min 12 s');
  assert.equal(formatWhen(at(7, 14, 34), NOW, 'en'), '14:34');
  assert.equal(formatWhen(at(8, 6, 9), NOW, 'fr'), 'demain 06:09');
  assert.equal(formatWhen(at(8, 6, 9), NOW, 'en'), 'tomorrow 06:09');
  assert.match(formatWhen(at(10, 6, 9), NOW, 'en'), /^Sat 06:09$/);
});

test('nextAdWindow: the current window, the next one, or none', () => {
  const schedule = { windows: { week: [[34, 47]], sat: [], sun: [] }, hours: null };
  assert.deepEqual(nextAdWindow(schedule, NOW), {
    from: at(7, 14, 34),
    to: at(7, 14, 47),
    current: false,
  });
  assert.deepEqual(nextAdWindow(schedule, at(7, 14, 40)), {
    from: at(7, 14, 34),
    to: at(7, 14, 47),
    current: true,
  });
  // No ads at 21h-6h on weekdays: the next window is the morning one.
  const hours = Array.from({ length: 24 }, (_, h) => h >= 6 && h < 21);
  const night = nextAdWindow(
    { ...schedule, hours: { week: hours, sat: hours, sun: hours } },
    at(7, 22),
  );
  assert.equal(night.from, at(8, 6, 34));
  assert.equal(nextAdWindow({ windows: { week: [], sat: [], sun: [] }, hours: null }, NOW), null);
});

test('describeStation: windows and hours by day type, counts, jingles', () => {
  const station = describeStation({
    key: 'tunein:s6586',
    stats: learnedStats(),
    jingles: JINGLES,
    now: NOW,
  });
  assert.equal(station.name, 'OUI FM');
  assert.equal(station.today, 'week');
  assert.ok(station.breaksLearned > 150);
  assert.equal(station.breaksToday, 17 + 1);
  assert.equal(station.typicalBreakSeconds, 372);
  assert.equal(station.hostTalkSeconds, 25);
  assert.equal(station.hostTalkLearned, true);
  const week = station.days.week;
  assert.ok(week.hasAds);
  assert.ok(week.windows.some(([from, to]) => from <= 10 && to > 10));
  assert.equal(week.hours[5], false, 'no ads before 6h');
  assert.equal(week.hours[9], true);
  assert.equal(week.perHour[9], 10, 'five weekdays, two breaks an hour');
  assert.match(dayLine(week, 'en'), /^6h–21h · :\d\d–:\d\d, :\d\d–:\d\d$/);
  assert.match(dayDetailText(week, 'fr'), /^06h {2}:\d\d–:\d\d, :\d\d–:\d\d \(10 pubs en 14 j\)/);
  assert.equal(station.nextWindow.current, false);
  assert.equal(station.recentBreaks[0].source, 'auto');
  assert.match(recentBreaksText(station, 'en'), /^Wed 7 Oct, 14:11 · 5 min · heard\n/);
  assert.deepEqual(station.jingles.end, { state: 'none', samples: 1 });
  // Saved before 1.2.3: no record of heard/missed breaks yet, not reliable.
  assert.equal(jingleStateText(station.jingles.start, 'en'), 'Active · no break checked yet');
  assert.deepEqual(
    [station.jingles.start.heard, station.jingles.start.recorded, station.jingles.start.reliable],
    [0, 0, false],
  );
  assert.equal(jingleStateText(station.jingles.end, 'fr'), 'Pas encore appris (1/3 échantillons)');
  assert.match(
    jingleDetailText(station.jingles.start, 'start', 'en'),
    /^~12 s after the song end\n/,
  );
  assert.match(jingleDetailText(station.jingles.end, 'end', 'fr'), /Échantillons : 1\./);

  const noHistory = describeStation({
    key: 'k',
    stats: learnedStats({ withHistory: false }),
    now: NOW,
  });
  assert.equal(noHistory.days.sat.hours, null, 'without coverage, every hour');
  assert.match(dayLine(noHistory.days.sat, 'fr'), /^toutes les heures · /);
  assert.match(dayDetailText(noHistory.days.sat, 'en'), /^Same windows every hour/);
  const nothing = describeStation({ key: 'url:x', stats: emptyStats(), now: NOW });
  assert.equal(nothing.name, 'url:x');
  assert.equal(dayLine(nothing.days.week, 'en'), 'no ads learned');
  assert.match(dayDetailText(nothing.days.week, 'fr'), /^Aucune fenêtre/);
});

test('jingleSummary and its texts while a jingle is only observed', () => {
  const observed = jingleSummary(
    { offsetSeconds: -3, confirmed: 1, hits: 2, support: 3, score: 0.6 },
    [{}, {}, {}],
  );
  assert.equal(observed.state, 'observing');
  assert.equal(jingleStateText(observed, 'en'), 'Observing · 1/2');
  assert.equal(jingleStateText(observed, 'fr'), 'En observation · 1/2');
  assert.match(jingleDetailText(observed, 'start', 'fr'), /^~3 s avant la fin du titre/);
  assert.match(
    jingleDetailText(observed, 'end', 'en'),
    /before the next song[\s\S]*Observing: active/,
  );
  assert.match(jingleDetailText(jingleSummary(null), 'start', 'en'), /^Three breaks heard/);
});

test('reportText: one paragraph per station, or what to do first', () => {
  assert.match(reportText([], 'en'), /^Nothing learned yet/);
  assert.match(reportText([], 'fr'), /^Rien d’appris/);
  const station = describeStation({ key: 'k', stats: learnedStats(), jingles: JINGLES, now: NOW });
  const en = reportText([station], 'en');
  assert.match(
    en,
    /^OUI FM — \d+ breaks in 14 days, typically 6 min 12 s\n {2}Weekdays: 6h–21h · /,
  );
  assert.match(
    en,
    /Start jingle: Active · no break checked yet \(not reliable yet: no 1 min 30 s wait\)\n {2}End jingle: Not learned yet/,
  );
  assert.match(reportText([station], 'fr'), /\n {2}Samedi : 6h–21h · /);
  const one = describeStation({
    key: 'url:y',
    stats: recordBreak(emptyStats(), { startedAt: NOW - 1000, source: 'manual' }),
    now: NOW,
  });
  assert.match(reportText([one], 'en'), /^url:y — 1 break in 14 days\n/);
  assert.match(reportText([one], 'fr'), /^url:y — 1 pub sur 14 jours\n/);
});

const VIEW = { externalId: 'avr:1', name: 'Salon' };
const live = (overrides = {}) => ({
  detection: true,
  jinglesEnabled: true,
  autoDuck: true,
  playing: true,
  inBreak: false,
  breakSince: null,
  ducked: null,
  songSource: 'feed',
  station: describeStation({ key: 'k', stats: learnedStats(), jingles: JINGLES, now: NOW }),
  ...overrides,
});

test('the ad-break widget content fits the core vocabulary in every state', () => {
  const contents = [
    adBreaksContent(VIEW, null, NOW),
    adBreaksContent(VIEW, { ...live(), station: null }, NOW),
    adBreaksContent(VIEW, { ...live(), detection: false, station: null }, NOW),
    adBreaksContent(VIEW, live(), NOW),
    adBreaksContent(
      VIEW,
      live({ inBreak: true, breakSince: at(7, 14, 10), ducked: { saved: 50, ducked: 30 } }),
      NOW,
    ),
    adBreaksContent(
      VIEW,
      live({ detection: false, playing: false, jinglesEnabled: false, songSource: 'none' }),
      NOW,
    ),
    adBreaksContent(
      VIEW,
      live({
        station: describeStation({ key: 'url:x', stats: emptyStats(), now: NOW }),
        songSource: 'heos',
      }),
      NOW,
    ),
  ];
  for (const content of contents) {
    assert.deepEqual(validateWidgetContent(content), []);
  }
  const [noHeos, noStation, off, full, inBreak, learnedOnly, empty] = contents;
  assert.match(noHeos.components[0].text.en, /HEOS is not connected/);
  assert.match(noStation.components[0].text.fr, /Aucune radio écoutée/);
  assert.match(off.components[0].text.en, /detection is off/);

  const caption = (content) => content.components[1].text;
  assert.equal(full.components[0].text, 'OUI FM');
  assert.match(caption(full).en, /^Next ad window 14:3\d–14:\d\d$/);
  assert.equal(caption(inBreak).fr, 'Pub en cours depuis 14:10');
  assert.equal(caption(learnedOnly).en, 'Detection off: what was learned');
  assert.equal(caption(empty).en, 'No ad window learned yet');

  const cards = full.components.find((c) => c.type === 'card-list');
  assert.deepEqual(
    cards.items.map((item) => item.title.en),
    ['Weekdays', 'Saturday', 'Sunday', 'Recent breaks', 'Start jingle', 'End jingle'],
  );
  assert.equal(cards.items[0].badge.text.en, 'Today');
  assert.equal(cards.items[4].badge.text.fr, 'Actif');
  const status = full.components.find((c) => c.type === 'status');
  assert.deepEqual(
    status.items.map((item) => item.label.en),
    ['Start jingle', 'End jingle', 'Song changes', 'Host talk before ads'],
  );
  const button = full.components.find((c) => c.type === 'button');
  assert.deepEqual([button.device_feature, button.value], ['avr:1:ad_break', 1]);
  assert.equal(inBreak.components.find((c) => c.type === 'button').value, 0);
  assert.ok(
    inBreak.components
      .find((c) => c.type === 'status')
      .items.some((item) => item.value === '50 → 30'),
  );
  assert.equal(learnedOnly.components.filter((c) => c.type === 'button').length, 0);
  assert.equal(
    learnedOnly.components.find((c) => c.type === 'card-list').items.length,
    4,
    'no jingle cards with the jingles off',
  );
});

test('a widget caption while the station is not playing, inside an ad window', () => {
  const inWindow = at(7, 14, 10);
  const content = adBreaksContent(
    VIEW,
    live({
      playing: false,
      station: describeStation({
        key: 'k',
        stats: learnedStats(),
        jingles: JINGLES,
        now: inWindow,
      }),
    }),
    inWindow,
  );
  assert.match(content.components[1].text.en, /^Not playing · In an ad window until 14:\d\d$/);
  assert.match(content.components[1].text.fr, /^Pas en écoute · Fenêtre de pub jusqu’à 14:\d\d$/);
});

test('an active jingle shows its recall; the 90 s wait only for a reliable start jingle', () => {
  const withRecord = (record, extra = {}) =>
    describeStation({
      key: 'k',
      stats: learnedStats(),
      jingles: {
        ...JINGLES,
        jingles: {
          start: { ...JINGLES.jingles.start, record, ...extra },
          end: { ...JINGLES.jingles.start, offsetSeconds: -5, record },
        },
      },
      now: NOW,
    });
  // Louis's OUI FM: active, but heard in 3 of the last 10 breaks.
  const missed = withRecord([true, false, false, true, false, false, false, true, false, false]);
  const start = missed.jingles.start;
  assert.deepEqual([start.heard, start.recorded, start.reliable], [3, 10, false]);
  assert.equal(jingleStateText(start, 'fr'), 'Actif · reconnu dans 3 des 10 dernières coupures');
  assert.equal(jingleStateText(start, 'en'), 'Active · heard in 3 of the last 10 breaks');
  assert.equal(jingleStateText(start, 'fr', { short: true }), 'Actif · reconnu 3 fois sur 10');
  assert.equal(jingleStateText(start, 'en', { short: true }), 'Active · heard 3 of 10');
  const detailFr = jingleDetailText(start, 'start', 'fr');
  assert.match(detailFr, /Détections confirmées : 5 sur 6/, 'the confirmed count stays');
  assert.match(detailFr, /Coupures suivies : reconnu dans 3 des 10 dernières coupures/);
  assert.match(
    detailFr,
    /Pas encore fiable \(il faut 80 % sur 5 coupures au moins\) : sans jingle, l’attente de 1 min 30 s n’est pas utilisée/,
  );
  assert.match(jingleDetailText(start, 'start', 'en'), /Not reliable yet \(needs 80 % over/);
  assert.doesNotMatch(
    jingleDetailText(missed.jingles.end, 'end', 'en'),
    /reliable/i,
    'the wait is about the start jingle only',
  );
  assert.match(
    reportText([missed], 'fr'),
    /Jingle de début : Actif · reconnu dans 3 des 10 dernières coupures \(pas encore fiable : attente de 1 min 30 s non utilisée\)\n {2}Jingle de fin : Actif · reconnu dans 3 des 10 dernières coupures$/,
  );

  const reliable = withRecord([true, true, false, true, true]).jingles.start;
  assert.equal(reliable.reliable, true);
  assert.match(
    jingleDetailText(reliable, 'start', 'fr'),
    /Fiable \(80 % sur 5 coupures au moins\) : sans jingle, la coupure est prise 1 min 30 s après la fin du titre\./,
  );
  assert.match(jingleDetailText(reliable, 'start', 'en'), /Reliable \(80 % over at least 5/);
  assert.equal(
    reportText([withRecord([true, true, false, true, true])], 'en').match(/not reliable/),
    null,
  );
  // One break recorded: said in words.
  assert.equal(
    jingleStateText(withRecord([false]).jingles.start, 'fr'),
    'Actif · manqué dans la dernière coupure',
  );
  assert.equal(
    jingleStateText(withRecord([true]).jingles.start, 'en'),
    'Active · heard in the last break',
  );
  assert.equal(
    jingleStateText(withRecord([true]).jingles.start, 'fr', { short: true }),
    'Actif · reconnu dans la dernière coupure',
  );
  assert.equal(
    jingleStateText(withRecord([false]).jingles.start, 'en'),
    'Active · missed in the last break',
  );
  assert.equal(
    jingleStateText(withRecord([]).jingles.start, 'fr'),
    'Actif · aucune coupure suivie encore',
  );

  // Demoted: back to observation, and said so in the detail.
  const demoted = withRecord([], { active: false, hits: 0, confirmed: 0, demotedAt: at(6, 9) });
  assert.equal(jingleStateText(demoted.jingles.start, 'fr'), 'En observation · 0/0');
  assert.match(
    jingleDetailText(demoted.jingles.start, 'start', 'fr'),
    /Repassé en observation le .+ : manqué dans trop de coupures/,
  );
  assert.match(
    jingleDetailText(demoted.jingles.start, 'start', 'en'),
    /Back to observation .+: missed in too many breaks/,
  );

  // The widget: short recall in the status (blue while not reliable), the
  // long one in the card.
  const widget = (station) => adBreaksContent(VIEW, live({ station }), NOW);
  const content = widget(missed);
  assert.deepEqual(validateWidgetContent(content), []);
  const [startItem] = content.components.find((c) => c.type === 'status').items;
  assert.equal(startItem.value.fr, 'Actif · reconnu 3 fois sur 10');
  assert.equal(startItem.color, 'info');
  const card = content.components.find((c) => c.type === 'card-list').items[4];
  assert.equal(card.subtitle.fr, 'Actif · reconnu dans 3 des 10 dernières coupures');
  assert.match(card.description.fr, /l’attente de 1 min 30 s n’est pas utilisée/);
  const good = widget(withRecord([true, true, true, true, true]));
  assert.equal(good.components.find((c) => c.type === 'status').items[0].color, 'success');
});
