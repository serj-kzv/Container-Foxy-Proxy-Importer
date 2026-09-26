'use strict';

/**
 * Container Foxy Proxy Importer — background context (Firefox event
 * page). Creates containers and assigns a proxy to each container.
 * Mechanism — the official Firefox API: proxy.onRequest (keyed by
 * cookieStoreId) + webRequest.onAuthRequired (automatic proxy
 * authentication). Plain JS (ES2022), async/await, Airbnb style.
 *
 * v1.5.0: tracks the LIVE container state (contextualIdentities
 * onCreated/onUpdated/onRemoved) — renames/recolors made by the user or
 * other extensions never break the binding (the key is the stable
 * cookieStoreId) and are reflected in the export data. Also watches
 * browser.proxy.settings (BrowserSetting.onChange + get) and warns the
 * user when another extension or manual browser settings take over the
 * proxy configuration.
 *
 * IMPORTANT (event page rules): all listeners are registered
 * SYNCHRONOUSLY at the top level of the script. Nothing is awaited
 * before an addListener call, otherwise Firefox cannot wake the page
 * for these events and messages may be lost.
 */

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

// Storage key in browser.storage.local: cookieStoreId -> proxy.
const CONFIG_KEY = 'containerProxyConfig';

// Notification identifiers (reused so notifications replace each other).
const NOTE_START = 'container-proxy-importer-start';
const NOTE_DONE = 'container-proxy-importer-done';
const NOTE_ERROR = 'container-proxy-importer-error';

// URL of the import/export page opened in a tab by the toolbar icon.
const IMPORT_URL = browser.runtime.getURL('import.html');

// Notification id for proxy-control conflicts (other extensions or
// manually configured browser proxy settings).
const NOTE_CONFLICT = 'container-proxy-importer-conflict';

/* ------------------------------------------------------------------ */
/* Supported container colors and icons (Firefox 153+ APIs)            */
/* ------------------------------------------------------------------ */

let supportedColors = [];
let supportedIcons = [];

/**
 * Load the container colors and icons supported by this browser.
 * Firefox 153+ renamed two colors and introduced a new one, so the lists
 * are queried from the API instead of being hardcoded. The API also
 * provides the hex code of each color.
 * @returns {Promise<void>}
 */
const loadSupportedStyles = async () => {
  const [colors, icons] = await Promise.all([
    browser.contextualIdentities.getSupportedColors(),
    browser.contextualIdentities.getSupportedIcons(),
  ]);
  supportedColors = colors.map(({ color, colorCode }) => ({ color, colorCode }));
  supportedIcons = icons.map(({ icon }) => icon);
};

/* ------------------------------------------------------------------ */
/* Simple helpers: deterministic hash and container style picking      */
/* ------------------------------------------------------------------ */

/**
 * Simple deterministic string hash (djb2-like).
 * @param {string} value
 * @returns {number}
 */
const hashString = (value) => [...String(value)].reduce(
  (acc, char) => (acc * 31 + char.codePointAt(0)) % 0xFFFFFFFF,
  7,
);

/**
 * Automatically pick a container color from a seed string.
 * @param {string} seed
 * @returns {{ color: string, colorCode: string }}
 */
const pickContainerColor = (seed) => {
  const index = hashString(`${seed}::color`) % supportedColors.length;
  return supportedColors[index];
};

/**
 * Automatically pick a container icon from a seed string.
 * @param {string} seed
 * @returns {string} one of the Firefox container icons
 */
const pickContainerIcon = (seed) => {
  const index = hashString(`${seed}::icon`) % supportedIcons.length;
  return supportedIcons[index];
};

/**
 * Find a supported container color matching a FoxyProxy hex color.
 * @param {string} [hex] color from the FoxyProxy config, e.g. "#0055e5"
 * @returns {{ color: string, colorCode: string }|undefined} match or undefined
 */
const findSupportedColorByHex = (hex) => {
  if (!hex || typeof hex !== 'string') return undefined;
  const needle = hex.trim().toLowerCase();
  return supportedColors.find(({ colorCode }) => String(colorCode).toLowerCase() === needle);
};

/**
 * Full container style (color + icon + hex). The color is taken from the
 * FoxyProxy config when it matches a supported color, otherwise it is
 * picked deterministically.
 * @param {string} seed
 * @param {string} [foxyHex]
 * @returns {{ color: string, icon: string, colorCode: string }}
 */
