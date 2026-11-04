// -----------------------------------------------------------------------------
// A deadline for one Gladys music command (browse, search, play, queue).
//
// Gladys waits 10 s for the answer of a music command, then shows its own
// "command timeout" and forgets it — while the integration would go on and
// might start the music seconds after the user saw a failure. So every music
// command runs under a deadline (timing.musicDeadlineMs, 8 s): each HEOS
// request made inside it (heos-session.js request()) waits at most what is
// left, a request reached after the deadline is never sent, and the step
// that acts (switching the zone on, queueing, playing) only starts when
// enough time is left for it (assertTimeLeft()). An abandoned command thus
// ends by its deadline and never blocks the requests queued after it.
//
// The deadline travels with the async context (AsyncLocalStorage): nothing
// to pass along. Outside a music command (a scene action, 60 s) there is
// none and nothing changes.
// -----------------------------------------------------------------------------

import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage();

/** The music command ran out of time: nothing was started (or the last request went unanswered). */
export class DeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/** The deadline of the current async context: `{ at, label }`, or undefined. */
export function currentDeadline() {
  return store.getStore();
}

/** Milliseconds left before the current deadline (Infinity without one). */
export function timeLeft(deadline = currentDeadline()) {
  return deadline ? deadline.at - Date.now() : Infinity;
}

/**
 * Run `fn` under a deadline `ms` from now — never later than an enclosing
 * one. `label` names what did not answer in the error ("HEOS", "Qobuz").
 */
export function runWithDeadline(ms, fn, label) {
  const outer = currentDeadline();
  const at = Math.min(Date.now() + ms, outer ? outer.at : Infinity);
  return store.run({ at, label: label ?? outer?.label ?? 'HEOS' }, fn);
}

/** The error of a deadline passed. */
export function deadlineError(deadline = currentDeadline(), what = '') {
  return new DeadlineError(
    `${deadline?.label ?? 'HEOS'} did not answer in time${what ? ` (${what})` : ''}: nothing was started. Try again, or use the "AVR: play from …" scene action, which waits up to 60 s`,
  );
}

/**
 * Throw a DeadlineError unless at least `reserveMs` are left — before an
 * action that must not start too late. No deadline: nothing to check.
 */
export function assertTimeLeft(reserveMs, what) {
  const deadline = currentDeadline();
  if (deadline && timeLeft(deadline) < reserveMs) {
    throw deadlineError(deadline, what);
  }
}
