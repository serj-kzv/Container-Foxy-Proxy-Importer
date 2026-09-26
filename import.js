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
 * v2.0.0: the page also manages EVERY Firefox container — tracked
 * (controlled by this extension) and untracked. Tracked containers
 * have an editable "protocol:host:port" proxy field with round
 * protocol selectors and live validation; every container can be
 * renamed, restyled (color/icon, with auto generation), and removed.
 * Everything saves seamlessly — no "save" buttons. The design is
 * MONOCHROME (white/black/grays, no rounded corners, no shadows).
 */

/* ------------------------------------------------------------------ */
/* Localization helper                                                 */
/* ------------------------------------------------------------------ */

const message = (key) => browser.i18n.getMessage(key);

/* ------------------------------------------------------------------ */
/* Theme adaptation (monochrome only)                                  */
/*                                                                     */
/* The installed Firefox theme is still honored (a v1.x feature), but  */
/* the palette is derived ONLY from the theme luminance and contains  */
/* nothing but white, black and shades of gray — the page stays       */
/* monochrome in every theme, light or dark.                           */
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
 * Apply the installed Firefox theme as a MONOCHROME palette: only the
 * lightness of the theme frame decides between the light-gray and the
 * dark-gray palette; no theme color is ever copied into the page.
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

  const gray = (darkValue, lightValue) => (isDark ? darkValue : lightValue);

  // Page surfaces: pure grayscale.
  root.setProperty('--page-background', gray('#1a1a1a', '#ffffff'));
  root.setProperty('--page-foreground', gray('#f2f2f2', '#000000'));
  root.setProperty('--muted-foreground', gray('#b4b4b4', '#555555'));
  root.setProperty('--faint-foreground', gray('#8f8f8f', '#777777'));
  root.setProperty('--surface', gray('#242424', '#f2f2f2'));
  root.setProperty('--surface-strong', gray('#333333', '#e6e6e6'));
  root.setProperty('--border', gray('#f2f2f2', '#000000'));
  root.setProperty('--border-soft', gray('#6e6e6e', '#999999'));
  root.setProperty('--separator', gray('#3d3d3d', '#d4d4d4'));
  root.setProperty('--accent', gray('#f2f2f2', '#000000'));
  root.setProperty('--accent-contrast', gray('#000000', '#ffffff'));
  root.setProperty('--invalid', gray('#f2f2f2', '#000000'));
  root.setProperty('--status-ok', gray('#d4d4d4', '#333333'));
  root.setProperty('--status-error', gray('#f2f2f2', '#000000'));
  root.setProperty('--status-progress', gray('#b4b4b4', '#555555'));
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
 * the blob-URL lifecycle  if this page is closed before the download
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
 * All failures are shown in the status line  nothing fails silently.
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
/* Container management state + helpers                                */
/* ------------------------------------------------------------------ */

// The full page state from the background: identities (EVERY Firefox
// container, tracked and untracked), global settings and the supported
// colors/icons of this browser.
let pageState = { identities: [], settings: {}, supportedColors: [], supportedIcons: [] };

// Proxy protocols shown as round selectors (FoxyProxy storage names;
// the background maps socks5 -> "socks" for the ProxyInfo wire format).
const PROTOCOLS = ['http', 'https', 'socks4', 'socks5'];

// Host syntax accepted in the "protocol:host:port" input: DNS name,
// IPv4 address or bracketed IPv6 literal (same rule as background.js).
const HOST_PATTERN = /^(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9._-]+)$/;

// Focused editing guard: while the user types inside the container
// list, incoming "containers-changed" broadcasts (including the ones
// caused by this page's own seamless saves) do NOT re-render the
// list — otherwise the input would lose focus on every keystroke.
const isEditingContainerList = () => {
  const active = document.activeElement;
  return Boolean(active && document.getElementById('containers').contains(active));
};

/**
 * Parse the "protocol:host:port" input value.
 * @param {string} text raw input value
 * @returns {{ok: boolean, proxy: object|null}} parsed proxy or error
 */
