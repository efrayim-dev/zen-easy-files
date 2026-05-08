// ==UserScript==
// @name           Zen Easy Files
// @namespace      https://github.com/efray/zen-easy-files
// @description    Opera-like file picker with recent downloads, clipboard, and screenshots
// @include        main
// @include        chrome://browser/content/browser.xhtml
// @loadOrder      10
// ==/UserScript==

import { Downloads } from "resource://gre/modules/Downloads.sys.mjs";
import { FileUtils } from "resource://gre/modules/FileUtils.sys.mjs";

// Resolve our own location dynamically so the same script works whether it
// lives in <profile>/chrome/JS/ (manual fx-autoconfig install — exposed at
// chrome://userscripts/content/) or in <profile>/chrome/sine-mods/<mod-id>/
// (installed by Sine — exposed at chrome://sine/content/<mod-id>/).
const SCRIPT_DIR = new URL(".", import.meta.url).href;
const PANEL_ID = "easy-files-panel";
const STYLE_ID = "easy-files-style";

const PREF_ENABLED = "extensions.easy-files.enabled";
const PREF_LIMIT = "extensions.easy-files.recent-limit";
const PREF_BYPASS_KEY = "extensions.easy-files.bypass-modifier";
const PREF_RECENT_FOLDER = "extensions.easy-files.recent-folder";
const PREF_RECENT_SOURCE = "extensions.easy-files.recent-source";

let _registered = false;

function setupDefaults() {
  const branch = Services.prefs.getDefaultBranch("");
  if (branch.getPrefType(PREF_ENABLED) === 0)
    branch.setBoolPref(PREF_ENABLED, true);
  if (branch.getPrefType(PREF_LIMIT) === 0)
    branch.setIntPref(PREF_LIMIT, 15);
  if (branch.getPrefType(PREF_BYPASS_KEY) === 0)
    branch.setStringPref(PREF_BYPASS_KEY, "shift");
  if (branch.getPrefType(PREF_RECENT_FOLDER) === 0)
    branch.setStringPref(PREF_RECENT_FOLDER, "");
  if (branch.getPrefType(PREF_RECENT_SOURCE) === 0)
    branch.setStringPref(PREF_RECENT_SOURCE, "folder");
}

function getDefaultDownloadsPath() {
  for (const key of ["DfltDwnld", "Downld", "Desk"]) {
    try {
      const dir = Services.dirsvc.get(key, Ci.nsIFile);
      if (dir?.path && dir.exists() && dir.isDirectory()) return dir.path;
    } catch {}
  }
  return "";
}

function getRecentFolderPath() {
  let p = "";
  try {
    p = Services.prefs.getStringPref(PREF_RECENT_FOLDER, "") || "";
  } catch {}
  p = (p || "").trim();
  if (p) return p;
  return getDefaultDownloadsPath();
}

function registerActor() {
  if (_registered) return;
  try {
    ChromeUtils.unregisterWindowActor("EasyFiles");
  } catch {}
  ChromeUtils.registerWindowActor("EasyFiles", {
    parent: {
      esModuleURI: SCRIPT_DIR + "EasyFilesParent.sys.mjs",
    },
    child: {
      esModuleURI: SCRIPT_DIR + "EasyFilesChild.sys.mjs",
      events: { click: { capture: true, mozSystemGroup: true } },
    },
    allFrames: true,
    matches: ["*://*/*", "file:///*"],
  });
  _registered = true;
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "link"
  );
  link.id = STYLE_ID;
  link.rel = "stylesheet";
  link.href = SCRIPT_DIR + "easy-files.css";
  document.documentElement.appendChild(link);
}

function buildPanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  const ns = "http://www.w3.org/1999/xhtml";
  panel = document.createXULElement("panel");
  panel.id = PANEL_ID;
  panel.setAttribute("type", "arrow");
  panel.setAttribute("noautofocus", "false");
  panel.setAttribute("class", "easy-files-popup");
  panel.setAttribute("orient", "vertical");

  const root = document.createElementNS(ns, "div");
  root.className = "ef-root";
  root.innerHTML = `
    <div class="ef-header">
      <div class="ef-title">Attach a file</div>
      <button class="ef-close" data-action="close" title="Close (Esc)">✕</button>
    </div>
    <div class="ef-tabs">
      <button class="ef-tab active" data-tab="recent">Recent</button>
      <button class="ef-tab" data-tab="clipboard">Clipboard</button>
      <button class="ef-tab" data-tab="screenshot">Screenshot</button>
    </div>
    <div class="ef-body">
      <div class="ef-pane" data-pane="recent">
        <div class="ef-folder-bar">
          <span class="ef-folder-label" data-info="folder">…</span>
          <div class="ef-folder-actions">
            <button class="ef-folder-btn" data-action="toggle-source" title="Toggle between folder scan and download history">⇄</button>
            <button class="ef-folder-btn" data-action="pick-folder" title="Choose folder">📁</button>
          </div>
        </div>
        <div class="ef-list" data-list="recent">
          <div class="ef-empty">Loading recent files…</div>
        </div>
      </div>
      <div class="ef-pane hidden" data-pane="clipboard">
        <div class="ef-list" data-list="clipboard">
          <div class="ef-empty">Click "Read clipboard" to load.</div>
        </div>
        <div class="ef-pane-actions">
          <button class="ef-action ef-secondary" data-action="refresh-clipboard">Read clipboard</button>
        </div>
      </div>
      <div class="ef-pane hidden" data-pane="screenshot">
        <div class="ef-list" data-list="screenshot">
          <div class="ef-empty">Capture the visible area of the active tab.</div>
        </div>
        <div class="ef-pane-actions">
          <button class="ef-action ef-secondary" data-action="take-screenshot">Capture visible area</button>
        </div>
      </div>
    </div>
    <div class="ef-footer">
      <span class="ef-info" data-info="info"></span>
      <div class="ef-footer-actions">
        <button class="ef-action ef-secondary" data-action="browse">Browse files…</button>
        <button class="ef-action ef-primary hidden" data-action="submit">Attach selected</button>
      </div>
    </div>
  `;
  panel.appendChild(root);

  const popupSet =
    document.getElementById("mainPopupSet") || document.documentElement;
  popupSet.appendChild(panel);
  return panel;
}

class EasyFilesController {
  constructor() {
    this.panel = null;
    this.activeBrowser = null;
    this.activeWindowGlobal = null;
    this.requestData = null;
    this.selectedFiles = [];
    this.recentDownloads = [];
    this._submitted = false;
  }

