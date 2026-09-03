import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEOS_PORT,
  HEOS_PLAY_STATE,
  HEOS_EVENT,
  buildGetPlayersCommand,
  buildGetPlayStateCommand,
  buildSetPlayStateCommand,
  buildPlayCommand,
  buildPauseCommand,
  buildPlayNextCommand,
  buildPlayPreviousCommand,
  buildGetNowPlayingMediaCommand,
  buildPlayStreamCommand,
  buildRegisterForChangeEventsCommand,
  parseMessage,
  findPlayerIdByIp,
  heosPlayStateToPlaybackState,
  parseNowPlayingMedia,
} from '../src/heos/protocol.js';

test('HEOS_PORT is the well-known HEOS CLI port', () => {
  assert.equal(HEOS_PORT, 1255);
});

test('command builders produce the exact heos:// path (without the scheme, added by the client)', () => {
  assert.equal(buildGetPlayersCommand(), 'player/get_players');
  assert.equal(buildGetPlayStateCommand(12345), 'player/get_play_state?pid=12345');
  assert.equal(
    buildSetPlayStateCommand(12345, HEOS_PLAY_STATE.PLAY),
    'player/set_play_state?pid=12345&state=play',
  );
  assert.equal(buildPlayCommand(12345), 'player/set_play_state?pid=12345&state=play');
  assert.equal(buildPauseCommand(12345), 'player/set_play_state?pid=12345&state=pause');
  assert.equal(buildPlayNextCommand(12345), 'player/play_next?pid=12345');
  assert.equal(buildPlayPreviousCommand(12345), 'player/play_previous?pid=12345');
  assert.equal(buildGetNowPlayingMediaCommand(12345), 'player/get_now_playing_media?pid=12345');
  assert.equal(
    buildRegisterForChangeEventsCommand(),
    'system/register_for_change_events?enable=on',
  );
  assert.equal(
    buildRegisterForChangeEventsCommand(false),
    'system/register_for_change_events?enable=off',
  );
});

test('buildPlayStreamCommand sends the URL raw, as the last parameter, per the HEOS CLI spec', () => {
  // Confirmed on real hardware: a percent-encoded URL was silently accepted
  // (result: success) but never actually played (get_play_state stuck on
  // "stop" forever) — pyheos's own HeosCommand query encoder exempts `url`
  // from its minimal escaping and requires it last, precisely so an `&`/`?`
  // inside the URL is never mistaken for another HEOS parameter.
  assert.equal(
    buildPlayStreamCommand(12345, 'https://tts.example.com/say.mp3'),
    'browse/play_stream?pid=12345&url=https://tts.example.com/say.mp3',
  );
  assert.equal(
    buildPlayStreamCommand(12345, 'https://tts.example.com/say.mp3?token=abc&voice=fr'),
    'browse/play_stream?pid=12345&url=https://tts.example.com/say.mp3?token=abc&voice=fr',
  );
});

test('parseMessage: a get_players response, message and payload parsed', () => {
  const line = JSON.stringify({
    heos: { command: 'player/get_players', result: 'success', message: '' },
    payload: [{ name: 'Living Room', pid: 12345, ip: '192.168.1.50', model: 'AVR-S970H' }],
  });
  assert.deepEqual(parseMessage(line), {
    command: 'player/get_players',
    result: 'success',
    message: {},
    payload: [{ name: 'Living Room', pid: 12345, ip: '192.168.1.50', model: 'AVR-S970H' }],
  });
});

test('parseMessage: an event push, message parsed from its k=v&k=v form', () => {
  const line = JSON.stringify({
    heos: { command: 'event/player_state_changed', message: 'pid=12345&state=play' },
  });
  assert.deepEqual(parseMessage(line), {
    command: 'event/player_state_changed',
    result: undefined,
    message: { pid: '12345', state: 'play' },
    payload: undefined,
  });
});