const parseProxyString = (text) => {
  const raw = String(text ?? '').trim();
  if (raw === '') return { ok: true, proxy: null };
  const match = raw.match(/^(http|https|socks4|socks5):([^:]+):([0-9]{1,5})$/i);
  if (!match) return { ok: false, proxy: null };
  const [, type, host, port] = match;
  const portNumber = Number(port);
  if (!HOST_PATTERN.test(host) || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return { ok: false, proxy: null };
  }
  return {
    ok: true,
    proxy: {
      type: type.toLowerCase(),
      host,
      port: portNumber,
      username: '',
      password: '',
      title: '',
    },
  };
};

/**
 * Format a stored proxy as the "protocol:host:port" input value.
 * @param {object|null} proxy stored proxy (or null)
 * @returns {string} "http:1.2.3.4:8080" or "" when empty
 */
const formatProxyString = (proxy) => {
  if (!proxy || !proxy.host || !proxy.port) return '';
  return `${proxy.type}:${proxy.host}:${proxy.port}`;
};

/**
 * Send a message to the background and show the error in the status
 * line when the answer carries { error }.
 * @param {object} payload message payload
 * @returns {Promise<object|null>} answer or null on error
 */
const sendBackground = async (payload) => {
  try {
    const response = await browser.runtime.sendMessage(payload);
    if (response && typeof response === 'object' && response.error) {
      showStatus(message('statusError').replace('%s', response.error), 'error');
      return null;
    }
    return response;
  } catch (error) {
    showStatus(message('statusError').replace('%s', error?.message ?? error), 'error');
    return null;
  }
};

/**
 * Debounce helper for seamless (automatic) saves.
 * @param {Function} fn async action
 * @param {number} delay milliseconds
 * @returns {Function} debounced function
 */
const debounce = (fn, delay = 500) => {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { fn(...args); }, delay);
  };
};

/* ------------------------------------------------------------------ */
/* Container list rendering                                            */
/* ------------------------------------------------------------------ */

/**
 * Build the protocol selector group: round radio inputs for every
 * protocol; picking one rewrites the protocol part of the proxy input.
 * @param {object} identity container identity from the background
 * @param {HTMLInputElement} proxyInput the "protocol:host:port" input
 * @returns {HTMLDivElement} the .protocols element
 */
/**
 * Weighted RGB distance between two hex colors (the same perceptual
 * weighting the background uses for auto color).
 * @param {string} hexA "#rrggbb"
 * @param {string} hexB "#rrggbb"
 * @returns {number}
 */
const hexDistance = (hexA, hexB) => {
  const parse = (hex) => [0, 2, 4].map(
    (offset) => parseInt(hex.replace('#', '').slice(offset, offset + 2), 16),
  );
  const [r1, g1, b1] = parse(hexA);
  const [r2, g2, b2] = parse(hexB);
  return Math.sqrt(
    0.2126 * (r1 - r2) ** 2 + 0.7152 * (g1 - g2) ** 2 + 0.0722 * (b1 - b2) ** 2,
  );
};

/**
 * Map ANY hex color from the full color picker to the SUPPORTED
 * Firefox container color closest to it (Firefox accepts only the
 * colors returned by getSupportedColors — MDN
 * contextualIdentities.getSupportedColors — so the freely picked
 * color is applied as its nearest supported equivalent).
 * @param {string} hex any "#rrggbb"
 * @returns {{ color: string, colorCode: string }} nearest supported color
 */
