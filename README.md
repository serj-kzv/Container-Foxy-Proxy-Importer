# 🦊 Container Foxy Proxy Importer

> 📦 Import FoxyProxy configurations into Firefox, turn every proxy into a
> **Firefox container**, and route each container through its own proxy —
> automatically.

![Version](https://img.shields.io/badge/version-1.0.0-blue) ![License](https://img.shields.io/badge/license-MIT-green) ![Firefox](https://img.shields.io/badge/Firefox-153%2B-orange)

## ✨ Features

### 📥 Import — every FoxyProxy format

- 🆕 **FoxyProxy 8+ / 9+** export (`data` array, string types, string port)
- 🕰️ **FoxyProxy Standard 6.x – 7.5.1** export (`proxySettings`, numeric types 1–5)
- 💾 **FoxyProxy 6.x storage backup** (top-level values)
- 📄 **FoxyProxy 4.x `foxyproxy.xml`** (legacy XML)

Just click the toolbar icon 🧭 — the import page opens in a tab. Pick a file
(or drag & drop it) and containers are created automatically, one per proxy,
with a matching color and a live progress display.

### 🔗 Proxy-per-container routing that survives renames

- Each container is bound to its proxy by the **stable `cookieStoreId`**
  (not by name!). Rename, recolor or re-icon a container — in the browser UI
  **or from another container extension** — and the proxy routing keeps
  working untouched.
- The background script tracks the **live container state**
  (`contextualIdentities.onCreated / onUpdated / onRemoved`), so removals
  clean up their bindings and renames are picked up instantly.
- Proxy authentication (username / password) is filled in automatically
  via a blocking `webRequest.onAuthRequired` listener. 🔐

### 📤 Export — current state, two formats

Two buttons on the import page, each opening a native **Save As dialog**:

- 🆕 `foxyproxy-settings-YYYY-MM-DD.json` — modern FoxyProxy 8+/9+ format
- 🕰️ `foxyproxy-legacy-YYYY-MM-DD.json` — FoxyProxy Standard 6.x–7.5.1

The export always uses the **current** container names and colors: rename a
container and the next export reflects it.

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

### 🎨 Theme-aware UI

The import page adapts to the system light/dark preference **and** to the
Firefox theme installed in your browser (`theme.getCurrent` /
`theme.onUpdated`). Also fully localized: 🇬🇧 English, 🇷🇺 Russian.

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
    ├── background.js          # event page: containers, routing, conflict guard
    ├── import.html/.css/.js   # import/export page (tab, theme-aware)
    ├── icon.svg               # toolbar icon
    ├── icons/icon-template.svg
    ├── _locales/en, _locales/ru
    ├── README.md              # this file
    ├── LICENSE                 # MIT
    └── .gitignore

## 🧠 How it works

1. 📥 The import page parses any FoxyProxy format (JSON or XML).
2. 🧱 The background script creates one container per proxy
   (`contextualIdentities.create`) with a deterministic color/icon and
   stores the binding `cookieStoreId → proxy` in `storage.local`.
3. 🌐 Every request is matched by `proxy.onRequest` **per container**
   (`cookieStoreId`), so each container routes through its own proxy.
4. 🔁 Container changes (rename / recolor / remove — from the UI or other
   extensions) are tracked live; exports always read the current state.

## 📄 License

[MIT](./LICENSE) © 2026 Siarhei Kuzeyeu