const pickContainerStyle = (seed, foxyHex) => {
  const match = findSupportedColorByHex(foxyHex);
  const color = match ?? pickContainerColor(seed);
  return {
    color: color.color,
    colorCode: color.colorCode,
    icon: pickContainerIcon(seed),
  };
};

/* ------------------------------------------------------------------ */
/* Notifications: information messages about the import progress       */
/* ------------------------------------------------------------------ */

/**
 * Show a desktop notification. Silently ignored if the OS/browser
 * refuses it (notifications are informational only).
 * @param {string} id notification id
 * @param {string} messageText message body
 * @returns {Promise<void>}
 */
const notify = async (id, messageText) => {
  try {
    await browser.notifications.create(id, {
      type: 'basic',
      iconUrl: browser.runtime.getURL('icon.svg'),
      title: browser.i18n.getMessage('extensionName'),
      message: String(messageText),
    });
  } catch (error) {
    console.error(`Container Foxy Proxy Importer: notification failed: ${error?.message ?? error}`);
  }
};

/**
 * Send a progress message to the import/export page (if it is open).
 * Never throws: when the page is closed the message has no receiver.
 * @param {number} current 1-based index of the container being created
 * @param {number} total total number of proxies to import
 * @param {string} name container name
 * @param {object} proxy normalized proxy
 * @returns {Promise<void>}
 */
const sendProgress = async (current, total, name, proxy) => {
  try {
    await browser.runtime.sendMessage({
      type: 'import-progress',
      current,
      total,
      name,
      host: `${proxy.type.toUpperCase()} ${proxy.host}:${proxy.port}`,
    });
  } catch {
    // The import/export page is closed — notifications still inform the user.
  }
};

/* ------------------------------------------------------------------ */
/* Toolbar icon: open the import/export page directly (no popup step)  */
/* ------------------------------------------------------------------ */

/**
 * Open the import/export page in a new tab, or focus an already open one.
 * Runs on every toolbar icon click (the browser action has no popup,
 * so browserAction.onClicked fires).
 * @returns {Promise<void>}
 */
const openImportPage = async () => {
  const tabs = await browser.tabs.query({ url: `${IMPORT_URL}*` });
  if (tabs.length > 0) {
    // Reuse the existing import/export tab instead of opening a duplicate.
    await browser.tabs.update(tabs[0].id, { active: true });
    await browser.windows.update(tabs[0].windowId, { focused: true });
    return;
  }
  await browser.tabs.create({ url: IMPORT_URL });
};

/* ------------------------------------------------------------------ */
/* Container-to-proxy configuration storage                            */
/* ------------------------------------------------------------------ */

/**
 * Read the config (cookieStoreId -> proxy) from local storage.
 * @returns {Promise<object>}
 */
const readProxyConfig = async () => {
  const { [CONFIG_KEY]: config } = await browser.storage.local.get(CONFIG_KEY);
  return config ?? {};
};

/**
 * Write the config (cookieStoreId -> proxy) to local storage.
 * @param {object} config
 * @returns {Promise<void>}
 */
const writeProxyConfig = async (config) => {
  await browser.storage.local.set({ [CONFIG_KEY]: config });
};

/* ------------------------------------------------------------------ */
/* Live container state (name/color/icon changes tracked in real time)  */
/*                                                                     */
/* The proxy binding is keyed by cookieStoreId, which Firefox keeps     */
/* STABLE when the container is renamed or recolored (by the user or    */
/* by another extension): contextualIdentities.update() only changes   */
/* the displayed properties. So renames NEVER break proxy routing.     */
/* The live state map is used by the export feature so that exported   */
/* configs always reflect the CURRENT container names and colors.      */
/* ------------------------------------------------------------------ */

// cookieStoreId -> { name, color, icon } (current container state).
let containerMap = new Map();

/**
 * Reload the live container state map from the browser.
 * @returns {Promise<void>}
 */
const loadContainerMap = async () => {
  const identities = await browser.contextualIdentities.query({});
  containerMap = new Map(identities.map(({ cookieStoreId, name, color, icon }) => [
    cookieStoreId,
    { name, color, icon },
  ]));
};

/**
 * Tell the import/export page that the container list/state changed,
 * so the page can inform the user that exports use fresh data.
 * @returns {Promise<void>}
 */
const broadcastContainersChanged = async () => {
  try {
    await browser.runtime.sendMessage({ type: 'containers-changed' });
  } catch {
    // The import/export page is closed — nothing to notify.
  }
};

