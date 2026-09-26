'use strict';

/**
 * Container Foxy Proxy Importer — import/export page (opened in a TAB
 * by the toolbar icon). Parses every known FoxyProxy configuration
 * format, runs the import in the background context with live progress,
 * and exports the proxies assigned to containers into two FoxyProxy
 * config formats (legacy 6.x-7.5.1 and modern 8+/9+). The file picker
 * is safe here: a tab is not destroyed when the native file dialog
 * opens (unlike a popup — Firefox bug 1658694).
 *
 * The page adapts to the light/dark system theme AND to the theme
 * installed in Firefox (browser.theme.getCurrent / theme.onUpdated).
 */

/* ------------------------------------------------------------------ */
/* Localization helper                                                 */
/* ------------------------------------------------------------------ */

const message = (key) => browser.i18n.getMessage(key);

/* ------------------------------------------------------------------ */
/* Theme adaptation (system preference + installed Firefox theme)      */
/* ------------------------------------------------------------------ */

/**
 * Compute the relative luminance of a #rrggbb color.
 * @param {string} hex color like "#1b1533"
 * @returns {number} 0..1 (0 = darkest)
 */
const luminance = (hex) => {
  const value = hex.replace('#', '');
  if (value.length !== 6) return 0;
  const [r, g, b] = [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
};

/**
 * Pick a color: the first defined value from the theme, or a fallback.
 * @param {object|null} colors theme colors object (may be undefined)
 * @param {string[]} keys candidate theme color keys, in priority order
 * @param {string} fallback fallback color
 * @returns {string}
 */
const pickThemeColor = (colors, keys, fallback) => {
  for (const key of keys) {
    const value = colors?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
};

/**
 * Apply the colors of the currently installed Firefox theme on top of
 * the CSS custom properties. Light/dark palettes are selected by the
 * luminance of the theme frame color.
 * @param {object|null} theme Firefox theme object from theme.getCurrent()
 * @returns {void}
 */
const applyFirefoxTheme = (theme) => {
  const colors = theme?.colors ?? null;
  const root = document.documentElement.style;

  if (!colors) {
    // No theme colors: keep the prefers-color-scheme palette.
    return;
  }

  const frame = pickThemeColor(colors, ['frame', 'accentcolor', 'toolbar'], '#ffffff');
  const isDark = luminance(frame) < 0.5;

  // Page surfaces.
  root.setProperty('--page-background', pickThemeColor(
    colors,
    ['frame', 'accentcolor'],
    isDark ? '#1b1533' : '#f7f6fb',
  ));
  root.setProperty('--page-foreground', pickThemeColor(
    colors,
    ['frame_text', 'tab_text', 'toolbar_text', 'bookmark_text'],
    isDark ? '#f2f0fa' : '#241b4d',
  ));
  root.setProperty('--muted-foreground', pickThemeColor(
    colors,
    ['toolbar_field_text', 'tab_text', 'toolbar_text'],
    isDark ? '#b7aee0' : '#5b5480',
  ));

  // Accent color for the primary button.
  root.setProperty('--accent', pickThemeColor(
    colors,
    ['button_primary', 'toolbar', 'popup_highlight'],
    isDark ? '#5ad1ff' : '#2b6cb0',
  ));
  root.setProperty('--accent-contrast', pickThemeColor(
    colors,
    ['button_primary_hover' /* near enough as a contrast hint */, 'tab_background_text'],
    isDark ? '#1b1533' : '#ffffff',
  ));

  // Drop zone.
  const zoneBase = pickThemeColor(colors, ['toolbar_field', 'popup'], isDark ? 'rgba(90,209,255,0.04)' : 'rgba(43,108,176,0.06)');
  root.setProperty('--zone-background', zoneBase);
  root.setProperty('--zone-border', pickThemeColor(
    colors,
    ['toolbar_field_border', 'tab_line', 'toolbar_top_separator'],
    isDark ? '#5ad1ff' : '#2b6cb0',
  ));

  // Separators and status colors follow the chosen palette.
  root.setProperty('--secondary-border', isDark ? 'rgba(242,240,250,0.4)' : 'rgba(36,27,77,0.35)');
  root.setProperty('--separator', isDark ? 'rgba(255,255,255,0.08)' : 'rgba(36,27,77,0.12)');
  root.setProperty('--status-progress', isDark ? '#ffd15c' : '#8a6d00');
  root.setProperty('--status-error', isDark ? '#ff7b72' : '#c0392b');
  root.setProperty('--status-ok', isDark ? '#7ee787' : '#1e7e34');
};

/**
 * Load the current Firefox theme and apply it.
 * @returns {Promise<void>}
 */
const applyCurrentTheme = async () => {
  try {
    const theme = await browser.theme.getCurrent();
    applyFirefoxTheme(theme);
  } catch (error) {
    console.error('Container Foxy Proxy Importer: cannot read theme:', error);
  }
};

// React to Firefox theme changes in real time.
browser.theme.onUpdated.addListener(({ theme }) => applyFirefoxTheme(theme));

// React to system light/dark preference changes (when no theme colors
// override the palette). Re-applying the Firefox theme keeps priorities.
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyCurrentTheme);

// Apply the theme as early as possible.
applyCurrentTheme();

/* ------------------------------------------------------------------ */
/* Proxy type normalization (numeric legacy + string modern)           */
/* ------------------------------------------------------------------ */

// Numeric proxy types used by FoxyProxy 6.x-7.5.1 (per FoxyProxy's own
// migrate.js: 1=http, 2=https, 3=socks5, 4=socks4, 5=direct).
const FOXY_TYPE_NUMERIC = { 1: 'http', 2: 'https', 3: 'socks5', 4: 'socks4', 5: 'direct' };

// Reverse mapping for the legacy export: canonical type -> number.
const FOXY_TYPE_TO_NUMBER = {
  http: 1,
  https: 2,
  socks5: 3,
  socks4: 4,
  direct: 5,
};

// String proxy types (FoxyProxy 7.5+/8.x/9.x storage format, see the
// proxy templates in the current FoxyProxy browser-extension sources:
// migrate.js convert3()/convert7() and options-proxies.js).
const FOXY_TYPE_STRING = {
  http: 'http',
  https: 'https',
  ssl: 'https',
  socks: 'socks5',
  socks5: 'socks5',
  socks4: 'socks4',
  pac: 'pac',
  none: 'direct',
  direct: 'direct',
};

// Default ports, same as FoxyProxy.
const DEFAULT_PORTS = { http: 3128, https: 443, socks5: 1080, socks4: 1080 };

/**
 * Normalize a FoxyProxy proxy type (numeric or string) to a canonical
 * type. Unknown values become 'direct' (skipped later).
 * @param {*} raw
 * @returns {string}
 */
const normalizeType = (raw) => {
  if (raw === undefined || raw === null || raw === '') return 'direct';
  const key = String(raw).trim().toLowerCase();
  return FOXY_TYPE_STRING[key] ?? FOXY_TYPE_NUMERIC[raw] ?? FOXY_TYPE_NUMERIC[key] ?? 'direct';
};

/**
 * Normalize a single proxy record from ANY FoxyProxy format.
 * Records that cannot be assigned to a container (direct, pac, no host)
 * are returned with skip=true, so the user sees how many were skipped.
 * @param {object} raw
 * @returns {object} normalized proxy record
 */
const normalizeProxy = (raw) => {
  const entry = raw ?? {};
  const {
    address, hostname, server, host,
    port,
    username, password,
    title, name,
    cc, countryCode, country, city,
    proxyDns, proxyDNS, dnsThroughProxy,
    color,
  } = entry;

  const hostName = String(address ?? hostname ?? server ?? host ?? '').trim();
  const type = normalizeType(entry.proxyType ?? entry.type ?? entry.proxytype);

  if (!hostName || type === 'direct' || type === 'pac') {
    return { skip: true, type, host: hostName };
  }

  const numericPort = Number(port);
  const safePort = Number.isInteger(numericPort) && numericPort > 0
    ? numericPort
    : DEFAULT_PORTS[type];

  return {
    skip: false,
    type,
    host: hostName,
    port: safePort,
    username: username ? String(username) : '',
    password: password ? String(password) : '',
    title: String(title ?? name ?? `${hostName}:${safePort}`).trim(),
    cc: String(cc ?? countryCode ?? '').trim().toUpperCase(),
    country: String(country ?? '').trim(),
    city: String(city ?? '').trim(),
    proxyDNS: Boolean(proxyDns ?? proxyDNS ?? dnsThroughProxy ?? true),
    color: String(color ?? '').trim(),
  };
};

/* ------------------------------------------------------------------ */
/* Extracting proxy records from any FoxyProxy JSON structure          */
/* ------------------------------------------------------------------ */

/**
 * Extract raw proxy records from a parsed FoxyProxy JSON configuration.
 * Supported shapes (verified against the current FoxyProxy sources
 * (migrate.js) and real exports):
 *  1. modern 8.x/9.x:  { ..., data: [ {...}, ... ] }
 *  2. legacy 7.5.1:    { mode, proxySettings: [ {...} ] }
 *     or proxySettings as an object keyed by id
 *  3. legacy 6.x:      top-level object whose VALUES are proxy records
 *     (they contain address/hostname + type)
 *  4. plain array of proxy records
 * @param {object} parsed
 * @returns {object[]} array of raw records
 */
const extractRawRecords = (parsed) => {
  if (Array.isArray(parsed)) return parsed;

  const container = parsed?.data ?? parsed?.proxySettings ?? parsed?.proxies;
  if (Array.isArray(container)) return container;
  if (container && typeof container === 'object') return Object.values(container);

  // Legacy 6.x storage backup: proxy records are the top-level VALUES.
  if (parsed && typeof parsed === 'object') {
    const records = Object.values(parsed).filter(
      (value) => value && typeof value === 'object' && !Array.isArray(value)
        && (('address' in value) || ('hostname' in value)) && ('type' in value),
    );
    if (records.length > 0) return records;
  }

  return [];
};

/**
 * Extract the list of proxies from a FoxyProxy JSON text.
 * @param {string} text file contents
 * @returns {object[]} array of normalized proxy records
 */
const extractFoxyProxies = (text) => {
  const parsed = JSON.parse(text);
  return extractRawRecords(parsed).map(normalizeProxy);
};

/* ------------------------------------------------------------------ */
/* Legacy XML (FoxyProxy 4.x foxyproxy.xml)                             */
/* ------------------------------------------------------------------ */

/**
 * Parse a legacy foxyproxy.xml (FoxyProxy 4.x and earlier) via
 * DOMParser and return normalized proxy records.
 * @param {string} text XML file contents
 * @returns {object[]} array of normalized proxy records
 */
const extractFoxyXml = (text) => {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error(message('statusBadXml'));
  }

  const records = [];
  for (const proxy of doc.querySelectorAll('proxy')) {
    const manual = proxy.querySelector('manualconf');
    if (!manual) continue;

    const host = String(manual.getAttribute('host') ?? '').trim();
    const isSocks = manual.getAttribute('isSocks') === 'true';
    const socks = String(manual.getAttribute('socks') ?? '').toLowerCase();
    const type = isSocks
      ? (socks === 'socks4' ? 'socks4' : 'socks5')
      : (manual.getAttribute('ssl') === 'true' ? 'https' : 'http');

    records.push(normalizeProxy({
      host,
      port: manual.getAttribute('port'),
      username: manual.getAttribute('username') ?? '',
      password: manual.getAttribute('password') ?? '',
      title: proxy.getAttribute('name') ?? '',
      type,
      proxyDNS: true,
    }));
  }
  return records;
};

