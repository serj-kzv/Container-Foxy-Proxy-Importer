'use strict';

/**
 * Container Foxy Proxy Importer — background context (Firefox event
 * page). Creates containers and assigns a proxy to each container.
 * Mechanism — the official Firefox API: proxy.onRequest (keyed by
 * cookieStoreId) + webRequest.onAuthRequired (automatic proxy
 * authentication). Plain JS (ES2022), async/await, Airbnb style.
 *
 * v2.0.0: full container management. The config now stores, per
 * tracked container, a "control" flag ("Контролировать прокси"), and
 * two GLOBAL settings are stored as well:
 *  - dnsAlways: route DNS through the proxy for every proxy protocol
 *    that supports it (proxyDNS is only usable with "socks" (SOCKS5)
 *    and "socks4" — see MDN proxy.ProxyInfo and the Firefox source
 *    ProxyChannelFilter validation);
 *  - enableAll: master switch that turns the proxy on/off for ALL
 *    tracked containers at once.
 * The import/export page can now list every container (tracked and
 * untracked), edit proxy strings, rename, restyle (color/icon), add
 * and remove containers — everything through messages handled here.
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

// Storage key in browser.storage.local: global settings.
const SETTINGS_KEY = 'containerProxySettings';

// Default global settings: DNS through the proxy where supported
// (recommended) and the proxy enabled for all tracked containers.
const DEFAULT_SETTINGS = { dnsAlways: true, enableAll: true };

// Notification identifiers (reused so notifications replace each other).
const NOTE_START = 'container-proxy-importer-start';
const NOTE_DONE = 'container-proxy-importer-done';
const NOTE_ERROR = 'container-proxy-importer-error';

// URL of the import/export page opened in a tab by the toolbar icon.
const IMPORT_URL = browser.runtime.getURL('import.html');

// Notification id for proxy-control conflicts (other extensions or
// manually configured browser proxy settings).
const NOTE_CONFLICT = 'container-proxy-importer-conflict';

// Canonical proxy types accepted by the page/background (the FoxyProxy
// storage names). ProxyInfo on-the-wire names differ for SOCKS5:
// Firefox proxy.ProxyInfo accepts "http", "https", "socks", "socks4",
// "direct" (MDN proxy.ProxyInfo), so "socks5" is mapped to "socks".
const PROXY_TYPES = ['http', 'https', 'socks4', 'socks5'];
const PROXY_INFO_TYPE = { http: 'http', https: 'https', socks4: 'socks4', socks5: 'socks' };

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

/**
 * Perceptual color distance (weighted RGB euclidean distance — the
 * classic approximation of human perception, the same weighting as in
 * the W3C relative-luminance formula).
 * @param {string} hexA "#rrggbb"
 * @param {string} hexB "#rrggbb"
 * @returns {number}
 */
const colorDistance = (hexA, hexB) => {
  const parse = (hex) => [0, 2, 4].map((offset) => parseInt(hex.replace('#', '').slice(offset, offset + 2), 16));
  const [r1, g1, b1] = parse(hexA);
  const [r2, g2, b2] = parse(hexB);
  return Math.sqrt(
    0.2126 * (r1 - r2) ** 2 + 0.7152 * (g1 - g2) ** 2 + 0.0722 * (b1 - b2) ** 2,
  );
};

/**
 * Auto color: the supported color MOST DIFFERENT from the colors of all
 * other containers (maximizes the minimal distance to the colors in
 * use), so a human can always tell the containers apart. Ties are
 * resolved by the API order (deterministic result).
 * @param {string} [excludeStoreId] cookieStoreId to ignore (recoloring)
 * @returns {{ color: string, colorCode: string }}
 */