/**
 * Delete the proxy binding of a removed container. The cookieStoreId
 * no longer exists, so the binding cannot ever match a request again.
 * The container name comes from the onRemoved event (captured BEFORE
 * the container is deleted from the live map, otherwise the map lookup
 * would return undefined and the notification would show the raw
 * cookieStoreId instead of the human-readable name).
 * @param {string} cookieStoreId
 * @param {string} [removedName] container name from the onRemoved event
 * @returns {Promise<void>}
 */
const removeBinding = async (cookieStoreId, removedName) => {
  try {
    const config = await readProxyConfig();
    if (!(cookieStoreId in config)) return;
    const name = removedName
      ?? containerMap.get(cookieStoreId)?.name
      ?? cookieStoreId;
    delete config[cookieStoreId];
    await writeProxyConfig(config);
    await refreshProxyCache();
    notify(
      NOTE_DONE,
      browser.i18n.getMessage('notifyBindingRemoved').replace('%s', name),
    );
  } catch (error) {
    console.error(`Container Foxy Proxy Importer: cannot remove binding: ${error?.message ?? error}`);
  }
};

/**
 * Remove bindings whose containers no longer exist (cleanup on startup,
 * in case a container was removed while the event page was asleep).
 * @returns {Promise<void>}
 */
const removeStaleBindings = async () => {
  try {
    const config = await readProxyConfig();
    const stale = Object.keys(config).filter((cookieStoreId) => !containerMap.has(cookieStoreId));
    if (stale.length === 0) return;
    for (const cookieStoreId of stale) {
      delete config[cookieStoreId];
    }
    await writeProxyConfig(config);
    await refreshProxyCache();
  } catch (error) {
    console.error(`Container Foxy Proxy Importer: stale binding cleanup failed: ${error?.message ?? error}`);
  }
};

/* ------------------------------------------------------------------ */
/* Proxy settings conflict guard                                       */
/*                                                                     */
/* The WebExtensions API cannot BLOCK another extension from changing  */
/* proxy settings, and it cannot even detect another extension's       */
/* proxy.onRequest listener. What IS possible (and implemented here):   */
/*  - browser.proxy.settings.get() returns { value, levelOfControl,   */
/*    controlledBy } — "controlled_by_other_extensions" means another */
/*    extension owns the browser's proxy settings;                     */
/*  - proxy.settings.onChange (BrowserSetting.onChange) fires when     */
/*    the settings change, whatever the source is.                     */
/* On any conflict a desktop notification is shown and the              */
/* import/export page displays a persistent warning banner.            */
/* ------------------------------------------------------------------ */

// Whether a conflict is currently active, and its current reason key.
// The notification is shown only on a TRANSITION (no conflict ->
// conflict, or a changed reason) so repeated settings changes do not
// spam the user with identical notifications.
let conflictActive = false;
let lastConflictReason = '';

/**
 * Check who controls the browser's proxy settings and warn when the
 * control belongs to another extension or to manual browser settings.
 * @returns {Promise<void>}
 */
const checkProxyControl = async () => {
  let levelOfControl = 'controllable_by_this_extension';
  let proxyType = 'system';
  try {
    const settings = await browser.proxy.settings.get();
    levelOfControl = settings?.levelOfControl ?? levelOfControl;
    proxyType = settings?.value?.proxyType ?? proxyType;
  } catch (error) {
    console.error(`Container Foxy Proxy Importer: cannot read proxy settings: ${error?.message ?? error}`);
    return;
  }

  const otherExtension = levelOfControl === 'controlled_by_other_extensions';
  // Manual/autoConfig proxy settings override the {type:"direct"}
  // responses of proxy.onRequest (expected Firefox behavior, see
  // bug 1750572), so they must be surfaced to the user as well.
  const manualOverride = proxyType === 'manual' || proxyType === 'autoConfig';

  if (!otherExtension && !manualOverride) {
    conflictActive = false;
    lastConflictReason = '';
    try {
      await browser.runtime.sendMessage({ type: 'proxy-conflict', active: false });
    } catch {
      // The import/export page is closed.
    }
    return;
  }

  conflictActive = true;
  const reason = otherExtension
    ? browser.i18n.getMessage('conflictOtherExtension')
    : browser.i18n.getMessage('conflictManualSettings');

  // Notify only on a transition into a conflict or on a reason change.
  if (!lastConflictReason || lastConflictReason !== reason) {
    notify(NOTE_CONFLICT, browser.i18n.getMessage('notifyConflict').replace('%s', reason));
    lastConflictReason = reason;
  }
  try {
    await browser.runtime.sendMessage({ type: 'proxy-conflict', active: true, reason });
  } catch {
    // The import/export page is closed — the notification still fires.
  }
};

