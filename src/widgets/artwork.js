// -----------------------------------------------------------------------------
// Cover art / station logo of the "Now playing" widget.
//
// Gladys never loads a third-party URL itself (spec §6): the content
// declares an image KEY, and the integration serves the bytes on demand
// (onWidgetGetImage) as raw base64 — PNG, JPEG or WebP, at most 300 KB and
// 4096 px, refused (never recompressed) otherwise. So the HEOS `image_url`
// is downloaded here, checked with the SDK's own validateWidgetImage(), and
// only then declared in the content; an image that does not fit is simply
// left out (no resizing dependency in this image). The core caches an image
// one hour by key, so the key is derived from the URL: a new track, a new
// key.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { createLogger, validateWidgetImage } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'widgets' });

const MAX_IMAGE_BYTES = 300 * 1024;
const DEFAULT_MAX_ENTRIES = 20;
const DEFAULT_TIMEOUT_MS = 8_000;

/** The image key of one artwork URL (^[a-z0-9][a-z0-9-]{0,63}$). */
export function artworkKey(url) {
  return `cover-${createHash('sha1').update(url).digest('hex').slice(0, 24)}`;
}

/**
 * A small LRU of downloaded artworks, by key. `prepare(url)` resolves the
 * key once the image is ready to serve, or null when it cannot be (failure
 * remembered too, so a too-large cover is not re-downloaded on every pull).
 */
export function createArtworkCache({
  fetchFn = fetch,
  maxEntries = DEFAULT_MAX_ENTRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const entries = new Map(); // key -> base64 | null
  const inFlight = new Map(); // key -> Promise<key|null>

  function remember(key, value) {
    entries.delete(key);
    entries.set(key, value);
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value);
    }
  }

  async function download(url) {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const announced = Number(response.headers?.get?.('content-length'));
    if (announced > MAX_IMAGE_BYTES) {
      throw new Error(`${Math.ceil(announced / 1024)} KB, above the 300 KB Gladys accepts`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const base64 = bytes.toString('base64');
    const issues = validateWidgetImage(base64);
    if (issues.length > 0) {
      throw new Error(issues.join('; '));
    }
    return base64;
  }

  return {
    prepare(url) {
      if (!url) {
        return Promise.resolve(null);
      }
      const key = artworkKey(url);
      if (entries.has(key)) {
        remember(key, entries.get(key));
        return Promise.resolve(entries.get(key) === null ? null : key);
      }
      if (!inFlight.has(key)) {
        inFlight.set(
          key,
          download(url)
            .then((base64) => {
              remember(key, base64);
              return key;
            })
            .catch((err) => {
              logger.info(`Artwork left out of the widget (${url}): ${err.message}`);
              remember(key, null);
              return null;
            })
            .finally(() => inFlight.delete(key)),
        );
      }
      return inFlight.get(key);
    },
    /** The raw base64 of a prepared key, or undefined. */
    get(key) {
      return entries.get(key) ?? undefined;
    },
  };
}
