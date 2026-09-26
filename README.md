# 🦊 Container Foxy Proxy Importer

> 📦 Import FoxyProxy configurations into Firefox, turn every proxy into a
> **Firefox container**, and route each container through its own proxy —
> automatically. Manage every container right on the page.

![Version](https://img.shields.io/badge/version-2.0.2-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Firefox](https://img.shields.io/badge/Firefox-153%2B-orange)

## ✨ Features

### 📥 Import — every FoxyProxy format

- 🆕 **FoxyProxy 8+ / 9+** export (`data` array, string types, string port)
- 🕰️ **FoxyProxy Standard 6.x – 7.5.1** export (`proxySettings`, numeric types 1–5)
- 💾 **FoxyProxy 6.x storage backup** (top-level values)
- 📄 **FoxyProxy 4.x `foxyproxy.xml`** (legacy XML)

Just click the toolbar icon 🧭 — the import page opens in a tab. Pick a file
(or drag & drop it) and containers are created automatically, one per proxy,
with a matching color and a live progress display.

### 🗂️ Container management — every container on one page

The page lists **every Firefox container**:

- containers imported or added here are **tracked** (labeled
  "Controlled by the Container Foxy Proxy Importer extension") — their proxy
  is editable as a single `protocol:host:port` field with round protocol
  selectors (http / https / socks4 / socks5) and live validation: an invalid
  field is highlighted and its proxy is served **direct**;
- every other container is shown **inactive** (labeled "Not controlled…")
  with the note "The proxy is not controlled by the Container Foxy Proxy
  Importer extension" instead of the proxy editor.

Everything saves seamlessly — no Save/Edit buttons:

- ✏️ rename any container by editing its name;
- 🎨 change any container's color and icon (pick from the colors and icons
  the browser supports — `getSupportedColors` / `getSupportedIcons`), or
  generate them automatically: **auto color** and **auto icon** CHANGE THE
  VALUE ON EVERY CLICK — each click rotates through the FULL supported
  color/icon set (never repeating the current value, so the change is
  always visible IMMEDIATELY — the dot, the badge and the picker refresh
  in place);
- 🎨 a **full color picker** (`<input type="color">`): pick ANY color — the
  closest supported container color is applied (Firefox accepts only the
  colors from `getSupportedColors`);
- 🏷️ every container shows its **icon badge** next to the color dot;
- ☑️ tracked containers have a **"Control proxy"** checkbox — fully
  functional while the master switch is ON (each container follows its
  own stored flag); while the master switch is OFF the checkbox is
  honestly shown unchecked and locked (everything browses direct), and
  the stored flags are restored when it goes back ON; untracked
  containers have the same checkbox, always disabled and off;
- ➕ **"Add a container controlled by Container Foxy Proxy Importer"**
  creates a tracked container with an empty proxy field and the control
  checkbox off;
- 🗑️ **"Delete container"** per row (tracked or untracked), plus
  **"Delete all active containers"** and **"Delete all containers"** — the
  only two actions that ask for confirmation.


### 🎛️ DNS & master switches (pinned to the top of the page)

- **"Always route DNS of all proxies through the proxy for proxy protocols
  that support it (recommended)"** — sets `proxyDNS` for SOCKS4/SOCKS5
  proxies (the only protocols Firefox allows it for — see
  [MDN: proxy.ProxyInfo](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/proxy/ProxyInfo)).
  HTTP/HTTPS proxies resolve the target host on the proxy side by design.
- **"Use the assigned proxy for every tracked container"** — the master
  switch at the background routing level. It does NOT lock the
  per-container checkboxes: unchecked, every tracked container browses
  direct (no proxy at all, whatever its own settings); checked, each
  container follows its own "Control proxy" checkbox and its proxy field.
- **Per-container "Route DNS through the proxy"** checkbox — every tracked
  container also has its own DNS switch in the proxy row (enabled only
  while its protocol is socks4/socks5). The global switch wins when on —
  the per-container checkboxes are locked on; when off, each container
  follows its own flag.

### 🔗 Proxy-per-container routing that survives renames

- Each container is bound to its proxy by the **stable `cookieStoreId`**
  (not by name!). Rename, recolor or re-icon a container — in the page, the
  browser UI **or from another container extension** — and the proxy
  routing keeps working untouched.