/* ------------------------------------------------------------------ */
/* Download manager: blob-URL lifecycle lives HERE, not in the page    */
/*                                                                     */
/* The import/export page can be closed while a "Save as" download is  */
/* still running — any listener or timer owned by the page would die   */
/* with it and the blob URL would never be revoked. Therefore the      */
/* export download is performed in THIS background context:            */
/*  - the page builds the JSON and sends it via an 'export-download'  */
/*    message;                                                          */
/*  - the blob is created here, downloads.download is called here;     */
/*  - the blob URL is revoked by the top-level downloads.onChanged    */
/*    listener below when the download reaches a final state          */
/*    (complete/interrupted) — this event wakes the event page, so    */
/*    the cleanup works even if the page was closed long ago.         */
/* Per bug 1271345 the URL must NOT be revoked right after            */
/* downloads.download — only after the final state.                   */
/* ------------------------------------------------------------------ */

// downloadId -> { blobUrl, timer } for every pending export download.
const pendingDownloads = new Map();

/**
 * Revoke a blob URL exactly once and drop the pending-download entry.
 * @param {number} downloadId
 * @returns {void}
 */
const finishPendingDownload = (downloadId) => {
  const entry = pendingDownloads.get(downloadId);
  if (!entry) return;
  pendingDownloads.delete(downloadId);
  clearTimeout(entry.timer);
  URL.revokeObjectURL(entry.blobUrl);
};

// Top-level listener (event page rules): fires for EVERY download in
// this browser, so it also wakes the suspended event page when an
// export download finishes — guaranteeing the blob URL cleanup.
browser.downloads.onChanged.addListener((delta) => {
  const state = delta?.state?.current;
  if (state === 'complete' || state === 'interrupted') {
    finishPendingDownload(delta.id);
  }
});

/**
 * Save the export JSON to a file through the browser "Save as" dialog.
 * The blob URL lifecycle is owned by the background context and is
 * cleaned up by the downloads.onChanged listener above (with a
 * fallback timer as a safety net for missed final states).
 * @param {string} text file contents (JSON string)
 * @param {string} filename suggested file name
 * @returns {Promise<void>}
 */
