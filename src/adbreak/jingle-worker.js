// -----------------------------------------------------------------------------
// Runs findSharedJingle() (jingles.js) off the main thread: comparing six
// 160 s samples takes over a second of CPU on a PC, several on a Raspberry
// Pi — on the main thread, the HEOS/Telnet sessions and the Gladys
// connection would all stall meanwhile. In: the stored (encoded) samples.
// Out: findSharedJingle()'s result.
// -----------------------------------------------------------------------------

import { parentPort, workerData } from 'node:worker_threads';
import { decodeFrames } from './bands.js';
import { findSharedJingle } from './jingles.js';

const samples = workerData.samples.map((s) => ({ frames: decodeFrames(s), anchor: s.anchor }));
parentPort.postMessage(findSharedJingle(samples));