- The background script tracks the **live container state**
  (`contextualIdentities.onCreated / onUpdated / onRemoved`), so removals
  clean up their bindings and renames are picked up instantly.
- Proxy authentication (username / password) is filled in automatically
  via a blocking `webRequest.onAuthRequired` listener. 🔐

### 📤 Export — current state, two formats

Two buttons on the page, each opening a native **Save As dialog**:

- 🆕 `foxyproxy-settings-YYYY-MM-DD.json` — modern FoxyProxy 8+/9+ format
- 🕰️ `foxyproxy-legacy-YYYY-MM-DD.json` — FoxyProxy Standard 6.x–7.5.1

The export always uses the **current** container names and colors: rename a
container and the next export reflects it. Only tracked containers with the
control checkbox on and a valid proxy are exported.

**How to import the exported files back into FoxyProxy 8+/9+:**

- the **modern** file (`foxyproxy-settings-*.json`) → FoxyProxy Options →
  **Import** tab → the main **Import** button (the same button FoxyProxy
  uses for its own exports), then press **Save**. The file also carries
  the legacy records, so "Import from older versions" accepts it too —
  either dialog works;
- the **legacy** file (`foxyproxy-legacy-*.json`) → the same Import tab →
  **Import from older versions** (FoxyProxy migrates it automatically).

### ⚔️ Proxy-settings conflict guard

The WebExtensions API cannot block another extension from taking over the
browser's proxy settings — but this extension detects it:

- watches `browser.proxy.settings` (`get()` + `onChange`),
- warns with a desktop notification and a page banner when another extension
  or manual browser proxy settings take control,
- explains that manual proxies may override the per-container routing.

### 🖤 Monochrome, theme-aware UI

The page is strictly **monochrome** — white, black and shades of gray, no
rounded corners, no shadows — and adapts to the system light/dark preference
**and** to the Firefox theme installed in your browser
(`theme.getCurrent` / `theme.onUpdated`; the theme only selects the light or
dark grayscale palette). The toolbar icon is monochrome and adapts to the
system theme too. The page content and the fixed control bar are CENTERED with a fixed max width, so the layout stays together on any window size. Fully localized: 🇬🇧 English, 🇷🇺 Russian.

## 🚀 Installation (from the generator .bat)

1. Save the `.bat` file as UTF-8 **without BOM**, double-click it.
   It creates the folder `container-proxy-importer` with all 12 files.
2. Open Firefox and go to `about:debugging#/runtime/this-firefox`.
3. Click **Load Temporary Add-on…** and select the `manifest.json` inside the
   folder.
4. Click the toolbar icon — the import/export page opens in a tab. 🎉

> 💡 For a permanent install, use [web-ext](https://github.com/mozilla/web-ext)
> (`web-ext build`) or sign the extension on
> [addons.mozilla.org](https://addons.mozilla.org/).

## 📁 Project structure

    container-proxy-importer/
    ├── manifest.json          # MV2 manifest (Firefox 153+)
    ├── background.js          # event page: containers, routing, management, conflict guard
    ├── import.html/.css/.js   # import/export + container management page
    ├── icon.svg               # toolbar icon (monochrome, theme-adaptive)
    ├── icons/icon-template.svg
    ├── _locales/en, _locales/ru
    ├── README.md              # this file
    ├── LICENSE                 # MIT
    └── .gitignore

## 🧠 How it works

1. 📥 The page parses any FoxyProxy format (JSON or XML).
2. 🧱 The background script creates one container per proxy
   (`contextualIdentities.create`) with a deterministic color/icon and
   stores the binding `cookieStoreId → proxy` in `storage.local`
   (plus a per-container control flag and two global settings).
3. 🌐 Every request is matched by `proxy.onRequest` **per container**
   (`cookieStoreId`): tracked + control on + master switch on + valid
   proxy → routed through it (`socks5` is sent to Firefox as the
   ProxyInfo type `socks`); anything else → direct.
4. 🔁 Container changes (rename / recolor / remove — from the page, the
   UI or other extensions) are tracked live; the page list and the
   exports always read the current state.

## 📄 License

[MIT](./LICENSE) © 2026 Siarhei Kuzeyeu