  init() {
    this.panel = buildPanel();
    this.panel.addEventListener("popuphidden", () => this._onHidden());
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.panel.hidePopup();
    });

    this.panel.querySelectorAll("[data-tab]").forEach((btn) => {
      btn.addEventListener("click", (e) =>
        this._switchTab(e.currentTarget.dataset.tab)
      );
    });
    this.panel.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", (e) =>
        this._handleAction(e.currentTarget.dataset.action)
      );
    });

    window.addEventListener("EasyFiles:RequestPicker", (e) =>
      this._onRequest(e)
    );
  }

  async _onRequest(event) {
    const { detail } = event;
    this.activeBrowser = detail.browser;
    this.activeWindowGlobal = detail.windowGlobal;
    this.requestData = detail.data || {};
    this.selectedFiles = [];
    this._submitted = false;

    this._switchTab("recent");
    this._updateInfo();

    const anchor =
      detail.browser ||
      window.gURLBar?.textbox ||
      window.gBrowser?.selectedBrowser ||
      document.documentElement;

    this.panel.openPopup(anchor, "after_start", 0, 0, false, false);
    this._loadRecent();
  }

  _getRecentSource() {
    try {
      const v = Services.prefs.getStringPref(PREF_RECENT_SOURCE, "folder");
      return v === "downloads" ? "downloads" : "folder";
    } catch {
      return "folder";
    }
  }

  _updateFolderLabel() {
    const label = this.panel.querySelector('[data-info="folder"]');
    if (!label) return;
    const source = this._getRecentSource();
    if (source === "downloads") {
      label.textContent = "Source: download history";
      label.title = "Showing files from Zen's download history";
    } else {
      const path = getRecentFolderPath();
      label.textContent = path
        ? "📂 " + collapsePath(path)
        : "(no folder configured)";
      label.title = path || "Set a folder in Sine settings or click 📁";
    }
  }

  async _loadRecent() {
    const list = this.panel.querySelector('[data-list="recent"]');
    list.innerHTML = '<div class="ef-empty">Loading…</div>';
    this._updateFolderLabel();

    try {
      const limit = Services.prefs.getIntPref(PREF_LIMIT, 15);
      const accept = (this.requestData?.accept || "").toLowerCase();
      const acceptParts = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const items =
        this._getRecentSource() === "downloads"
          ? await this._collectFromDownloadHistory(acceptParts)
          : await this._collectFromFolder(acceptParts);

      items.sort((a, b) => b.mtime - a.mtime);
      const top = items.slice(0, limit);
      this.recentDownloads = top;

      if (!top.length) {
        const source = this._getRecentSource();
        const reason =
          source === "downloads"
            ? "No matching items in download history."
            : "No matching files in this folder.";
        list.innerHTML = `<div class="ef-empty">${reason}</div>`;
        return;
      }

      list.innerHTML = "";
      for (const item of top) {
        list.appendChild(this._makeRow(item));
      }
    } catch (e) {
      console.error("EasyFiles: load recent failed", e);
      list.innerHTML = `<div class="ef-empty">Error: ${escapeHtml(
        String(e.message || e)
      )}</div>`;
    }
  }

  async _collectFromDownloadHistory(acceptParts) {
    const downloadList = await Downloads.getList(Downloads.ALL);
    const downloads = await downloadList.getAll();
    const out = [];
    for (const dl of downloads) {
      if (!dl.target?.path || !dl.succeeded) continue;
      try {
        const file = new FileUtils.File(dl.target.path);
        if (!file.exists() || !file.isFile()) continue;
        const name = file.leafName;
        const mime =
          dl.contentType && dl.contentType !== "application/octet-stream"
            ? dl.contentType
            : guessMimeType(name);
        if (acceptParts.length && !acceptMatches(name, mime, acceptParts))
          continue;
        out.push({
          path: dl.target.path,
          name,
          size: file.fileSize,
          mtime: file.lastModifiedTime,
          mime,
        });
      } catch {}
    }
    return out;
  }

  async _collectFromFolder(acceptParts) {
    const folder = getRecentFolderPath();
    if (!folder) return [];
    let entries;
    try {
      entries = await IOUtils.getChildren(folder);
    } catch (e) {
      console.warn("EasyFiles: getChildren failed for", folder, e);
      return [];
    }
    const out = [];
    for (const path of entries) {
      try {
        const stat = await IOUtils.stat(path);
        if (stat.type !== "regular") continue;
        const name = path.split(/[\\/]/).pop();
        const mime = guessMimeType(name);
        if (acceptParts.length && !acceptMatches(name, mime, acceptParts))
          continue;
        out.push({
          path,
          name,
          size: stat.size,
          mtime: stat.lastModified,
          mime,
        });
      } catch {}
    }
    return out;
  }

  async _pickFolder() {
    try {
      const fp = Cc["@mozilla.org/filepicker;1"].createInstance(
        Ci.nsIFilePicker
      );
      fp.init(
        window.browsingContext,
        "Choose folder for Recent files",
        Ci.nsIFilePicker.modeGetFolder
      );
      const current = getRecentFolderPath();
      if (current) {
        try {
          fp.displayDirectory = new FileUtils.File(current);
        } catch {}
      }
      const result = await new Promise((resolve) => fp.open(resolve));
      if (result === Ci.nsIFilePicker.returnOK && fp.file?.path) {
        Services.prefs.setStringPref(PREF_RECENT_FOLDER, fp.file.path);
        Services.prefs.setStringPref(PREF_RECENT_SOURCE, "folder");
        this._loadRecent();
      }
    } catch (e) {
      console.error("EasyFiles: pickFolder failed", e);
    }
  }

  _toggleSource() {
    const next =
      this._getRecentSource() === "folder" ? "downloads" : "folder";
    Services.prefs.setStringPref(PREF_RECENT_SOURCE, next);
    this._loadRecent();
  }

  _makeRow(item) {
    const ns = "http://www.w3.org/1999/xhtml";
    const row = document.createElementNS(ns, "div");
    row.className = "ef-item";
    row.dataset.path = item.path;
    row.dataset.name = item.name;
    row.tabIndex = 0;

    const isImage = (item.mime || "").startsWith("image/");

    row.innerHTML = `
      <div class="ef-icon ef-icon-${isImage ? "image" : "file"}"></div>
      <div class="ef-meta">
        <div class="ef-name"></div>
        <div class="ef-sub"></div>
      </div>
      <div class="ef-check"></div>
    `;
    row.querySelector(".ef-name").textContent = item.name;
    row.querySelector(".ef-sub").textContent = `${formatSize(
      item.size
    )} • ${formatDate(item.mtime)}`;

    if (isImage) {
      try {
        const fileUri = Services.io.newFileURI(
          new FileUtils.File(item.path)
        ).spec;
        const icon = row.querySelector(".ef-icon");
        icon.style.backgroundImage = `url("${fileUri}")`;
        icon.classList.add("ef-icon-thumb");
      } catch {}
    }

    const onPick = () => this._toggleFileSelection(row, item);
    row.addEventListener("click", onPick);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onPick();
      }
    });
    return row;
  }

  async _toggleFileSelection(row, item) {
    const multiple = !!this.requestData?.multiple;

    if (!multiple) {
      const fileData = await this._readFileFromDisk(item.path);
      if (!fileData) return;
      this.selectedFiles = [fileData];
      this.panel
        .querySelectorAll(".ef-item.selected")
        .forEach((r) => r.classList.remove("selected"));
      row.classList.add("selected");
      this._submit();
      return;
    }

    if (row.classList.contains("selected")) {
      row.classList.remove("selected");
      this.selectedFiles = this.selectedFiles.filter(
        (f) => f._sourcePath !== item.path
      );
    } else {
      const fileData = await this._readFileFromDisk(item.path);
      if (!fileData) return;
      fileData._sourcePath = item.path;
      this.selectedFiles.push(fileData);
      row.classList.add("selected");
    }
    this._updateInfo();
  }

  async _readFileFromDisk(path) {
    try {
      const bytes = await IOUtils.read(path);
      const stat = await IOUtils.stat(path);
      const name = path.split(/[\\/]/).pop();
      return {
        name,
        type: guessMimeType(name),
        bytes,
        lastModified: Math.round(stat.lastModified),
      };
    } catch (e) {
      console.error("EasyFiles: read file failed", path, e);
      return null;
    }
  }

  _switchTab(tab) {
    this.panel
      .querySelectorAll("[data-tab]")
      .forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    this.panel
      .querySelectorAll("[data-pane]")
      .forEach((p) => p.classList.toggle("hidden", p.dataset.pane !== tab));
  }

  async _loadClipboard() {
    const list = this.panel.querySelector('[data-list="clipboard"]');
    list.innerHTML = '<div class="ef-empty">Reading clipboard…</div>';

    try {
      const items = await this._readClipboardData();
      if (!items.length) {
        list.innerHTML =
          '<div class="ef-empty">No usable clipboard items (images or files).</div>';
        return;
      }

      list.innerHTML = "";
      const ns = "http://www.w3.org/1999/xhtml";
      for (const item of items) {
        const row = document.createElementNS(ns, "div");
        row.className = "ef-item";
        row.tabIndex = 0;
        const isImage = (item.type || "").startsWith("image/");
        row.innerHTML = `
          <div class="ef-icon ef-icon-${isImage ? "image" : "file"}"></div>
          <div class="ef-meta">
            <div class="ef-name"></div>
            <div class="ef-sub"></div>
          </div>
        `;
        row.querySelector(".ef-name").textContent = item.name;
        const size = item.bytes.byteLength ?? item.bytes.length ?? 0;
        row.querySelector(".ef-sub").textContent = `${item.type} • ${formatSize(
          size
        )}`;

        if (isImage) {
          try {
            const blob = new Blob([item.bytes], { type: item.type });
            const url = URL.createObjectURL(blob);
            const icon = row.querySelector(".ef-icon");
            icon.style.backgroundImage = `url("${url}")`;
            icon.classList.add("ef-icon-thumb");
          } catch {}
        }

        const pick = () => {
          this.selectedFiles = [item];
          this._submit();
        };
        row.addEventListener("click", pick);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            pick();
          }
        });
        list.appendChild(row);
      }
    } catch (e) {
      console.error("EasyFiles: clipboard read failed", e);
      list.innerHTML = `<div class="ef-empty">Clipboard error: ${escapeHtml(
        String(e.message || e)
      )}</div>`;
    }
  }

  async _readClipboardData() {
    const items = [];
    const cb = Services.clipboard;
    const flavors = [
      "image/png",
      "image/jpeg",
      "image/gif",
      "application/x-moz-file",
    ];

    for (const flavor of flavors) {
      try {
        if (!cb.hasDataMatchingFlavors([flavor], cb.kGlobalClipboard)) continue;
        const trans = Cc[
          "@mozilla.org/widget/transferable;1"
        ].createInstance(Ci.nsITransferable);
        trans.init(null);
        trans.addDataFlavor(flavor);
        cb.getData(trans, cb.kGlobalClipboard);

        const data = {};
        trans.getTransferData(flavor, data);
        const value = data.value;

        if (flavor === "application/x-moz-file") {
          let file = value;
          try {
            file = value.QueryInterface(Ci.nsIFile);
          } catch {}
          if (!file?.path) continue;
          const bytes = await IOUtils.read(file.path);
          items.push({
            name: file.leafName,
            type: guessMimeType(file.leafName),
            bytes,
            lastModified: Math.round(file.lastModifiedTime),
          });
        } else if (flavor.startsWith("image/")) {
          const stream = value.QueryInterface(Ci.nsIInputStream);
          const bin = Cc[
            "@mozilla.org/binaryinputstream;1"
          ].createInstance(Ci.nsIBinaryInputStream);
          bin.setInputStream(stream);
          const arr = bin.readByteArray(stream.available());
          const bytes = new Uint8Array(arr);
          const ext = flavor.split("/")[1];
          items.push({
            name: `clipboard-${Date.now()}.${ext}`,
            type: flavor,
            bytes,
            lastModified: Date.now(),
          });
        }
      } catch (e) {
        console.warn("EasyFiles: clipboard flavor read failed", flavor, e);
      }
    }
    return items;
  }

  async _takeScreenshot() {
    const list = this.panel.querySelector('[data-list="screenshot"]');
    list.innerHTML = '<div class="ef-empty">Capturing…</div>';
    try {
      const browser =
        this.activeBrowser || window.gBrowser?.selectedBrowser;
      if (!browser) throw new Error("No active browser");

      const dpr = window.devicePixelRatio || 1;
      const rect = browser.getBoundingClientRect();
      const ns = "http://www.w3.org/1999/xhtml";
      const canvas = document.createElementNS(ns, "canvas");
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const ctx = canvas.getContext("2d");
      ctx.scale(dpr, dpr);

      const win = browser.contentWindow;
      if (win && typeof ctx.drawWindow === "function") {
        ctx.drawWindow(win, 0, 0, rect.width, rect.height, "rgb(255,255,255)");
      } else {
        const bc = browser.browsingContext;
        const bitmap = await bc.currentWindowGlobal?.drawSnapshot?.(
          new DOMRect(0, 0, rect.width, rect.height),
          dpr,
          "rgb(255,255,255)"
        );
        if (bitmap) ctx.drawImage(bitmap, 0, 0);
      }

      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("toBlob returned null");
      const buf = await blob.arrayBuffer();
      const item = {
        name: `screenshot-${Date.now()}.png`,
        type: "image/png",
        bytes: new Uint8Array(buf),
        lastModified: Date.now(),
      };

      list.innerHTML = "";
      const row = document.createElementNS(ns, "div");
      row.className = "ef-item selected";
      row.tabIndex = 0;
      row.innerHTML = `
        <div class="ef-icon ef-icon-thumb"></div>
        <div class="ef-meta">
          <div class="ef-name"></div>
          <div class="ef-sub"></div>
        </div>
      `;
      row.querySelector(".ef-name").textContent = item.name;
      row.querySelector(".ef-sub").textContent = `image/png • ${formatSize(
        item.bytes.byteLength
      )}`;
      try {
        const url = URL.createObjectURL(blob);
        row.querySelector(".ef-icon").style.backgroundImage = `url("${url}")`;
      } catch {}
      list.appendChild(row);

      this.selectedFiles = [item];
      this._updateInfo();
      this._submit();
    } catch (e) {
      console.error("EasyFiles: screenshot failed", e);
      list.innerHTML = `<div class="ef-empty">Screenshot failed: ${escapeHtml(
        String(e.message || e)
      )}</div>`;
    }
  }

  _handleAction(action) {
    switch (action) {
      case "close":
        this.panel.hidePopup();
        break;
      case "browse":
        this._openNative();
        break;
      case "submit":
        this._submit();
        break;
      case "refresh-clipboard":
        this._loadClipboard();
        break;
      case "take-screenshot":
        this._takeScreenshot();
        break;
      case "pick-folder":
        this._pickFolder();
        break;
      case "toggle-source":
        this._toggleSource();
        break;
    }
  }

  _openNative() {
    if (this.activeWindowGlobal) {
      try {
        this.activeWindowGlobal
          .getActor("EasyFiles")
          .sendAsyncMessage("EasyFiles:OpenNative", {});
      } catch (e) {
        console.error("EasyFiles: openNative failed", e);
      }
    }
    this._submitted = true;
    this.panel.hidePopup();
  }

  _updateInfo() {
    const info = this.panel.querySelector('[data-info="info"]');
    const submitBtn = this.panel.querySelector('[data-action="submit"]');
    const count = this.selectedFiles.length;
    if (count) {
      info.textContent = `${count} file${count > 1 ? "s" : ""} selected`;
      submitBtn.classList.remove("hidden");
    } else {
      info.textContent = "";
      submitBtn.classList.add("hidden");
    }
  }

  _submit() {
    if (!this.activeWindowGlobal || !this.selectedFiles.length) return;

    const transferable = this.selectedFiles.map((f) => ({
      name: f.name,
      type: f.type,
      bytes: f.bytes,
      lastModified: f.lastModified,
    }));

    try {
      this.activeWindowGlobal
        .getActor("EasyFiles")
        .sendAsyncMessage("EasyFiles:SetFiles", { files: transferable });
    } catch (e) {
      console.error("EasyFiles: submit failed", e);
    }
    this._submitted = true;
    this.panel.hidePopup();
  }

  _onHidden() {
    if (this.activeWindowGlobal && !this._submitted) {
      try {
        this.activeWindowGlobal
          .getActor("EasyFiles")
          .sendAsyncMessage("EasyFiles:Cancel", {});
      } catch {}
    }
    this.activeBrowser = null;
    this.activeWindowGlobal = null;
    this.selectedFiles = [];
    this._submitted = false;
  }
}

function formatSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.round(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

const MIME_MAP = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  rar: "application/x-rar-compressed",
  "7z": "application/x-7z-compressed",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function guessMimeType(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return MIME_MAP[ext] || "application/octet-stream";
}

function acceptMatches(name, mime, acceptParts) {
  const ext = "." + (name.split(".").pop() || "").toLowerCase();
  for (const part of acceptParts) {
    if (part.startsWith(".")) {
      if (part.toLowerCase() === ext) return true;
    } else if (part.endsWith("/*")) {
      const prefix = part.slice(0, -1).toLowerCase();
      if (mime.toLowerCase().startsWith(prefix)) return true;
    } else if (part.includes("/")) {
      if (mime.toLowerCase() === part.toLowerCase()) return true;
    }
  }
  return false;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function collapsePath(p) {
  const parts = p.replace(/\\/g, "/").split("/");
  if (parts.length <= 3) return p;
  return parts.slice(0, 1).concat("…", parts.slice(-2)).join("/");
}

function init() {
  console.log("[EasyFiles] init() starting; SCRIPT_DIR =", SCRIPT_DIR);
  try {
    setupDefaults();
    if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) {
      console.log("[EasyFiles] disabled by pref, exiting");
      return;
    }

    injectStyle();
    registerActor();
    console.log("[EasyFiles] actor registered");

    const ctrl = new EasyFilesController();
    ctrl.init();
    window._easyFilesController = ctrl;
    console.log(
      "[EasyFiles] ready — click any <input type=file> on a webpage to test"
    );
  } catch (e) {
    console.error("[EasyFiles] init failed:", e);
  }
}

console.log(
  "[EasyFiles] script loaded in window:",
  window.location.href
);

if (window.location.href === "chrome://browser/content/browser.xhtml") {
  if (window.gBrowserInit?.delayedStartupFinished) {
    init();
  } else {
    const obs = (subject) => {
      if (subject !== window) return;
      Services.obs.removeObserver(obs, "browser-delayed-startup-finished");
      init();
    };
    Services.obs.addObserver(obs, "browser-delayed-startup-finished");
  }
}