test('parseMessage: malformed JSON or a non-HEOS shape returns null, never throws', () => {
  assert.equal(parseMessage('not json'), null);
  assert.equal(parseMessage(''), null);
  assert.equal(parseMessage('   '), null);
  assert.equal(parseMessage(JSON.stringify({ foo: 'bar' })), null);
  assert.equal(parseMessage(JSON.stringify({ heos: {} })), null);
});

test('findPlayerIdByIp: matches on the ip field, returns null when no match/empty/missing', () => {
  const payload = [
    { pid: 1, ip: '192.168.1.10' },
    { pid: 2, ip: '192.168.1.50' },
  ];
  assert.equal(findPlayerIdByIp(payload, '192.168.1.50'), 2);
  assert.equal(findPlayerIdByIp(payload, '10.0.0.1'), null);
  assert.equal(findPlayerIdByIp([], '192.168.1.50'), null);
  assert.equal(findPlayerIdByIp(undefined, '192.168.1.50'), null);
  assert.equal(findPlayerIdByIp(payload, undefined), null);
});

test('heosPlayStateToPlaybackState maps "play" to 1, everything else to 0', () => {
  assert.equal(heosPlayStateToPlaybackState('play'), 1);
  assert.equal(heosPlayStateToPlaybackState('pause'), 0);
  assert.equal(heosPlayStateToPlaybackState('stop'), 0);
  assert.equal(heosPlayStateToPlaybackState(undefined), 0);
});

test('HEOS_EVENT names match the exact strings HEOS pushes', () => {
  assert.equal(HEOS_EVENT.PLAYER_STATE_CHANGED, 'event/player_state_changed');
  assert.equal(HEOS_EVENT.PLAYER_NOW_PLAYING_CHANGED, 'event/player_now_playing_changed');
});

test('parseNowPlayingMedia: extracts title/artist from the song/artist payload fields', () => {
  assert.deepEqual(parseNowPlayingMedia({ song: 'Come Away With Me', artist: 'Norah Jones' }), {
    title: 'Come Away With Me',
    artist: 'Norah Jones',
  });
});

test('parseNowPlayingMedia: returns null for missing/empty payload (nothing playing)', () => {
  assert.equal(parseNowPlayingMedia(null), null);
  assert.equal(parseNowPlayingMedia(undefined), null);
  assert.equal(parseNowPlayingMedia({}), null);
  assert.equal(parseNowPlayingMedia({ song: '', artist: '' }), null);
  assert.equal(parseNowPlayingMedia('not an object'), null);
});

test('parseNowPlayingMedia: tolerates a title with no artist, or an artist with no title', () => {
  assert.deepEqual(parseNowPlayingMedia({ song: 'Some Station' }), {
    title: 'Some Station',
    artist: '',
  });
  assert.deepEqual(parseNowPlayingMedia({ artist: 'Norah Jones' }), {
    title: '',
    artist: 'Norah Jones',
  });
});

test("parseNowPlayingMedia: falls back to HEOS's own station field when the receiver reports no artist", () => {
  // Real-world case: an internet radio stream with no ICY/ID3 metadata —
  // `song` ends up holding a generic stream description, not a track, and
  // `artist` is empty; `station` is the only field carrying the actual
  // station name (matches what the receiver's own front display shows).
  assert.deepEqual(parseNowPlayingMedia({ song: '63 kbps aac', artist: '', station: 'Oui FM' }), {
    title: '63 kbps aac',
    artist: 'Oui FM',
  });
  // A real artist HEOS did report is never overwritten by the station name.
  assert.deepEqual(
    parseNowPlayingMedia({ song: 'Come Away With Me', artist: 'Norah Jones', station: 'Oui FM' }),
    { title: 'Come Away With Me', artist: 'Norah Jones' },
  );
  // station alone (no song/artist at all) still counts as "something playing".
  assert.deepEqual(parseNowPlayingMedia({ station: 'Oui FM' }), {
    title: '',
    artist: 'Oui FM',
  });
});