/* ------------------------------------------------------------------ */
/* Export: two FoxyProxy config formats                                */
/* ------------------------------------------------------------------ */

// Deterministic palette used when a proxy has no color from the import.
const EXPORT_COLORS = [
  '#0055e5', '#e6000b', '#409e00', '#c72100', '#b90000', '#875900',
  '#5b3d00', '#008287', '#9b0056', '#696969', '#0050ef', '#e60049',
];

/**
 * Pick a stable export color for a proxy. Priority: the hex code of the
 * CURRENT container color (reflects recolors made by the user), then
 * the color imported from FoxyProxy, then a deterministic palette.
 * @param {object} entry { proxy, container } pair from the background
 * @param {number} index position in the list
 * @returns {string} hex color like "#0055e5"
 */
const exportColor = ({ proxy, container }, index) => {
  if (container?.colorCode && /^#[0-9a-f]{3,8}$/i.test(container.colorCode)) {
    return container.colorCode;
  }
  if (proxy.color && /^#[0-9a-f]{3,8}$/i.test(proxy.color)) return proxy.color;
  return EXPORT_COLORS[index % EXPORT_COLORS.length];
};

/**
 * Export title: the CURRENT container name (reflects renames made by
 * the user or other extensions), falling back to the proxy title.
 * @param {object} entry { proxy, container } pair
 * @returns {string}
 */
const exportTitle = ({ proxy, container }) => String(container?.name ?? '').trim()
  || String(proxy.title ?? '').trim()
  || `${proxy.host}:${proxy.port}`;

/**
 * Generate a FoxyProxy-style unique id, the same way FoxyProxy
 * Standard 7.x does it (Utils.getUniqueId in src/scripts/utils.js):
 * a random base-36 fragment followed by the current timestamp.
 * @returns {string} unique storage key like "k20d21508277536715"
 */
const foxyUniqueId = () => `${Math.random().toString(36).substring(2, 9)}${Date.now()}`;

/**
 * Build the LEGACY FoxyProxy Standard (6.x-7.5.1) export file in the
 * exact shape of the real working legacy settings file provided by
 * the user. Verified against the FoxyProxy sources:
 *
 *  - FoxyProxy 7.x import (src/scripts/import.js in the
 *    firefox-extension repository): importJson -> save(result) stores
 *    the file AS-IS into browser.storage.local (only browserVersion /
 *    foxyProxyVersion / foxyProxyEdition are deleted first, sync
 *    selects the storage area) - no schema validation, so the file
 *    must simply look like a storage dump;
 *  - FoxyProxy 9.x "Import from older versions" (src/content/migrate.js
 *    Migrate.convert7): scans TOP-LEVEL values for records with
 *    "address"/"type", sorts them by "index", maps the numeric type
 *    (1=http, 2=https, 3=socks5, 4=socks4, 5=direct) and the numeric
 *    pattern type (1=wildcard, 2=regex), and copies whitePatterns to
 *    include / blackPatterns to exclude;
 *  - FoxyProxy 7.x Utils.getUniqueId() (src/scripts/utils.js):
 *    Math.random().toString(36).substring(7) + timestamp - hence the
 *    "k"-less id used as the storage key AND mirrored in the record's
 *    "id" field, exactly like the sample file.
 *
 * Layout per the sample file:
 *   { "mode": "disable", "sync": false,
 *     "logging": { "active": true, "maxSize": 500 },
 *     "<k-id>": { "title", "type" (number), "address", "port" (number),
 *        "username", "password", "cc", "color", "active", "proxyDNS",
 *        "whitePatterns": [ { "title": "all", "active", "pattern": "*",
 *          "type": 1, "protocols": 1 } ],
 *        "blackPatterns": [ 6 local-network wildcards ],
 *        "index", "id" }, ... }
 *
 * The white "all" catch-all pattern routes all traffic through the
 * proxy when it is selected; the blackPatterns wildcard entries keep
 * localhost, loopback and the RFC1918/link-local private ranges
 * direct - the same local bypass list as the modern export. The title
 * is the CURRENT container name, the color is the current container
 * color; the proxy data comes from the stored binding.
 * @param {object[]} entries { proxy, container } pairs assigned to containers
 * @returns {object} legacy FoxyProxy settings
 */
const buildLegacyExport = (entries) => {
  // Base format of the sample settings file: mode + logging.
  const settings = {
    mode: 'disable',
    sync: false,
    logging: {
      active: true,
      maxSize: 500,
    },
  };

  entries.forEach((entry, index) => {
    const { proxy } = entry;
    // Storage key AND the record's own "id" field, like the sample
    // file (harmless on import: FoxyProxy 7.x save() stores the file
    // as-is and FoxyProxy 9.x convert7 ignores the extra field).
    const id = `k${foxyUniqueId()}`;
    settings[id] = {
      title: exportTitle(entry),
      type: FOXY_TYPE_TO_NUMBER[proxy.type] ?? 1,
      address: proxy.host,
      port: proxy.port,
      username: proxy.username ?? '',
      password: proxy.password ?? '',
      cc: proxy.cc ?? '',
      color: exportColor(entry, index),
      active: true,
      proxyDNS: Boolean(proxy.proxyDNS ?? false),
      whitePatterns: [
        { title: 'all', active: true, pattern: '*', type: 1, protocols: 1 },
      ],
      blackPatterns: legacyBlackPatternsLocal(),
      index,
      id,
    };
  });

  return settings;
};

/**
 * Build the MODERN FoxyProxy (8+/9+) export file as a HYBRID settings
 * file that carries BOTH formats at once - the exact shape of the real
 * working settings file provided by the user. Verified against the
 * FoxyProxy 9.8 sources (main = v9.8 on GitHub):
 *
 *  - src/content/app.js: the full modern pref keys { mode, sync,
 *    autoBackup, passthrough, theme, container, commands, data };
 *    App.getPref() loads storage with a plain Object.assign(), so extra
 *    top-level keys are stored and ignored harmlessly;
 *  - src/content/options.js: the MAIN "Import" button does
 *    FS.import -> Object.assign(pref, data) -> Options.process() ->
 *    Proxies.process(pref) - it reads the modern pref keys only;
 *  - src/content/migrate.js Migrate.convert7(): "Import from older
 *    versions" scans TOP-LEVEL values for records with "address"/"type"
 *    and migrates exactly the legacy id-keyed records;
 *  - src/content/on-request.js: pref.container entries
 *    {"container-N": "hostname:port"} are mapped back to Firefox
 *    cookieStoreId ("container-N" -> "firefox-container-N") in
 *    OnRequest.init() and routed in OnRequest.process() BEFORE the
 *    global mode is even checked - the native FoxyProxy 9.x
 *    per-container routing this extension replicates.
 *
 * Each file contains:
 *  1. the full modern pref dump, with every pref.data record carrying
 *     the complete FoxyProxy 9.x proxy template (active, title, type,
 *     hostname, port string, username, password, cc, city, color, pac,
 *     pacString, proxyDNS, include, exclude, tabProxy) and the same
 *     local-network bypass data as the sample file (global "passthrough"
 *     list + per-proxy wildcard "exclude" patterns, empty "include");
 *  2. legacy 6.x-7.5.1 id-keyed records mirrored at the top level
 *     (index, active, title, color, numeric type, address, numeric
 *     port, username, password, cc, proxyDNS, whitePatterns with the
 *     "all" catch-all, blackPatterns with the same local bypasses,
 *     id) - so the SAME file also imports through FoxyProxy
 *     "Import from older versions" and FoxyProxy 6.x-7.5.1.
 *
 * "mode" is "disable" like in the sample file: FoxyProxy leaves the
 * global mode selection to the user (Options.check() would reset an
 * invalid "pattern" mode because "include" is empty, and Proxy.set()
 * would fall back to the first proxy - "disable" is the safe canonical
 * value), while the container bindings route the containers natively.
 * The title is the CURRENT container name, the color is the current
 * container color; the proxy data comes from the stored binding.
 * @param {object[]} entries { proxy, container, cookieStoreId } pairs
 * @returns {object} modern hybrid FoxyProxy settings
 */

// Global bypass list of the sample settings file: localhost, loopback
// and IPv6 loopback, the RFC1918 private ranges and the link-local
// range. Parsed by Pattern.getPassthrough() into wildcard regexes and
// CIDR ranges and checked FIRST in OnRequest.process() - before any
// container, pattern or single-proxy routing.
const MODERN_PASSTHROUGH = 'localhost, 127.0.0.1, ::1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16';

// Per-proxy exclude patterns of the sample settings file: wildcard
// entries for the same local hosts and private ranges. A fresh array
// per record so no two records share pattern objects.
const modernExcludeLocal = () => ([
  { type: 'wildcard', title: 'localhost', pattern: 'localhost', active: true },
  { type: 'wildcard', title: '127.0.0.1', pattern: '127.0.0.1', active: true },
  { type: 'wildcard', title: '::1', pattern: '::1', active: true },
  { type: 'wildcard', title: '10.*', pattern: '10.*', active: true },
  { type: 'wildcard', title: '172.16.*', pattern: '172.16.*', active: true },
  { type: 'wildcard', title: '192.168.*', pattern: '192.168.*', active: true },
]);

// Legacy mirror of the same bypass list for the 6.x-7.5.1 records:
// numeric pattern type (1 = wildcard) and protocols (1 = all), exactly
// like blackPatterns in the sample file.
const legacyBlackPatternsLocal = () => [
  { title: 'localhost', active: true, pattern: 'localhost', type: 1, protocols: 1 },
  { title: '127.0.0.1', active: true, pattern: '127.0.0.1', type: 1, protocols: 1 },
  { title: '::1', active: true, pattern: '::1', type: 1, protocols: 1 },
  { title: '10.*', active: true, pattern: '10.*', type: 1, protocols: 1 },
  { title: '172.16.*', active: true, pattern: '172.16.*', type: 1, protocols: 1 },
  { title: '192.168.*', active: true, pattern: '192.168.*', type: 1, protocols: 1 },
];

const buildModernExport = (entries) => {
  // Full modern pref dump - the exact key set of the FoxyProxy 9.x
  // default pref (src/content/app.js) that FS.export(pref) writes.
  const pref = {
    mode: 'disable',
    sync: false,
    autoBackup: false,
    passthrough: MODERN_PASSTHROUGH,
    theme: '',
    container: {},
    commands: {},
    data: [],
  };

  entries.forEach((entry, index) => {
    const { proxy, cookieStoreId } = entry;
    const title = exportTitle(entry);
    const color = exportColor(entry, index);
    const proxyDNS = Boolean(proxy.proxyDNS ?? false);

    // --- modern pref.data record (full FoxyProxy 9.x proxy template)
    pref.data.push({
      active: true,
      title,
      type: proxy.type,
      hostname: proxy.host,
      port: String(proxy.port),
      username: proxy.username ?? '',
      password: proxy.password ?? '',
      cc: proxy.cc ?? '',
      city: proxy.city ?? '',
      color,
      pac: '',
      pacString: '',
      proxyDNS,
      include: [],
      exclude: modernExcludeLocal(),
      tabProxy: [],
    });

    // --- native FoxyProxy 9.x container binding: pref.container keys
    // are the cookieStoreId without the leading "firefox-"
    // ("container-N" for "firefox-container-N"); OnRequest.init()
    // adds the prefix back when resolving the container proxy.
    if (cookieStoreId) {
      pref.container[String(cookieStoreId).replace(/^firefox-/, '')] = `${proxy.host}:${proxy.port}`;
    }

    // --- legacy 6.x-7.5.1 mirror record: top-level and id-keyed, with
    // the id both as the storage key and as the "id" field, exactly
    // like the sample file. Migrate.convert7() picks these records up
    // via "Import from older versions"; the numeric port matches the
    // legacy storage format.
    // "k" prefix like FoxyProxy's own Utils.getUniqueId() ids ("k1586...")
    const id = `k${foxyUniqueId()}`;
    pref[id] = {
      title,
      type: FOXY_TYPE_TO_NUMBER[proxy.type] ?? 1,
      address: proxy.host,
      port: Number(proxy.port) || 0,
      username: proxy.username ?? '',
      password: proxy.password ?? '',
      cc: proxy.cc ?? '',
      color,
      active: true,
      proxyDNS,
      whitePatterns: [
        { title: 'all', active: true, pattern: '*', type: 1, protocols: 1 },
      ],
      blackPatterns: legacyBlackPatternsLocal(),
      index,
      id,
    };
  });

  return pref;
};
/**
 * Run the export: read the proxies assigned to containers TOGETHER with
 * the CURRENT container state (name/color hex) from the background, so
 * renames and recolors made by the user or other extensions are
 * reflected in the exported FoxyProxy config. Then hand the JSON to
 * the BACKGROUND context, which performs downloads.download and owns
 * the blob-URL lifecycle — if this page is closed before the download
 * finishes, the background's top-level downloads.onChanged listener
 * still revokes the URL correctly.
 * @param {'legacy'|'modern'} format export format
 * @returns {Promise<void>}
 */
const exportProxies = async (format) => {
  const exportModernButton = document.getElementById('export-modern');
  const exportLegacyButton = document.getElementById('export-legacy');
  exportModernButton.disabled = true;
  exportLegacyButton.disabled = true;
  try {
    const response = await browser.runtime.sendMessage({ type: 'get-assigned-proxies' });
    if (response?.error) {
      throw new Error(response.error);
    }
    const entries = response?.entries ?? [];

    if (entries.length === 0) {
      showStatus(message('statusExportEmpty'), 'error');
      return;
    }

    const date = new Date().toISOString().slice(0, 10);
    const settings = format === 'legacy'
      ? buildLegacyExport(entries)
      : buildModernExport(entries);
    const filename = format === 'legacy'
      ? `foxyproxy-legacy-${date}.json`
      : `foxyproxy-settings-${date}.json`;

    // The background owns the download + blob URL cleanup (see
    // background.js: the page may be closed mid-download).
    const downloadResponse = await browser.runtime.sendMessage({
      type: 'export-download',
      text: JSON.stringify(settings, null, 2),
      filename,
    });
    if (downloadResponse?.error) {
      throw new Error(downloadResponse.error);
    }

    showStatus(message('statusExportDone').replace('%s', String(entries.length)), 'ok');
  } catch (error) {
    // The user cancelling the "Save as" dialog also lands here.
    const text = String(error?.message ?? error);
    if (/cancell/i.test(text)) {
      showStatus(message('statusExportCancelled'));
      return;
    }
    showStatus(message('statusError').replace('%s', text), 'error');
  } finally {
    exportModernButton.disabled = false;
    exportLegacyButton.disabled = false;
  }
};

/* ------------------------------------------------------------------ */
/* UI helpers                                                           */
/* ------------------------------------------------------------------ */

/**
 * Show a status message on the import/export page.
 * @param {string} text
 * @param {string} [tone=''] 'ok' | 'error' | ''
 */
const showStatus = (text, tone = '') => {
  const status = document.getElementById('status');
  status.textContent = text;
  status.className = `status${tone ? ` ${tone}` : ''}`;
};

/**
 * Render the import results as a list.
 * The hex color of each dot comes from the import result (returned by
 * the Firefox getSupportedColors API in the background).
 * @param {object[]} results
 */
const renderResults = (results) => {
  const list = document.getElementById('results');
  list.replaceChildren(...results.map(({ name, colorCode, proxy }) => {
    const item = document.createElement('li');

    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = colorCode ?? '#5ad1ff';

    const meta = document.createElement('div');
    meta.className = 'meta';
    const nameDiv = document.createElement('div');
    nameDiv.className = 'name';
    nameDiv.textContent = name;
    const proxyDiv = document.createElement('div');
    proxyDiv.className = 'proxy';
    proxyDiv.textContent = `${proxy.type.toUpperCase()} ${proxy.host}:${proxy.port}`;

    meta.append(nameDiv, proxyDiv);
    item.append(dot, meta);
    return item;
  }));
};

/* ------------------------------------------------------------------ */
/* Import                                                               */
/* ------------------------------------------------------------------ */

/**
 * Handle the selected FoxyProxy file: parse it and run the import.
 * All failures are shown in the status line — nothing fails silently.
 * @param {File} file
 */
const handleFileSelected = async (file) => {
  const selectButton = document.getElementById('select-file');
  selectButton.disabled = true;
  try {
    showStatus(message('statusReading').replace('%s', file.name));
    const text = await file.text();

    // JSON (modern 8.x/9.x and legacy 6.x-7.5.1) or legacy XML 4.x.
    const trimmed = text.trim();
    const proxies = trimmed.startsWith('<')
      ? extractFoxyXml(trimmed)
      : extractFoxyProxies(trimmed);

    const usable = proxies.filter((proxy) => !proxy.skip);
    const skipped = proxies.length - usable.length;

    if (proxies.length === 0) {
      showStatus(message('statusNoProxies'), 'error');
      return;
    }
    if (usable.length === 0) {
      showStatus(message('statusOnlySkipped').replace('%s', String(skipped)), 'error');
      return;
    }

    showStatus(message('statusFound')
      .replace('%1$s', String(usable.length))
      .replace('%2$s', String(skipped)));

    const response = await browser.runtime.sendMessage({
      type: 'import-foxyproxies',
      proxies,
    });

    // The background returns { error } instead of throwing.
    if (response && typeof response === 'object' && !Array.isArray(response) && response.error) {
      showStatus(message('statusError').replace('%s', response.error), 'error');
      return;
    }

    if (!response || typeof response !== 'object' || !Array.isArray(response.results)) {
      showStatus(message('statusUnavailable'), 'error');
      return;
    }

    renderResults(response.results);
    const done = message('statusDone').replace('%s', String(response.results.length));
    const skippedNote = response.skipped > 0
      ? ` ${message('statusSkipped').replace('%s', String(response.skipped))}`
      : '';
    showStatus(`${done}${skippedNote}`, 'ok');
  } catch (error) {
    showStatus(message('statusError').replace('%s', error?.message ?? error), 'error');
  } finally {
    selectButton.disabled = false;
  }
};

/* ------------------------------------------------------------------ */
/* Startup                                                              */
/* ------------------------------------------------------------------ */

document.getElementById('title').textContent = message('extensionName');
document.getElementById('hint').textContent = message('importHint');
document.getElementById('drop-hint').textContent = message('dropHint');
document.getElementById('export-title').textContent = message('exportTitle');
document.getElementById('export-hint').textContent = message('exportHint');

const fileInput = document.getElementById('file-input');
const selectButton = document.getElementById('select-file');
const dropZone = document.getElementById('drop-zone');
const exportModernButton = document.getElementById('export-modern');
const exportLegacyButton = document.getElementById('export-legacy');

selectButton.textContent = message('chooseFile');
exportModernButton.textContent = message('exportModern');
exportLegacyButton.textContent = message('exportLegacy');
showStatus(message('statusWaiting'));

// Live progress from the background: "Creating container i of N: name".
// Also handles two background notifications:
//  - "proxy-conflict": another extension or manual browser settings
//    control the proxy configuration → show/hide the warning banner;
//  - "containers-changed": a container was created/renamed/recolored/
//    removed (also by other extensions) → the export data is fresh.
browser.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'import-progress') {
    showStatus(message('statusCreating')
      .replace('%1$s', String(msg.current))
      .replace('%2$s', String(msg.total))
      .replace('%3$s', msg.name));
  }
  if (msg?.type === 'proxy-conflict') {
    const banner = document.getElementById('conflict-warning');
    if (msg.active) {
      banner.textContent = message('statusConflict').replace('%s', msg.reason ?? '');
      banner.hidden = false;
    } else {
      banner.hidden = true;
    }
  }
  if (msg?.type === 'containers-changed') {
    showStatus(message('statusContainersChanged'));
  }
  return undefined;
});

// On page load, ask the background for the current conflict state (the
// conflict may have appeared while the page was closed). Lightweight
// message: no container/config data is read for this.
browser.runtime.sendMessage({ type: 'get-conflict-state' }).then((response) => {
  if (response?.conflict) {
    const banner = document.getElementById('conflict-warning');
    banner.textContent = message('statusConflict')
      .replace('%s', response.reason || message('conflictGeneric'));
    banner.hidden = false;
  }
}).catch(() => {});

selectButton.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', async () => {
  const [file] = fileInput.files;
  if (file) {
    await handleFileSelected(file);
  }
  fileInput.value = '';
});

// Export buttons: each opens a "Save as" dialog in its format.
exportModernButton.addEventListener('click', () => exportProxies('modern'));
exportLegacyButton.addEventListener('click', () => exportProxies('legacy'));

// Drag & drop of a config file.
dropZone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropZone.classList.remove('dragover');
  const [file] = event.dataTransfer?.files ?? [];
  if (file) {
    await handleFileSelected(file);
  }
});