const pickDistinctColor = (excludeStoreId) => {
  // The color CURRENTLY used by this container is excluded, so
  // auto color ALWAYS produces a visible change.
  const currentColor = excludeStoreId ? containerMap.get(excludeStoreId)?.color : null;
  const inUse = [...containerMap.entries()]
    .filter(([id]) => id !== excludeStoreId)
    .map(([, container]) => container.color)
    .map((colorName) => supportedColors.find(({ color }) => color === colorName))
    .filter(Boolean)
    .map(({ colorCode }) => String(colorCode));
  const candidates = supportedColors.filter(({ color }) => color !== currentColor);
  const pool = candidates.length > 0 ? candidates : supportedColors;
  let best = pool[0];
  let bestScore = -1;
  for (const candidate of pool) {
    const score = inUse.length === 0
      ? 1
      : Math.min(...inUse.map((code) => colorDistance(String(candidate.colorCode), code)));
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
};

/**
 * Auto icon: an icon NOT used by any other container (the first unused
 * one in API order), falling back to a deterministic pick.
 * @param {string} [excludeStoreId] cookieStoreId to ignore
 * @returns {string} one of the Firefox container icons
 */
const pickDistinctIcon = (excludeStoreId) => {
  // The icon CURRENTLY used by this container is excluded, so
  // auto icon ALWAYS produces a visible change.
  const currentIcon = excludeStoreId ? containerMap.get(excludeStoreId)?.icon : null;
  const inUse = new Set([...containerMap.entries()]
    .filter(([id]) => id !== excludeStoreId)
    .map(([, container]) => container.icon));
  const unused = supportedIcons.find((icon) => !inUse.has(icon) && icon !== currentIcon);
  if (unused) return unused;
  const others = supportedIcons.filter((icon) => icon !== currentIcon);
  const pool = others.length > 0 ? others : supportedIcons;
  return pool[hashString(excludeStoreId ?? String(Date.now())) % pool.length];
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
/* Configuration storage: proxies + global settings                   */
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

/**
 * Read the global settings (dnsAlways, enableAll) from local storage.
 * @returns {Promise<{dnsAlways: boolean, enableAll: boolean}>}
 */
const readSettings = async () => {
  const { [SETTINGS_KEY]: settings } = await browser.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
};

/**
 * Write the global settings to local storage.
 * @param {object} settings { dnsAlways?, enableAll? }
 * @returns {Promise<void>}
 */
const writeSettings = async (settings) => {
  await browser.storage.local.set({ [SETTINGS_KEY]: settings });
};

/* ------------------------------------------------------------------ */
/* Proxy validation (shared with the page: the page validates the    */
/* "type:host:port" string, the background re-validates every value)  */
/* ------------------------------------------------------------------ */

/**
 * Validate and normalize a proxy object coming from the page.
 * The accepted host syntax: a DNS name (letters, digits, dots,
 * hyphens), an IPv4 address, or a bracketed IPv6 literal.
 * @param {object} proxy { type, host, port, ... }
 * @returns {object} normalized proxy record
 */
const normalizeProxyInput = (proxy) => {
  const entry = proxy ?? {};
  const type = String(entry.type ?? '').trim().toLowerCase();
  const host = String(entry.host ?? '').trim();
  const port = Number(entry.port);

  const typeOk = PROXY_TYPES.includes(type);
  const hostOk = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)$/.test(host);
  const portOk = Number.isInteger(port) && port > 0 && port <= 65535;

  return {
    skip: false,
    type: typeOk ? type : '',
    host: hostOk ? host : '',
    port: portOk ? port : 0,
    username: String(entry.username ?? ''),
    password: String(entry.password ?? ''),
    title: String(entry.title ?? ''),
    cc: String(entry.cc ?? ''),
    country: String(entry.country ?? ''),
    city: String(entry.city ?? ''),
    proxyDNS: Boolean(entry.proxyDNS),
    color: String(entry.color ?? ''),
    control: entry.control !== false,
    invalid: !(typeOk && hostOk && portOk),
  };
};

/**
 * Whether a stored proxy entry actually routes traffic: a valid
 * protocol, a valid host and a valid port. Invalid or empty entries
 * are served "direct" (the page shows the matching warning).
 * @param {object} proxy stored config entry
 * @returns {boolean}
 */
const isRoutableProxy = (proxy) => Boolean(
  proxy
  && PROXY_INFO_TYPE[proxy.type]
  && typeof proxy.host === 'string'
  && proxy.host.length > 0
  && Number.isInteger(Number(proxy.port))
  && Number(proxy.port) > 0
  && Number(proxy.port) <= 65535
  && !proxy.invalid,
);

/* ------------------------------------------------------------------ */
/* Live container state (name/color/icon changes tracked in real time)  */
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
 * so the page re-renders the container list.
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

/* ------------------------------------------------------------------ */
/* Container names                                                     */
/* ------------------------------------------------------------------ */

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
 * and desktop notifications about the import progress. Imported
 * containers are TRACKED with the "control proxy" flag ON.
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

    // Assign the proxy to the container: store the binding in the
    // config. control defaults to true (proxy enabled on import).
    config[cookieStoreId] = { ...proxy, control: proxy.control !== false };
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
let settingsCache = { ...DEFAULT_SETTINGS };

/**
 * Saved promise of the last cache reload. Event handlers await it, so
 * the page never awaits storage BEFORE its listeners are registered.
 * @type {Promise<void>}
 */
let cacheReady = Promise.resolve();

/**
 * Reload the proxy config + settings caches from storage.
 * @returns {Promise<void>}
 */
const refreshProxyCache = async () => {
  const [config, settings] = await Promise.all([readProxyConfig(), readSettings()]);
  proxyCache = new Map(Object.entries(config));
  settingsCache = settings;
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
 * Routing rules (in order):
 *  1. not a container tab, or the container is not tracked -> direct;
 *  2. the global "enableAll" switch is off -> direct (proxies disabled
 *     for ALL tracked containers);
 *  3. the container's "control" flag is off -> direct;
 *  4. the stored proxy is not routable (invalid input) -> direct;
 *  5. otherwise route through the proxy. proxyDNS is forced ON for
 *     SOCKS4/SOCKS5 when the global "dnsAlways" setting is checked
 *     (proxyDNS is only usable with "socks" and "socks4" — MDN
 *     proxy.ProxyInfo; for HTTP/HTTPS proxies the hostname is resolved
 *     by the proxy itself during CONNECT, so nothing is set there).
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
  // The MASTER switch acts here ONLY: unchecked, EVERY tracked
  // container is DIRECT whatever its own "Control proxy" flag.
  // Checked, each container follows its OWN per-container control
  // flag (the UI checkbox is fully functional and independent).
  if (!config || settingsCache.enableAll === false || config.control === false) {
    return [{ type: 'direct' }];
  }
  if (!isRoutableProxy(config)) {
    return [{ type: 'direct' }];
  }

  const infoType = PROXY_INFO_TYPE[config.type];
  const proxy = { type: infoType, host: config.host, port: Number(config.port) };
  if (infoType === 'socks' || infoType === 'socks4') {
    proxy.proxyDNS = settingsCache.dnsAlways === true ? true : Boolean(config.proxyDNS);
  }
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

/* ------------------------------------------------------------------ */
/* Container management (the import/export page sends messages)        */
/* ------------------------------------------------------------------ */

/**
 * Build the full container list for the page: EVERY Firefox container,
 * each with the tracked flag, its stored proxy (or null), the "control"
 * flag and the current hex color code.
 * @returns {Promise<object>} { identities, settings, supportedColors,
 *                              supportedIcons }
 */
const listContainers = async () => {
  await Promise.all([loadContainerMap(), loadSupportedStyles()]);
  const config = await readProxyConfig();
  const settings = await readSettings();

  const identities = [...containerMap.entries()].map(([cookieStoreId, container]) => {
    const entry = config[cookieStoreId] ?? null;
    const match = supportedColors.find(({ color }) => color === container.color);
    return {
      cookieStoreId,
      name: container.name,
      color: container.color,
      icon: container.icon,
      colorCode: match?.colorCode ?? '',
      tracked: Boolean(entry),
      control: entry ? entry.control !== false : false,
      invalid: entry ? !isRoutableProxy(entry) : false,
      proxy: entry
        ? {
          type: entry.type ?? '',
          host: entry.host ?? '',
          port: entry.port ?? 0,
          proxyDNS: entry.proxyDNS ?? false,
          username: entry.username ?? '',
          password: entry.password ?? '',
          title: entry.title ?? '',
        }
        : null,
    };
  });

  return {
    identities,
    settings,
    supportedColors,
    supportedIcons,
  };
};

/**
 * Store (or replace) the proxy of a tracked container. The proxy comes
 * from the page's "type:host:port" input, parsed by the page and
 * re-validated here. An empty proxy string clears the proxy.
 * @param {string} cookieStoreId
 * @param {object|null} proxy parsed proxy or null (empty)
 * @returns {Promise<object>} { ok: true }
 */
const setContainerProxy = async (cookieStoreId, proxy) => {
  if (!cookieStoreId || !containerMap.has(cookieStoreId)) {
    throw new Error('unknown container');
  }
  const config = await readProxyConfig();
  const previous = config[cookieStoreId] ?? { control: false };
  if (proxy === null) {
    // Empty input: keep the tracked container, clear the proxy.
    config[cookieStoreId] = { ...previous, host: '', port: 0, type: '', invalid: false };
  } else {
    const normalized = normalizeProxyInput(proxy);
    config[cookieStoreId] = {
      ...previous,
      ...normalized,
      username: normalized.username || previous.username || '',
      password: normalized.password || previous.password || '',
      title: normalized.title || previous.title || '',
      cc: normalized.cc || previous.cc || '',
      country: normalized.country || previous.country || '',
      city: normalized.city || previous.city || '',
      color: normalized.color || previous.color || '',
      proxyDNS: previous.proxyDNS ?? normalized.proxyDNS,
    };
  }
  await writeProxyConfig(config);
  await refreshProxyCache();
  return { ok: true };
};

/**
 * Turn the proxy control of a tracked container on/off. The container
 * stays tracked; with control off, its requests are served direct.
 * @param {string} cookieStoreId
 * @param {boolean} control
 * @returns {Promise<object>} { ok: true }
 */
const setContainerControl = async (cookieStoreId, control) => {
  const config = await readProxyConfig();
  if (!config[cookieStoreId]) throw new Error('unknown container');
  config[cookieStoreId] = { ...config[cookieStoreId], control: control !== false };
  await writeProxyConfig(config);
  await refreshProxyCache();
  return { ok: true };
};

/**
 * Add a new tracked container: empty proxy input, "control proxy"
 * checkbox unchecked, auto-distinct color and auto-generated icon.
 * @returns {Promise<object>} the new identity summary
 */
const addContainer = async () => {
  await Promise.all([loadSupportedStyles(), loadContainerMap()]);
  const byName = new Map([...containerMap.values()].map(({ name }) => [name, true]));
  const base = browser.i18n.getMessage('newContainerName') || 'Container';
  const name = ensureUniqueName(base, byName);

  const color = pickDistinctColor();
  const icon = pickDistinctIcon();
  const identity = await browser.contextualIdentities.create({ name, color: color.color, icon });
  const { cookieStoreId } = identity;

  // Tracked container with an EMPTY proxy and control OFF (per spec:
  // a new container starts with the "control proxy" checkbox off).
  const config = await readProxyConfig();
  config[cookieStoreId] = {
    skip: false,
    type: '',
    host: '',
    port: 0,
    username: '',
    password: '',
    title: '',
    cc: '',
    country: '',
    city: '',
    proxyDNS: true,
    color: '',
    control: false,
    invalid: false,
  };
  await writeProxyConfig(config);
  await refreshProxyCache();

  return {
    cookieStoreId,
    name,
    color: color.color,
    colorCode: color.colorCode,
    icon,
    tracked: true,
    control: false,
  };
};

/**
 * Remove a single container (tracked or untracked) and its binding.
 * @param {string} cookieStoreId
 * @returns {Promise<object>} { ok: true }
 */
const removeContainer = async (cookieStoreId) => {
  if (!containerMap.has(cookieStoreId)) {
    await loadContainerMap();
  }
  if (!containerMap.has(cookieStoreId)) throw new Error('unknown container');
  await browser.contextualIdentities.remove(cookieStoreId);
  // The onRemoved listener removes the binding and broadcasts the
  // change; nothing else to do here.
  return { ok: true };
};

/**
 * Remove EVERY Firefox container (tracked and untracked).
 * @returns {Promise<object>} { removed: number }
 */
const removeAllContainers = async () => {
  const identities = await browser.contextualIdentities.query({});
  let removed = 0;
  for (const { cookieStoreId } of identities) {
    // eslint-disable-next-line no-await-in-loop
    await browser.contextualIdentities.remove(cookieStoreId);
    removed += 1;
  }
  return { removed };
};

/**
 * Remove every container TRACKED by this extension (imported or added
 * through the page). Untracked containers are left untouched.
 * @returns {Promise<object>} { removed: number }
 */
const removeAllActiveContainers = async () => {
  const [identities, config] = await Promise.all([
    browser.contextualIdentities.query({}),
    readProxyConfig(),
  ]);
  let removed = 0;
  for (const { cookieStoreId } of identities) {
    if (!(cookieStoreId in config)) continue;
    // eslint-disable-next-line no-await-in-loop
    await browser.contextualIdentities.remove(cookieStoreId);
    removed += 1;
  }
  return { removed };
};

/**
 * Rename a container (any container — the cookieStoreId is stable, so
 * the proxy binding is not affected).
 * @param {string} cookieStoreId
 * @param {string} name
 * @returns {Promise<object>} { ok: true }
 */
const renameContainer = async (cookieStoreId, name) => {
  const clean = String(name ?? '').trim().slice(0, 60);
  if (!clean) throw new Error('empty name');
  await browser.contextualIdentities.update(cookieStoreId, { name: clean });
  return { ok: true };
};

/**
 * Change the color and/or icon of a container.
 * @param {string} cookieStoreId
 * @param {object} style { color?, icon? } — supported values only
 * @returns {Promise<object>} { ok: true }
 */
const restyleContainer = async (cookieStoreId, style) => {
  await loadSupportedStyles();
  const update = {};
  if (style?.color) {
    if (!supportedColors.some(({ color }) => color === style.color)) {
      throw new Error('unsupported color');
    }
    update.color = style.color;
  }
  if (style?.icon) {
    if (!supportedIcons.includes(style.icon)) {
      throw new Error('unsupported icon');
    }
    update.icon = style.icon;
  }
  if (Object.keys(update).length === 0) throw new Error('nothing to update');
  await browser.contextualIdentities.update(cookieStoreId, update);
  return { ok: true };
};

/**
 * Auto color for ONE container: the supported color most different
 * from the colors of all OTHER containers (human-distinguishable).
 * @param {string} cookieStoreId
 * @returns {Promise<object>} { color, colorCode }
 */
const autoColorContainer = async (cookieStoreId) => {
  await Promise.all([loadSupportedStyles(), loadContainerMap()]);
  const color = pickRotatedColor(cookieStoreId);
  await browser.contextualIdentities.update(cookieStoreId, { color: color.color });
  return { color: color.color, colorCode: color.colorCode };
};

/**
 * Auto icon for ONE container: an icon not used by any other container
 * (deterministic fallback when all icons are in use).
 * @param {string} cookieStoreId
 * @returns {Promise<object>} { icon }
 */
const autoIconContainer = async (cookieStoreId) => {
  await Promise.all([loadSupportedStyles(), loadContainerMap()]);
  const icon = pickRotatedIcon(cookieStoreId);
  await browser.contextualIdentities.update(cookieStoreId, { icon });
  return { icon };
};

/* ------------------------------------------------------------------ */
/* runtime.onMessage handler                                           */
/* ------------------------------------------------------------------ */

/**
 * Handle a message from the import/export page. Never throws: errors
 * are returned as { error } so nothing fails silently.
 *
 * Messages:
 *  - { type: 'import-foxyproxies', proxies }       — run the import
 *  - { type: 'get-assigned-proxies' }               — proxies assigned
 *    to containers merged with the CURRENT container state (exports)
 *  - { type: 'get-conflict-state' }                 — conflict flag
 *  - { type: 'export-download', text, filename }    — save export JSON
 *  - { type: 'list-containers' }                    — full page state
 *  - { type: 'set-proxy', cookieStoreId, proxy }    — edit a proxy
 *  - { type: 'set-dns', cookieStoreId, dnsThroughProxy } — per-container
 *    "DNS through proxy" flag (socks4/socks5 only)
 *  - { type: 'set-settings', settings }             — global switches
 *  - { type: 'add-container' }                      — add tracked one
 *  - { type: 'remove-container', cookieStoreId }    — remove one
 *  - { type: 'remove-all-containers' }              — remove all
 *  - { type: 'remove-active-containers' }           — remove tracked
 *  - { type: 'rename-container', cookieStoreId, name }
 *  - { type: 'restyle-container', cookieStoreId, style }
 *  - { type: 'auto-color', cookieStoreId } / { type: 'auto-icon', cookieStoreId }
 * @param {object} message
 * @returns {Promise<object|null>}
 */
const handleMessage = async (message) => {
  const { type } = message ?? {};
  try {
    if (type === 'get-conflict-state') {
      return { conflict: conflictActive, reason: lastConflictReason };
    }
    if (type === 'export-download') {
      const { text, filename } = message;
      if (typeof text !== 'string' || text.length === 0 || typeof filename !== 'string') {
        throw new Error('invalid export request');
      }
      await saveFileWithDialog(text, filename);
      return { ok: true };
    }
    if (type === 'get-assigned-proxies') {
      // Always read the LIVE container state: renames/recolors made by
      // the user or other extensions must be reflected in the export.
      await loadContainerMap();
      // Resolve container color NAMES to hex codes for the export.
      await loadSupportedStyles();
      const config = await readProxyConfig();
      const entries = Object.entries(config)
        .filter(([cookieStoreId, proxy]) => !proxy.skip
          && containerMap.has(cookieStoreId)
          && proxy.control !== false
          && isRoutableProxy(proxy))
        .map(([cookieStoreId, proxy]) => {
          const container = { ...containerMap.get(cookieStoreId) };
          const match = supportedColors.find(({ color }) => color === container.color);
          container.colorCode = match?.colorCode ?? '';
          return { cookieStoreId, proxy, container };
        });
      return { entries, conflict: conflictActive };
    }
    if (type === 'list-containers') {
      return await listContainers();
    }
    if (type === 'set-proxy') {
      return await setContainerProxy(message.cookieStoreId, message.proxy ?? null);
    }
    if (type === 'set-control') {
      return await setContainerControl(message.cookieStoreId, message.control !== false);
    }
    if (type === 'set-dns') {
      const config = await readProxyConfig();
      if (!config[message.cookieStoreId]) throw new Error('unknown container');
      config[message.cookieStoreId] = {
        ...config[message.cookieStoreId],
        proxyDNS: message.dnsThroughProxy !== false,
      };
      await writeProxyConfig(config);
      await refreshProxyCache();
      return { ok: true };
    }

    if (type === 'set-settings') {
      const current = await readSettings();
      const next = {
        dnsAlways: typeof message.settings?.dnsAlways === 'boolean'
          ? message.settings.dnsAlways
          : current.dnsAlways,
        enableAll: typeof message.settings?.enableAll === 'boolean'
          ? message.settings.enableAll
          : current.enableAll,
      };
      await writeSettings(next);
      await refreshProxyCache();
      return { ok: true, settings: next };
    }
    if (type === 'add-container') {
      return await addContainer();
    }
    if (type === 'remove-container') {
      return await removeContainer(message.cookieStoreId);
    }
    if (type === 'remove-all-containers') {
      return await removeAllContainers();
    }
    if (type === 'remove-active-containers') {
      return await removeAllActiveContainers();
    }
    if (type === 'rename-container') {
      return await renameContainer(message.cookieStoreId, message.name);
    }
    if (type === 'restyle-container') {
      return await restyleContainer(message.cookieStoreId, message.style);
    }
    if (type === 'auto-color') {
      return await autoColorContainer(message.cookieStoreId);
    }
    if (type === 'auto-icon') {
      return await autoIconContainer(message.cookieStoreId);
    }
    if (type !== 'import-foxyproxies') return null;
    const { proxies } = message;
    if (!Array.isArray(proxies) || proxies.length === 0) {
      throw new Error(browser.i18n.getMessage('statusNoProxies'));
    }
    return await importFoxyProxies(proxies);
  } catch (error) {
    console.error('Container Foxy Proxy Importer: message failed:', error);
    if (type === 'import-foxyproxies') {
      notify(NOTE_ERROR, browser.i18n.getMessage('notifyError').replace('%s', String(error?.message ?? error)));
    }
    return { error: String(error?.message ?? error) };
  }
};

/* ------------------------------------------------------------------ */
/* Listener registration — MUST be synchronous, top-level.             */
/* ------------------------------------------------------------------ */

// Toolbar icon click opens the import/export page directly (no popup).
browser.browserAction.onClicked.addListener(openImportPage);

/**
 * Rotation counters for the auto color / auto icon buttons. Every
 * click advances the counter, so consecutive clicks walk through the
 * FULL supported color/icon set: a prime stride (7919) is coprime
 * with every pool length below it, giving a complete cycle through
 * the whole set without repeats. The current color/icon is excluded,
 * so every click produces a VISIBLE change.
 */
const autoRotateCounters = new Map();

/**
 * Next rotation step for a key.
 * @param {string} key
 * @returns {number}
 */
const nextAutoRotate = (key) => {
  const step = (autoRotateCounters.get(key) ?? 0) + 1;
  autoRotateCounters.set(key, step);
  return step;
};

/**
 * Auto color for ONE container that CHANGES ON EVERY CLICK: walks the
 * whole supported color set (never the current color) in a
 * deterministic-but-varied order seeded by the container id.
 * @param {string} cookieStoreId
 * @returns {{ color: string, colorCode: string }}
 */
const pickRotatedColor = (cookieStoreId) => {
  const current = containerMap.get(cookieStoreId)?.color ?? null;
  const pool = supportedColors.filter(({ color }) => color !== current);
  const base = pool.length > 0 ? pool : supportedColors;
  const start = hashString(`${cookieStoreId}::auto-color`) % base.length;
  const step = nextAutoRotate(`color:${cookieStoreId}`);
  return base[(start + step * 7919) % base.length];
};

/**
 * Auto icon for ONE container that CHANGES ON EVERY CLICK: same
 * rotation over the full supported icon set (never the current icon).
 * @param {string} cookieStoreId
 * @returns {string}
 */
const pickRotatedIcon = (cookieStoreId) => {
  const current = containerMap.get(cookieStoreId)?.icon ?? null;
  const pool = supportedIcons.filter((icon) => icon !== current);
  const base = pool.length > 0 ? pool : supportedIcons;
  const start = hashString(`${cookieStoreId}::auto-icon`) % base.length;
  const step = nextAutoRotate(`icon:${cookieStoreId}`);
  return base[(start + step * 7919) % base.length];
};

browser.proxy.onRequest.addListener(handleProxyRequest, { urls: ['<all_urls>'] });

browser.webRequest.onAuthRequired.addListener(
  handleAuthRequired,
  { urls: ['<all_urls>'] },
  ['blocking'],
);

browser.runtime.onMessage.addListener(handleMessage);

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes[CONFIG_KEY] || changes[SETTINGS_KEY])) {
    scheduleCacheReload();
  }
});

// Container state tracking: keep the live map fresh so renames/recolors
// (from the browser UI or other container extensions) are reflected in
// the container list, the export data and the notifications. The
// binding key is the stable cookieStoreId, so the proxy routing itself
// never breaks. Every change also tells the page to re-render.
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