const nearestSupportedColor = (hex) => {
  let best = pageState.supportedColors[0];
  let bestScore = Infinity;
  for (const candidate of pageState.supportedColors) {
    const score = hexDistance(hex, String(candidate.colorCode));
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
};

/**
 * Update the visible style (color dot, icon badge, picker value) of a
 * rendered container row IN PLACE — immediately, so the user sees the
 * applied color/icon the moment auto generation or picking completes.
 * @param {HTMLElement} item the <li> of the container
 * @param {string} colorCode hex color code
 * @param {string} icon icon name
 * @returns {void}
 */
const updateRowStyle = (item, colorCode, icon) => {
  const dot = item.querySelector('.row-name .dot');
  if (dot && colorCode) dot.style.background = colorCode;
  const badge = item.querySelector('.row-name .icon-label');
  if (badge && icon) badge.textContent = icon;
  const picker = item.querySelector('.style-row input[type="color"]');
  if (picker && colorCode) picker.value = colorCode;
};

/**
 * Build the protocol selector group: round radio inputs for every
 * protocol; picking one rewrites the protocol part of the proxy input
 * and enables/disables the per-container DNS switch (proxyDNS is only
 * usable with socks4/socks5 — MDN proxy.ProxyInfo).
 * @param {object} identity container identity from the background
 * @param {HTMLInputElement} proxyInput the "protocol:host:port" input
 * @param {Function} onProtocolChange called with the new protocol
 * @returns {HTMLDivElement} the .protocols element
 */
const buildProtocolSelector = (identity, proxyInput, onProtocolChange) => {
  const group = document.createElement('div');
  group.className = 'protocols';

  const current = identity.proxy?.type ?? 'http';

  /**
   * Sync the round protocol radios with the protocol typed/pasted at
   * the start of the "protocol:host:port" proxy field. The radios and
   * the text field never disagree: typing "socks5:host:port" checks
   * the socks5 radio automatically.
   * @param {string} [protocol] protocol to select; empty clears all
   */
  const syncRadios = (protocol = '') => {
    for (const radio of group.querySelectorAll('input[type="radio"]')) {
      radio.checked = radio.value === protocol;
    }
  };

  for (const protocol of PROTOCOLS) {
    const label = document.createElement('label');
    label.className = 'protocol';

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = `protocol-${identity.cookieStoreId}`;
    radio.value = protocol;
    radio.checked = protocol === current;
    // Round checkbox (radio): switching the protocol rewrites the
    // "protocol:host:port" string in place, keeping host:port intact,
    // and re-evaluates the per-container DNS switch availability.
    radio.addEventListener('change', () => {
      if (!radio.checked) return;
      const raw = proxyInput.value.trim();
      const rest = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : '';
      proxyInput.value = `${protocol}:${rest}`;
      proxyInput.dispatchEvent(new Event('input', { bubbles: true }));
      onProtocolChange(protocol);
    });

    const text = document.createElement('span');
    text.textContent = protocol;

    label.append(radio, text);
    group.appendChild(label);
  }
  group.syncRadios = syncRadios;
  return group;
};

/**
 * Build a dropdown menu (colors or icons) that opens below its button.
 * @param {string} buttonText button caption
 * @param {object[]} items menu items
 * @param {string} items.key value sent to the background
 * @param {string} [items.swatch] color code for a color swatch
 * @param {string} items.label visible label
 * @param {string} currentKey currently selected item
 * @param {Function} onPick called with the picked key
 * @returns {HTMLDivElement} the .color-menu/.icon-menu element
 */
const buildMenu = (buttonText, items, currentKey, onPick) => {
  const wrapper = document.createElement('div');
  wrapper.className = items[0]?.swatch ? 'color-menu' : 'icon-menu';

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = buttonText;

  const list = document.createElement('div');
  list.className = 'menu-list';
  for (const item of items) {
    const option = document.createElement('button');
    option.type = 'button';
    if (item.swatch) {
      option.className = 'swatch';
      option.style.background = item.swatch;
      option.title = item.label;
    } else {
      option.className = 'icon-option';
      option.textContent = item.label;
    }
    if (item.key === currentKey) option.classList.add('current');
    option.addEventListener('click', async (event) => {
      event.stopPropagation();
      list.classList.remove('open');
      await onPick(item.key);
    });
    list.appendChild(option);
  }

  button.addEventListener('click', (event) => {
    event.stopPropagation();
    // Close every other open menu first.
    document.querySelectorAll('.menu-list.open').forEach((open) => {
      if (open !== list) open.classList.remove('open');
    });
    list.classList.toggle('open');
  });

  wrapper.append(button, list);
  return wrapper;
};

// Close every open menu on any click outside of them.
document.addEventListener('click', () => {
  document.querySelectorAll('.menu-list.open').forEach((open) => open.classList.remove('open'));
});

/**
 * Build ONE container row (an <li>) for the container list.
 * Tracked containers get the full proxy editor (protocol selectors,
 * "protocol:host:port" input, per-container DNS switch); untracked
 * ones show the static "not controlled" note and a disabled control
 * checkbox. Every row shows the container icon badge and the color
 * dot, and has the full style controls: color picker (any hex color,
 * applied as the nearest supported container color), icon menu, auto
 * color and auto icon — both auto actions update the row IMMEDIATELY.
 * @param {object} identity container identity from the background
 * @returns {HTMLLIElement} the rendered row
 */
const buildContainerRow = (identity) => {
  const item = document.createElement('li');
  item.className = identity.tracked ? 'tracked' : 'untracked';

  // --- status label (above the active/inactive elements) ---
  const statusLabel = document.createElement('div');
  statusLabel.className = 'status-label';
  statusLabel.textContent = identity.tracked
    ? message('trackedLabel')
    : message('untrackedLabel');

  // --- main row: name + control checkbox + delete ---
  const rowMain = document.createElement('div');
  rowMain.className = 'row-main';

  const rowName = document.createElement('div');
  rowName.className = 'row-name';

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = identity.colorCode || '#888888';

  // The container icon, VISIBLE for every container: a small badge
  // with the icon name (Firefox container icons are named shapes —
  // fingerprint, briefcase, dollar, cart, circle, gift, vacation,
  // food, fruit, pet, tree, chill).
  const iconBadge = document.createElement('span');
  iconBadge.className = 'icon-label';
  iconBadge.textContent = identity.icon;
  iconBadge.title = message('iconBadgeHint');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = identity.name;
  nameInput.title = message('renameHint');
  // Seamless rename: saved automatically after typing pauses.
  const saveName = debounce(async () => {
    const clean = nameInput.value.trim();
    if (!clean || clean === identity.name) return;
    const answer = await sendBackground({
      type: 'rename-container',
      cookieStoreId: identity.cookieStoreId,
      name: clean,
    });
    if (answer) identity.name = clean;
  });
  nameInput.addEventListener('input', saveName);

  rowName.append(dot, iconBadge, nameInput);

  const controlLabel = document.createElement('label');
  controlLabel.className = 'switch';
  const controlBox = document.createElement('input');
  controlBox.type = 'checkbox';
  // The per-container "Control proxy" checkbox and the GLOBAL master
  // switch ("Use the assigned proxy for every tracked container")
  // work together correctly:
  //  - master ON -> the checkbox shows its OWN stored flag and is
  //    FULLY FUNCTIONAL: toggle it independently per container;
  //  - master OFF -> the routing is direct for every tracked
  //    container anyway, so the checkbox is honestly shown unchecked
  //    and locked (hint explains why). The stored flag is NOT
  //    overwritten: it comes back the moment the master switch is
  //    turned ON again (the switch listener re-renders the list).
  const masterOn = pageState.settings?.enableAll === true;
  if (identity.tracked) {
    controlBox.checked = masterOn && identity.control;
    controlBox.disabled = !masterOn;
    controlLabel.title = !masterOn ? message('controlMasterOffHint') : '';
  } else {
    controlBox.checked = false;
    controlBox.disabled = true;
  }
  controlBox.addEventListener('change', async () => {
    const answer = await sendBackground({
      type: 'set-control',
      cookieStoreId: identity.cookieStoreId,
      control: controlBox.checked,
    });
    if (answer) identity.control = controlBox.checked;
  });
  const controlText = document.createElement('span');
  controlText.textContent = message('controlProxyLabel');
  controlLabel.append(controlBox, controlText);

  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger';
  deleteButton.textContent = message('deleteContainerButton');
  deleteButton.addEventListener('click', async () => {
    const answer = await sendBackground({
      type: 'remove-container',
      cookieStoreId: identity.cookieStoreId,
    });
    if (answer) refreshContainers();
  });

  rowMain.append(rowName, controlLabel);
  const pushRight = document.createElement('span');
  pushRight.className = 'push-right';
  rowMain.append(pushRight, deleteButton);

  // --- proxy row ---
  const rowProxy = document.createElement('div');
  rowProxy.className = 'row-proxy';

  // Per-container "DNS through proxy" switch: enabled only while the
  // protocol supports it (socks4 / socks5 — MDN proxy.ProxyInfo).
  const buildDnsSwitch = (protocol) => {
    const globalDns = pageState.settings?.dnsAlways === true;
    const protocolOk = protocol === 'socks4' || protocol === 'socks5';
    const dnsLabel = document.createElement('label');
    dnsLabel.className = 'dns-switch';
    const dnsBox = document.createElement('input');
    dnsBox.type = 'checkbox';
    dnsBox.dataset.protocol = protocol;
    // The GLOBAL DNS switch wins: when it is ON, every socks4/socks5
    // container routes DNS through its proxy and its own checkbox is
    // locked ON. When it is OFF, each container follows its own
    // stored "Route DNS through the proxy" flag.
    dnsBox.checked = protocolOk && (globalDns || Boolean(identity.proxy?.proxyDNS));
    dnsBox.disabled = !protocolOk || globalDns;
    dnsBox.addEventListener('change', async () => {
      const answer = await sendBackground({
        type: 'set-dns',
        cookieStoreId: identity.cookieStoreId,
        dnsThroughProxy: dnsBox.checked,
      });
      if (answer && identity.proxy) {
        identity.proxy.proxyDNS = dnsBox.checked;
      }
    });
    const dnsText = document.createElement('span');
    dnsText.textContent = message('dnsThroughProxyLabel');
    dnsLabel.append(dnsBox, dnsText);
    dnsLabel.title = globalDns
      ? message('dnsForcedHint')
      : (!protocolOk ? message('dnsUnavailableHint') : '');
    return dnsLabel;
  };

  if (identity.tracked) {
    const proxyWrap = document.createElement('div');
    proxyWrap.className = 'proxy-input';

    const proxyInput = document.createElement('input');
    proxyInput.type = 'text';
    proxyInput.value = formatProxyString(identity.proxy);
    proxyInput.placeholder = message('proxyPlaceholder');
    proxyInput.spellcheck = false;

    // The info line under the proxy field is ALWAYS present (fixed
    // height, nothing on the page shifts): "No proxy set" for an
    // empty field, "valid and applied" for a correct address, the
    // invalid-field warning for a broken one.
    const proxyError = document.createElement('span');
    proxyError.className = 'proxy-error';
    const updateProxyInfo = () => {
      const value = proxyInput.value.trim();
      const { ok } = parseProxyString(proxyInput.value);
      if (!value) {
        proxyError.textContent = message('proxyNotSet');
        proxyError.classList.remove('shown');
        proxyInput.classList.remove('invalid');
      } else if (ok) {
        proxyError.textContent = message('proxyAppliedOk');
        proxyError.classList.remove('shown');
        proxyInput.classList.remove('invalid');
      } else {
        proxyError.textContent = message('proxyInvalid');
        proxyError.classList.add('shown');
        proxyInput.classList.add('invalid');
      }
    };
    updateProxyInfo();

    // The per-container DNS switch lives in the proxy row and follows
    // the selected protocol.
    let dnsSwitch = buildDnsSwitch(identity.proxy?.type ?? '');
    const onProtocolChange = (protocol) => {
      const fresh = buildDnsSwitch(protocol);
      dnsSwitch.replaceWith(fresh);
      dnsSwitch = fresh;
    };

    /**
     * Live validation + seamless save of the "protocol:host:port"
     * input. Invalid input is highlighted and NOT used (the proxy is
     * served direct) — the message under the field says exactly that.
     * @param {boolean} [save=false] whether to send the value
     */
    const applyProxyInput = (save = false) => {
      const { ok, proxy } = parseProxyString(proxyInput.value);
      updateProxyInfo();
      if (!save) return;
      const { ok: valid, proxy: parsed } = parseProxyString(proxyInput.value);
      if (!valid) return; // keep the last saved value; proxy = direct
      sendBackground({
        type: 'set-proxy',
        cookieStoreId: identity.cookieStoreId,
        proxy: parsed,
      });
    };
    // Protocol selector is created BEFORE the input listener so its
    // syncRadios helper can be called on every keystroke/paste.
    const protocolSelector = buildProtocolSelector(identity, proxyInput, onProtocolChange);
    proxyInput.addEventListener('input', () => {
      // The protocol word typed/pasted at the start of the field
      // (before the first ":") auto-checks the matching round radio —
      // including PARTIAL input like "socks5:host" before the port.
      const prefix = proxyInput.value.split(':')[0].trim().toLowerCase();
      protocolSelector.syncRadios(PROTOCOLS.includes(prefix) ? prefix : '');
    });
    proxyInput.addEventListener('input', () => applyProxyInput(false));
    const saveProxy = debounce(() => applyProxyInput(true), 600);
    proxyInput.addEventListener('input', saveProxy);

    proxyWrap.append(proxyInput, proxyError);
    rowProxy.append(
      protocolSelector,
      proxyWrap,
      dnsSwitch,
    );
  } else {
    // Untracked container: a DISABLED proxy field that always says
    // "Unknown" + the fixed info line "The proxy is not controlled by
    // this extension". WebExtension APIs expose no way to READ the
    // proxy another extension assigned to a container (proxy.onRequest
    // only routes requests, there is no query API), so taking over a
    // foreign container is not possible — it is shown for information.
    const proxyWrap = document.createElement('div');
    proxyWrap.className = 'proxy-input';

    const proxyInput = document.createElement('input');
    proxyInput.type = 'text';
    proxyInput.value = message('proxyUnknown');
    proxyInput.disabled = true;
    proxyInput.spellcheck = false;

    const proxyInfo = document.createElement('span');
    proxyInfo.className = 'proxy-error';
    proxyInfo.textContent = message('proxyNotControlled');

    proxyWrap.append(proxyInput, proxyInfo);
    rowProxy.appendChild(proxyWrap);
  }

  // --- style row: full color picker, icon menu, auto buttons ---
  const styleRow = document.createElement('div');
  styleRow.className = 'style-row';

  // FULL color picker (input type="color"): any hex color. Firefox
  // containers accept only the supported color set, so the picked
  // color is applied as the nearest supported color — the dot and
  // the picker update IMMEDIATELY after the choice.
  const colorPicker = document.createElement('input');
  colorPicker.type = 'color';
  colorPicker.value = /^#[0-9a-fA-F]{6}$/.test(identity.colorCode ?? '')
    ? identity.colorCode
    : '#888888';
  colorPicker.title = message('colorPickerHint');
  // Debounced: the input event fires continuously while the user drags
  // inside the native color picker - restyle once, after the pause.
  const applyPickedColor = async () => {
    const nearest = nearestSupportedColor(colorPicker.value);
    const answer = await sendBackground({
      type: 'restyle-container',
      cookieStoreId: identity.cookieStoreId,
      style: { color: nearest.color },
    });
    if (answer) {
      updateRowStyle(item, nearest.colorCode, null);
      identity.color = nearest.color;
      identity.colorCode = nearest.colorCode;
    }
  };
  colorPicker.addEventListener('input', debounce(applyPickedColor, 300));

  // Compact menu of the supported colors as swatches.
  const colorMenu = buildMenu(
    message('chooseColor'),
    pageState.supportedColors.map(({ color, colorCode }) => ({
      key: color, swatch: colorCode, label: color,
    })),
    identity.color,
    async (color) => {
      const match = pageState.supportedColors.find(({ color: key }) => key === color);
      const answer = await sendBackground({
        type: 'restyle-container',
        cookieStoreId: identity.cookieStoreId,
        style: { color },
      });
      if (answer) {
        updateRowStyle(item, match?.colorCode ?? '', null);
        identity.color = color;
        identity.colorCode = match?.colorCode ?? identity.colorCode;
      }
    },
  );

  const iconMenu = buildMenu(
    message('chooseIcon'),
    pageState.supportedIcons.map((icon) => ({ key: icon, label: icon })),
    identity.icon,
    async (icon) => {
      const answer = await sendBackground({
        type: 'restyle-container',
        cookieStoreId: identity.cookieStoreId,
        style: { icon },
      });
      if (answer) {
        updateRowStyle(item, null, icon);
        identity.icon = icon;
      }
    },
  );

  // Auto color: the background picks the supported color most
  // distinct from all OTHER containers (and never the current one,
  // so the change is always visible). The row updates IMMEDIATELY
  // from the answer — the badge/dot/picker refresh in place.
  const autoColorButton = document.createElement('button');
  autoColorButton.type = 'button';
  autoColorButton.textContent = message('autoColor');
  autoColorButton.addEventListener('click', async () => {
    const answer = await sendBackground({ type: 'auto-color', cookieStoreId: identity.cookieStoreId });
    if (answer && !answer.error) {
      updateRowStyle(item, answer.colorCode, null);
      identity.color = answer.color;
      identity.colorCode = answer.colorCode;
    }
  });

  // Auto icon: same — an icon not used by any other container (never
  // the current one), applied and shown IMMEDIATELY.
  const autoIconButton = document.createElement('button');
  autoIconButton.type = 'button';
  autoIconButton.textContent = message('autoIcon');
  autoIconButton.addEventListener('click', async () => {
    const answer = await sendBackground({ type: 'auto-icon', cookieStoreId: identity.cookieStoreId });
    if (answer && !answer.error) {
      updateRowStyle(item, null, answer.icon);
      identity.icon = answer.icon;
    }
  });

  styleRow.append(colorPicker, colorMenu, iconMenu, autoColorButton, autoIconButton);

  item.append(statusLabel, rowMain, rowProxy, styleRow);
  return item;
};

const renderContainers = () => {
  const list = document.getElementById('containers');
  list.replaceChildren(...pageState.identities.map(buildContainerRow));
};

/**
 * Reload the page state from the background and re-render the list +
 * the global switches. Used on startup and after every structural
 * change (import, add, remove, restyle, external changes).
 * @returns {Promise<void>}
 */
const refreshContainers = async () => {
  const response = await sendBackground({ type: 'list-containers' });
  if (!response || !Array.isArray(response.identities)) return;
  pageState = response;

  document.getElementById('dns-always').checked = Boolean(response.settings?.dnsAlways);
  document.getElementById('enable-all').checked = Boolean(response.settings?.enableAll);

  renderContainers();
};

/* ------------------------------------------------------------------ */
/* Global switches + container actions (fixed control bar)             */
/* ------------------------------------------------------------------ */
// GLOBAL "Always route DNS through the proxy" switch. proxyDNS applies
// to SOCKS4/SOCKS5 only (MDN proxy.ProxyInfo). When checked, it
// OVERRIDES the per-container DNS checkboxes (they re-render locked
// ON); when unchecked, every container follows its own "Route DNS
// through the proxy" checkbox. The full list is re-rendered so every
// row reflects the new state IMMEDIATELY — safe here: the focus is on
// the top-bar switch, never inside the container list.
document.getElementById('dns-always').addEventListener('change', async (event) => {
  const answer = await sendBackground({
    type: 'set-settings',
    settings: { dnsAlways: event.target.checked },
  });
  if (answer) {
    pageState.settings.dnsAlways = event.target.checked;
    refreshContainers();
  }
});

// GLOBAL "Use the assigned proxy for every tracked container" switch —
// the MASTER switch at the background routing level. It does NOT
// lock the per-container checkboxes — each "Control proxy" checkbox
// stays fully functional; unchecked, all tracked containers direct.
document.getElementById('enable-all').addEventListener('change', async (event) => {
  const answer = await sendBackground({
    type: 'set-settings',
    settings: { enableAll: event.target.checked },
  });
  if (answer) {
    pageState.settings.enableAll = event.target.checked;
    refreshContainers();
  }
});

// Add a tracked container: empty proxy input, control checkbox off.
document.getElementById('add-container').addEventListener('click', async () => {
  const answer = await sendBackground({ type: 'add-container' });
  if (answer) refreshContainers();
});

// Delete every TRACKED container — with a confirmation dialog.
document.getElementById('remove-active').addEventListener('click', async () => {
  if (!window.confirm(message('confirmRemoveActive'))) return;
  const answer = await sendBackground({ type: 'remove-active-containers' });
  if (answer) {
    showStatus(message('statusRemoved').replace('%s', String(answer.removed ?? 0)), 'ok');
    refreshContainers();
  }
});

// Delete EVERY container (tracked and untracked) — with a confirmation
// dialog. This is the only other action that asks for confirmation.
document.getElementById('remove-all').addEventListener('click', async () => {
  if (!window.confirm(message('confirmRemoveAll'))) return;
  const answer = await sendBackground({ type: 'remove-all-containers' });
  if (answer) {
    showStatus(message('statusRemoved').replace('%s', String(answer.removed ?? 0)), 'ok');
    refreshContainers();
  }
});

/* ------------------------------------------------------------------ */
/* Startup                                                              */
/* ------------------------------------------------------------------ */

document.getElementById('title').textContent = message('extensionName');
document.getElementById('hint').textContent = message('importHint');
document.getElementById('drop-hint').textContent = message('dropHint');
document.getElementById('export-title').textContent = message('exportTitle');
document.getElementById('export-hint').textContent = message('exportHint');
document.getElementById('containers-title').textContent = message('containersTitle');
document.getElementById('containers-hint').textContent = message('containersHint');
document.getElementById('dns-always-label').textContent = message('dnsAlwaysLabel');
document.getElementById('enable-all-label').textContent = message('enableAllLabel');

// Explanatory tooltips on the two global switches (the wrapping
// <label> elements carry the hint), so their effect is always clear.
document.getElementById('dns-always')?.closest('label')?.setAttribute('title', message('dnsAlwaysHint'));
document.getElementById('enable-all')?.closest('label')?.setAttribute('title', message('enableAllHint'));

const fileInput = document.getElementById('file-input');
const selectButton = document.getElementById('select-file');
const dropZone = document.getElementById('drop-zone');
const exportModernButton = document.getElementById('export-modern');
const exportLegacyButton = document.getElementById('export-legacy');

selectButton.textContent = message('chooseFile');
exportModernButton.textContent = message('exportModern');
exportLegacyButton.textContent = message('exportLegacy');
document.getElementById('add-container').textContent = message('addContainerButton');
document.getElementById('remove-active').textContent = message('removeAllActiveButton');
document.getElementById('remove-all').textContent = message('removeAllButton');
showStatus(message('statusWaiting'));

// Live progress from the background: "Creating container i of N: name".
// Also handles two background notifications:
//  - "proxy-conflict": another extension or manual browser settings
//    control the proxy configuration -> show/hide the warning banner;
//  - "containers-changed": a container was created/renamed/recolored/
//    removed (also by other extensions) -> refresh the container list
//    (skipped while the user is typing inside the list, so seamless
//    editing never loses focus).
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
    if (!isEditingContainerList()) {
      refreshContainers();
    }
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

// Initial container list + global switches.
refreshContainers();

/* ------------------------------------------------------------------ */
/* Fixed control bar height sync                                       */
/* ------------------------------------------------------------------ */

/* The fixed control bar grows when the long switch captions and the
 * action buttons wrap into more lines (narrow windows, larger fonts).
 * Its real height is measured here and published as the
 * --top-bar-height custom property, which drives the body padding-top
 * (see import.css) — so the fixed bar can never overlap the page
 * content at any window width. A ResizeObserver keeps the value exact
 * whenever the bar content re-wraps; the resize listener and the
 * initial call cover observers that are unavailable. */
const topBarElement = document.getElementById('top-bar');
const syncTopBarHeight = () => {
  if (!topBarElement) return;
  document.documentElement.style.setProperty(
    '--top-bar-height',
    `${topBarElement.offsetHeight}px`,
  );
};
window.addEventListener('resize', syncTopBarHeight);
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(syncTopBarHeight).observe(topBarElement);
}
syncTopBarHeight();