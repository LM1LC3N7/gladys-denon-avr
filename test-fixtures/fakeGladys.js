// -----------------------------------------------------------------------------
// Minimal in-memory stand-in for the Gladys SDK object, for unit tests.
//
// It reproduces the only surface the device modules rely on:
//   - externalIds(type, platformId) -> { device, feature(key) }
//   - publishState / publishStates   -> record calls so tests can assert them
//   - publishCameraImage             -> record calls so tests can assert them
//   - publishTransports              -> record calls so tests can assert them
//   - setConnectionStatus            -> record calls so tests can assert them
//   - publishSceneEvent              -> record calls so tests can assert them
//   - onSceneAction / onWidgetGet / onWidgetGetImage / onWidgetAction
//                                    -> keep the handlers in `handlers`
//   - requestWidgetRefresh           -> record the widget keys nudged
//   - artworkKey / publishNowPlaying -> SDK-shaped key, calls recorded
//   - onMusic*                       -> keep the handlers in `handlers.music`
// This lets us test the pure "wiring" logic (discovery payloads, dispatch)
// without a running Gladys server or a real WebSocket.
// -----------------------------------------------------------------------------

export function createFakeGladys() {
  const published = [];
  const cameraImages = [];
  const transports = [];
  const connectionStatuses = [];
  const sceneEvents = [];
  const widgetRefreshes = [];
  const nowPlaying = [];
  const handlers = {
    sceneActions: {},
    widgetGet: {},
    widgetAction: {},
    widgetGetImage: null,
    music: {},
  };

  return {
    published,
    cameraImages,
    transports,
    connectionStatuses,
    sceneEvents,
    widgetRefreshes,
    nowPlaying,
    handlers,

    externalIds(type, platformId) {
      const device = `${type}:${platformId}`;
      return {
        device,
        feature: (key) => `${device}:${key}`,
      };
    },

    async publishState(featureExternalId, state) {
      published.push({ featureExternalId, state });
    },

    async publishStates(states) {
      for (const s of states) {
        published.push({ featureExternalId: s.device_feature_external_id, state: s.state });
      }
    },

    async publishCameraImage(deviceExternalId, image) {
      cameraImages.push({ deviceExternalId, image });
    },

    async publishTransports(entries) {
      transports.push(...entries);
    },

    async setConnectionStatus(connected, message) {
      connectionStatuses.push({ connected, message });
    },

    async publishSceneEvent(key, data) {
      sceneEvents.push({ key, data });
      return { success: true };
    },

    onSceneAction(key, callback) {
      handlers.sceneActions[key] = callback;
    },

    onWidgetGet(key, callback) {
      handlers.widgetGet[key] = callback;
    },

    onWidgetAction(key, callback) {
      handlers.widgetAction[key] = callback;
    },

    onWidgetGetImage(callback) {
      handlers.widgetGetImage = callback;
    },

    requestWidgetRefresh(key) {
      widgetRefreshes.push(key);
    },

    // Music players: the SDK's artworkKey shape (`art-` + 12 hex), the
    // now-playing calls recorded, the handlers kept.
    artworkKey(url) {
      let hash = 0;
      for (const char of String(url)) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      }
      return `art-${hash.toString(16).padStart(12, '0').slice(-12)}`;
    },

    async publishNowPlaying(deviceExternalId, values, options) {
      nowPlaying.push({ deviceExternalId, values, options });
      return { success: true };
    },

    onMusicBrowse(callback) {
      handlers.music.browse = callback;
    },
    onMusicSearch(callback) {
      handlers.music.search = callback;
    },
    onMusicPlay(callback) {
      handlers.music.play = callback;
    },
    onMusicQueueGet(callback) {
      handlers.music.queueGet = callback;
    },
    onMusicQueuePlay(callback) {
      handlers.music.queuePlay = callback;
    },
  };
}