const saveFileWithDialog = async (text, filename) => {
  const blob = new Blob([text], { type: 'application/json' });
  const blobUrl = URL.createObjectURL(blob);

  let downloadId;
  try {
    // saveAs: true opens the "Save as" dialog with the suggested name.
    downloadId = await browser.downloads.download({
      url: blobUrl,
      filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (error) {
    // Download could not even start (or the user cancelled the
    // dialog): revoke the URL immediately, nothing else will.
    URL.revokeObjectURL(blobUrl);
    throw error;
  }

  // Safety net: revoke anyway after 10 minutes in case no final
  // state is ever observed for this download.
  const timer = setTimeout(() => finishPendingDownload(downloadId), 10 * 60 * 1000);
  pendingDownloads.set(downloadId, { blobUrl, timer });
};

/**
 * Build a container name from proxy data.
 * @param {object} proxy
 * @returns {string}
 */
const buildContainerName = ({ title, host, port, cc, country, city, type }) => {
  const place = cc || country || city;
  const label = title || `${host}:${port}`;
  const parts = [label, place, type.toUpperCase()].filter(Boolean);
  return parts.join(' · ').slice(0, 60);
};

/**
 * Build a unique container name: if a container with this name already
 * exists, a numeric suffix " (2)", " (3)", … is appended so a new
 * container can always be created (never reusing an existing one).
 * @param {string} name desired name
 * @param {Map<string, string>} byName existing names -> cookieStoreId
 * @returns {string} a name not present in byName
 */
const ensureUniqueName = (name, byName) => {
  if (!byName.has(name)) return name;
  const MAX = 1000;
  for (let counter = 2; counter < MAX; counter += 1) {
    const candidate = `${name} (${counter})`.slice(0, 60);
    if (!byName.has(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`.slice(0, 60);
};

/* ------------------------------------------------------------------ */
/* Import: create a container for every proxy                          */
/* ------------------------------------------------------------------ */

/**
 * Create containers for a list of normalized proxies and store the
 * assigned proxies. Sends progress messages to the import/export page
 * and desktop notifications about the import progress.
 * @param {object[]} proxies normalized proxies (see import.js parser)
 * @returns {Promise<{results: object[], skipped: number}>} import summary
 */
const importFoxyProxies = async (proxies) => {
  await loadSupportedStyles();

  const existing = await browser.contextualIdentities.query({});
  const byName = new Map(existing.map(({ name, cookieStoreId }) => [name, cookieStoreId]));
  const config = await readProxyConfig();
  const results = [];
  const skipped = proxies.filter((proxy) => proxy.skip).length;
  const toImport = proxies.filter((proxy) => !proxy.skip);

  notify(NOTE_START, browser.i18n.getMessage('notifyStart').replace('%s', String(toImport.length)));

  let current = 0;
  for (const proxy of toImport) {
    current += 1;
    const name = ensureUniqueName(buildContainerName(proxy), byName);
    await sendProgress(current, toImport.length, name, proxy);

    const { color, icon, colorCode } = pickContainerStyle(name, proxy.color);
    // eslint-disable-next-line no-await-in-loop
    const identity = await browser.contextualIdentities.create({ name, color, icon });
    const { cookieStoreId } = identity;
    byName.set(name, cookieStoreId);

    // Assign the proxy to the container: store the binding in the config.
    config[cookieStoreId] = proxy;
    results.push({ name, cookieStoreId, colorCode, proxy });
  }

  await writeProxyConfig(config);
  // Make sure the proxy handlers use the fresh config immediately.
  await refreshProxyCache();

  notify(
    NOTE_DONE,
    browser.i18n.getMessage('notifyDone')
      .replace('%1$s', String(results.length))
      .replace('%2$s', String(skipped)),
  );

  return { results, skipped };
};

/* ------------------------------------------------------------------ */
/* Proxy assignment: proxy.onRequest keyed by cookieStoreId            */
/* ------------------------------------------------------------------ */

let proxyCache = new Map();

/**
 * Saved promise of the last cache reload. Event handlers await it, so
 * the page never awaits storage BEFORE its listeners are registered.
 * @type {Promise<void>}
 */
let cacheReady = Promise.resolve();

/**
 * Reload the proxy config cache from storage.
 * @returns {Promise<void>}
 */
const refreshProxyCache = async () => {
  const config = await readProxyConfig();
  proxyCache = new Map(Object.entries(config));
};

/**
 * Start a cache reload without blocking the startup path.
 * @returns {Promise<void>}
 */
const scheduleCacheReload = () => {
  cacheReady = refreshProxyCache().catch((error) => {
    console.error(`Container Foxy Proxy Importer: cannot read config: ${error?.message ?? error}`);
  });
  return cacheReady;
};

/**
 * proxy.onRequest handler: return the proxy assigned to the container.
 * @param {object} details proxy.RequestDetails
 * @returns {object[]} array of proxy.ProxyInfo
 */
const handleProxyRequest = async (details) => {
  const { cookieStoreId } = details;
  if (!cookieStoreId?.startsWith('firefox-container-')) {
    return [{ type: 'direct' }];
  }

  // The cache may still be loading after an event page wakeup.
  await cacheReady;

  const config = proxyCache.get(cookieStoreId);
  if (!config) {
    return [{ type: 'direct' }];
  }

  const { type, host, port, proxyDNS } = config;
  const proxy = { type, host, port: Number(port) };
  if (type === 'socks5' || type === 'socks4') proxy.proxyDNS = Boolean(proxyDNS);
  return [proxy];
};

/**
 * webRequest.onAuthRequired handler: automatic proxy authentication
 * with the credentials from the container config. Firefox supports
 * Promise-returning blocking listeners.
 * @param {object} details
 * @returns {Promise<object>} BlockingResponse with authCredentials or {}
 */
const handleAuthRequired = async (details) => {
  const { isProxy, cookieStoreId } = details;
  if (!isProxy || !cookieStoreId) return {};

  // The cache may still be loading after an event page wakeup.
  await cacheReady;

  const { username = '', password = '' } = proxyCache.get(cookieStoreId) ?? {};
  if (!username) return {};

  return { authCredentials: { username, password } };
};

/**
 * runtime.onMessage handler: import command and export request from the
 * import/export page. Never throws: errors are returned as { error }
 * and a notification is shown, so nothing fails silently.
 *
 * Messages:
 *  - { type: 'import-foxyproxies', proxies } — run the import
 *  - { type: 'get-assigned-proxies' }       — list proxies assigned to
 *    containers merged with the CURRENT container state (for exports)
 *  - { type: 'get-conflict-state' }         — lightweight conflict flag
 *  - { type: 'export-download', text, filename } — save an export JSON
 *    through the "Save as" dialog (blob lifecycle owned here)
 * @param {object} message
 * @returns {Promise<object|null>}
 */
const handleMessage = async ({ type, proxies, text, filename }) => {
  if (type === 'get-conflict-state') {
    return { conflict: conflictActive, reason: lastConflictReason };
  }
  if (type === 'export-download') {
    try {
      if (typeof text !== 'string' || text.length === 0 || typeof filename !== 'string') {
        throw new Error('invalid export request');
      }
      await saveFileWithDialog(text, filename);
      return { ok: true };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }
  if (type === 'get-assigned-proxies') {
    try {
      // Always read the LIVE container state: renames/recolors made by
      // the user or other extensions must be reflected in the export.
      await loadContainerMap();
      // Resolve container color NAMES to hex codes for the export.
      await loadSupportedStyles();
      const config = await readProxyConfig();
      const entries = Object.entries(config)
        .filter(([cookieStoreId, proxy]) => !proxy.skip && containerMap.has(cookieStoreId))
        .map(([cookieStoreId, proxy]) => {
          const container = { ...containerMap.get(cookieStoreId) };
          const match = supportedColors.find(({ color }) => color === container.color);
          container.colorCode = match?.colorCode ?? '';
          return { cookieStoreId, proxy, container };
        });
      return { entries, conflict: conflictActive };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }
  if (type !== 'import-foxyproxies') return null;
  try {
    if (!Array.isArray(proxies) || proxies.length === 0) {
      throw new Error(browser.i18n.getMessage('statusNoProxies'));
    }
    return await importFoxyProxies(proxies);
  } catch (error) {
    console.error('Container Foxy Proxy Importer: import failed:', error);
    notify(NOTE_ERROR, browser.i18n.getMessage('notifyError').replace('%s', String(error?.message ?? error)));
    return { error: String(error?.message ?? error) };
  }
};

/* ------------------------------------------------------------------ */
/* Listener registration — MUST be synchronous, top-level.             */
/* ------------------------------------------------------------------ */

// Toolbar icon click opens the import/export page directly (no popup).
browser.browserAction.onClicked.addListener(openImportPage);

browser.proxy.onRequest.addListener(handleProxyRequest, { urls: ['<all_urls>'] });

browser.webRequest.onAuthRequired.addListener(
  handleAuthRequired,
  { urls: ['<all_urls>'] },
  ['blocking'],
);

browser.runtime.onMessage.addListener(handleMessage);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[CONFIG_KEY]) {
    scheduleCacheReload();
  }
});

// Container state tracking: keep the live map fresh so renames/recolors
// (from the browser UI or other container extensions) are reflected in
// the current binding display AND in the export data. The binding key
// is the stable cookieStoreId, so the proxy routing itself never breaks.
browser.contextualIdentities.onCreated.addListener(({ contextualIdentity }) => {
  const { cookieStoreId, name, color, icon } = contextualIdentity;
  containerMap.set(cookieStoreId, { name, color, icon });
  broadcastContainersChanged();
});

browser.contextualIdentities.onUpdated.addListener(({ contextualIdentity }) => {
  const { cookieStoreId, name, color, icon } = contextualIdentity;
  containerMap.set(cookieStoreId, { name, color, icon });
  broadcastContainersChanged();
});

browser.contextualIdentities.onRemoved.addListener(({ contextualIdentity }) => {
  // Capture the container name BEFORE deleting it from the live map —
  // the removal notification must show the human-readable name.
  const { cookieStoreId, name } = contextualIdentity;
  containerMap.delete(cookieStoreId);
  // The container is gone: its proxy binding can never match again.
  removeBinding(cookieStoreId, name);
  broadcastContainersChanged();
});

// Proxy settings conflict guard: warn when another extension takes
// control of the browser's proxy settings or a manual proxy config
// appears (manual settings override proxy.onRequest "direct" answers).
browser.proxy.settings.onChange.addListener(() => {
  checkProxyControl();
});

browser.proxy.onError.addListener((error) => {
  console.error(`Container Foxy Proxy Importer: proxy error: ${error?.message ?? error}`);
});

// Kick off the initial cache load WITHOUT blocking listener registration.
scheduleCacheReload();

// Initial container state load + stale binding cleanup + conflict check.
// All failures are logged, never fatal.
loadContainerMap()
  .then(removeStaleBindings)
  .then(() => checkProxyControl())
  .catch((error) => {
    console.error(`Container Foxy Proxy Importer: startup failed: ${error?.message ?? error}`);
  });