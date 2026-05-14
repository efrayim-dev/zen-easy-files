// ==UserScript==
// @name           Zen Easy Files
// @namespace      https://github.com/efrayim-dev/zen-easy-files
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
// Bumped on every release; logged at init() so users can confirm from the
// Browser Console that the version Sine pulled is actually the one running.
const MOD_VERSION = "1.6.2";

const PREF_ENABLED = "extensions.easy-files.enabled";
const PREF_LIMIT = "extensions.easy-files.recent-limit";
const PREF_BYPASS_KEY = "extensions.easy-files.bypass-modifier";
const PREF_RECENT_FOLDER = "extensions.easy-files.recent-folder";
const PREF_RECENT_SOURCE = "extensions.easy-files.recent-source";
const PREF_POPUP_POSITION = "extensions.easy-files.popup-position";

let _registered = false;

// nsIFilePicker factory suppressor state. Installed once per browser session
// (module-level, not per-controller) so script reloads don't double-register.
// While our panel is the active picker for a file input, this wrapper returns
// a no-op nsIFilePicker so Zen's chrome-side clipboard helper / native dialog
// path can't open on top of us. Outside that window the wrapper delegates to
// the original factory verbatim so Save As, attach in mail, etc. all work.
let _filePickerSuppressorInstalled = false;

// Discover EVERY registered XPCOM contract that looks file-picker-related and
// wrap them all. Zen Browser may register its own clipboard-image-aware
// filepicker under a custom contract ID alongside the standard one, in which
// case wrapping just "@mozilla.org/filepicker;1" misses Zen's path. This is
// also paranoid future-proofing: any forked or alternate filepicker we
// haven't seen will get caught too.
function discoverFilePickerContracts() {
  const matches = [];
  try {
    const registrar = Components.manager.QueryInterface(
      Ci.nsIComponentRegistrar
    );
    const contracts = registrar.enumerateContractIDs();
    while (contracts.hasMoreElements()) {
      let cid;
      try {
        cid = contracts
          .getNext()
          .QueryInterface(Ci.nsISupportsCString).data;
      } catch {
        continue;
      }
      if (/file[-_]?picker/i.test(cid)) {
        matches.push(cid);
      }
    }
  } catch (e) {
    console.error(
      "[EasyFiles] could not enumerate XPCOM contracts; falling back to canonical filepicker only",
      e
    );
  }
  if (matches.length === 0) {
    matches.push("@mozilla.org/filepicker;1");
  }
  return matches;
}

function buildSuppressorWrapper(originalFactory, contractIdLabel) {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    createInstance(arg1, arg2) {
      const usingLegacySig = arg2 !== undefined;

      let shouldSuppress = false;
      let untilDelta = "n/a";
      let ctrlState = "no-ctrl";
      try {
        const ctrl = window._easyFilesController;
        if (ctrl) {
          ctrlState =
            "suppress=" +
            !!ctrl._suppressNativePicker +
            ",until=" +
            (ctrl._suppressNativePickerUntil || 0);
          if (ctrl._suppressNativePicker) {
            const until = ctrl._suppressNativePickerUntil || 0;
            untilDelta = until - Date.now();
            if (untilDelta > 0) shouldSuppress = true;
          }
        }
      } catch (e) {
        ctrlState = "error:" + e.message;
      }

      console.log(
        "[EasyFiles] FilePicker.createInstance",
        "contract=" + contractIdLabel,
        "shouldSuppress=" + shouldSuppress,
        "windowMs=" + untilDelta,
        "ctrl=" + ctrlState,
        "legacySig=" + usingLegacySig
      );

      if (shouldSuppress) {
        console.log(
          "[EasyFiles] FilePicker.createInstance SUPPRESSED",
          "contract=" + contractIdLabel
        );
        return makeNoOpFilePicker();
      }

      try {
        if (usingLegacySig) {
          return originalFactory.createInstance(arg1, arg2);
        }
        return originalFactory.createInstance(arg1);
      } catch (e) {
        console.error(
          "[EasyFiles] FilePicker original factory threw, re-throwing",
          contractIdLabel,
          e
        );
        throw e;
      }
    },
  };
}

function installFilePickerSuppressor() {
  // Window-level guard so Sine script reloads don't chain wrappers on top
  // of wrappers (each iteration would close over the previous wrapper as
  // its delegate). The original wrapper stays live in the component
  // registrar and reads the latest controller via window._easyFilesController.
  if (window._easyFilesFilePickerSuppressorInstalled) {
    console.log(
      "[EasyFiles] FilePicker suppressor already installed (window flag); skipping"
    );
    _filePickerSuppressorInstalled = true;
    return;
  }
  if (_filePickerSuppressorInstalled) {
    console.log(
      "[EasyFiles] FilePicker suppressor already installed (module flag); skipping"
    );
    return;
  }

  const contracts = discoverFilePickerContracts();
  console.log(
    "[EasyFiles] discovered filepicker XPCOM contracts:",
    JSON.stringify(contracts)
  );

  let registrar;
  try {
    registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
  } catch (e) {
    console.error(
      "[EasyFiles] could not get nsIComponentRegistrar; suppressor not installed",
      e
    );
    return;
  }

  const wrapped = [];
  for (const contractId of contracts) {
    let cid;
    let originalFactory;
    try {
      cid = registrar.contractIDToCID(contractId);
      originalFactory = Components.manager.getClassObjectByContractID(
        contractId,
        Ci.nsIFactory
      );
    } catch (e) {
      console.warn(
        "[EasyFiles] could not look up factory for",
        contractId,
        "— skipping",
        e
      );
      continue;
    }

    const wrapperFactory = buildSuppressorWrapper(originalFactory, contractId);
    try {
      registrar.unregisterFactory(cid, originalFactory);
      registrar.registerFactory(
        cid,
        "EasyFiles FilePicker Wrapper (" + contractId + ")",
        contractId,
        wrapperFactory
      );
      wrapped.push(contractId);
    } catch (e) {
      console.error(
        "[EasyFiles] could not install wrapper for",
        contractId,
        e
      );
    }
  }

  _filePickerSuppressorInstalled = wrapped.length > 0;
  if (_filePickerSuppressorInstalled) {
    window._easyFilesFilePickerSuppressorInstalled = true;
    console.log(
      "[EasyFiles] FilePicker suppressor installed for contracts:",
      JSON.stringify(wrapped)
    );
  } else {
    console.error(
      "[EasyFiles] FilePicker suppressor NOT installed — no contracts wrapped"
    );
  }
}

// A minimal nsIFilePicker that signals "user cancelled" without opening any
// UI. Returned in place of the real picker while our panel is active.
function makeNoOpFilePicker() {
  return {
    QueryInterface: ChromeUtils.generateQI(["nsIFilePicker"]),
    init() {},
    appendFilters() {},
    appendFilter() {},
    appendRawFilter() {},
    defaultString: "",
    defaultExtension: "",
    filterIndex: 0,
    displayDirectory: null,
    displaySpecialDirectory: "",
    file: null,
    fileURL: null,
    files: null,
    domFileOrDirectory: null,
    domFileOrDirectoryEnumerator: null,
    addToRecentDocs: false,
    mode: 0,
    okButtonLabel: "",
    okButtonAccessKey: "",
    open(callback) {
      if (!callback) return;
      try {
        Services.tm.dispatchToMainThread(() => {
          try {
            callback.done(Ci.nsIFilePicker.returnCancel);
          } catch {}
        });
      } catch {}
    },
    show() {
      return Ci.nsIFilePicker.returnCancel;
    },
  };
}

function setupDefaults() {
  const branch = Services.prefs.getDefaultBranch("");
  const safeSet = (name, fn) => {
    try {
      if (branch.getPrefType(name) === 0) fn();
    } catch (e) {
      console.warn("[EasyFiles] setupDefaults skipped", name, e);
    }
  };
  safeSet(PREF_ENABLED, () => branch.setBoolPref(PREF_ENABLED, true));
  // PREF_LIMIT: Sine preferences.json declares it as a string field, so we
  // store the default as a string too. getLimitPref() reads either type.
  safeSet(PREF_LIMIT, () => branch.setStringPref(PREF_LIMIT, "15"));
  safeSet(PREF_BYPASS_KEY, () => branch.setStringPref(PREF_BYPASS_KEY, "shift"));
  safeSet(PREF_RECENT_FOLDER, () => branch.setStringPref(PREF_RECENT_FOLDER, ""));
  safeSet(PREF_RECENT_SOURCE, () => branch.setStringPref(PREF_RECENT_SOURCE, "folder"));
  safeSet(PREF_POPUP_POSITION, () =>
    branch.setStringPref(PREF_POPUP_POSITION, "trigger")
  );
}

// Try to find a usable system Downloads/Documents/Desktop directory. Returns
// { path, key } for the first one that actually exists, or { path: "" }.
function findSystemDefaultFolder() {
  // DfltDwnld = user's preferred Firefox download dir; Downld = OS Downloads;
  // Pers = Documents (Personal); Desk = Desktop; Home = profile-level home.
  for (const key of ["DfltDwnld", "Downld", "Pers", "Desk", "Home"]) {
    try {
      const dir = Services.dirsvc.get(key, Ci.nsIFile);
      if (dir?.path && dir.exists() && dir.isDirectory()) {
        return { path: dir.path, key };
      }
    } catch {}
  }
  return { path: "", key: null };
}

function pathIsValidDirectory(p) {
  if (!p) return false;
  try {
    const f = new FileUtils.File(p);
    return f.exists() && f.isDirectory();
  } catch {
    return false;
  }
}

// Resolve the folder we should scan for the Recent tab. Always tells the
// caller WHICH path was chosen and why, so empty/error states in the panel
// can show something actionable instead of just "Folder is empty".
//
// Returns:
//   {
//     path,            // absolute path string we will scan, or "" if none
//     source,          // "pref" | "default" | "fallback" | "none"
//     fallbackKey,     // dirsvc key used (only when source !== "pref")
//     configured,      // raw value of the pref (empty string if unset)
//     prefIsValid,     // true iff configured was a real directory
//   }
function resolveRecentFolder() {
  let configured = "";
  try {
    configured =
      (Services.prefs.getStringPref(PREF_RECENT_FOLDER, "") || "").trim();
  } catch {}

  const prefIsValid = configured ? pathIsValidDirectory(configured) : false;

  if (configured && prefIsValid) {
    return {
      path: configured,
      source: "pref",
      fallbackKey: null,
      configured,
      prefIsValid: true,
    };
  }

  const sys = findSystemDefaultFolder();
  if (sys.path) {
    return {
      path: sys.path,
      source: configured ? "fallback" : "default",
      fallbackKey: sys.key,
      configured,
      prefIsValid: false,
    };
  }

  return {
    path: "",
    source: "none",
    fallbackKey: null,
    configured,
    prefIsValid: false,
  };
}

// Backwards-compat helpers — kept for any existing callers; prefer
// resolveRecentFolder() when you also need to know about fallbacks.
function getDefaultDownloadsPath() {
  return findSystemDefaultFolder().path;
}

function getRecentFolderPath() {
  return resolveRecentFolder().path;
}

// Sine's preferences UI stores numeric inputs as STRING prefs (since
// `"type": "string"` in preferences.json), but our code wants an integer.
// Calling getIntPref on a string-type pref throws NS_ERROR_UNEXPECTED, which
// would silently kill _loadRecent. Read it tolerantly.
function getLimitPref(fallback = 15) {
  try {
    const t = Services.prefs.getPrefType(PREF_LIMIT);
    if (t === Services.prefs.PREF_INT) {
      return Services.prefs.getIntPref(PREF_LIMIT, fallback);
    }
    if (t === Services.prefs.PREF_STRING) {
      const raw = Services.prefs.getStringPref(PREF_LIMIT, "");
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > 0) return Math.min(n, 200);
    }
  } catch {}
  return fallback;
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
      // We need the actor (and its showOpenFilePicker override) ALIVE in every
      // frame *before* page script runs that might capture native references.
      // Google Sheets / Drive Picker iframes do exactly that — they snapshot
      // window.showOpenFilePicker at module load. So we register on:
      //   DOMDocElementInserted: earliest possible — fires before any author
      //     script in the document executes.
      //   pageshow: re-init after bf-cache restore (back/forward).
      //   click: still our primary trigger for <input type="file"> flows.
      events: {
        DOMDocElementInserted: { capture: true },
        pageshow: { capture: true },
        click: { capture: true, mozSystemGroup: true },
      },
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
  // Always rebuild. If a previous script load left a panel behind, the new
  // controller would otherwise attach listeners to stale HTML that may not
  // match this script version. Cleanest path is to nuke and rebuild.
  const stale = document.getElementById(PANEL_ID);
  if (stale) {
    try {
      stale.hidePopup?.();
    } catch {}
    stale.remove();
    console.log("[EasyFiles] removed stale panel and rebuilding");
  }

  let panel = document.createXULElement("panel");
  panel.id = PANEL_ID;
  panel.setAttribute("type", "arrow");
  panel.setAttribute("noautofocus", "false");
  panel.setAttribute("class", "easy-files-popup");
  panel.setAttribute("orient", "vertical");
  // Default panel behavior auto-hides on focus loss / popup-hierarchy
  // changes. Some sites (notably company ERPs that show their own
  // clipboard-image preview overlay alongside the file input) open a
  // sibling popup or move focus immediately after the click that opened
  // us — that triggers autohide and the panel disappears the same frame
  // it opened. With noautohide=true we stay open until the user picks
  // files, presses Esc, clicks the X, or clicks the trigger again.
  panel.setAttribute("noautohide", "true");
  // Allow clicks that happen outside the panel to still reach the
  // underlying chrome/page (so the user can interact normally with the
  // browser without our panel swallowing input). They just won't close
  // the panel automatically — that is intentional.
  panel.setAttribute("consumeoutsideclicks", "false");
  // level=top keeps us above the site's own popups when both are visible.
  panel.setAttribute("level", "top");

  // Parse the template through DOMParser as real HTML and import the tree.
  // Direct innerHTML on an XHTML div inside browser.xhtml has a quirk where
  // <button> tags get materialised as XUL buttons, which silently drop
  // data-* attributes. Going through DOMParser("text/html") forces HTML5
  // parsing rules and guarantees real HTMLButtonElement nodes.
  const tpl = `<!DOCTYPE html><html><body><div class="ef-root">
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
            <button class="ef-folder-btn" data-action="refresh-recent" title="Rescan folder">🔄</button>
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
  </div></body></html>`;

  const parser = new DOMParser();
  const doc = parser.parseFromString(tpl, "text/html");
  const parsedRoot = doc.body.firstElementChild;
  const root = document.importNode(parsedRoot, true);
  panel.appendChild(root);

  const popupSet =
    document.getElementById("mainPopupSet") || document.documentElement;
  popupSet.appendChild(panel);

  const actionBtns = panel.querySelectorAll("[data-action]");
  const allEls = panel.querySelectorAll("*");
  console.log(
    "[EasyFiles] buildPanel done; totalElements=",
    allEls.length,
    "rootChildren=",
    root.children.length,
    "buttons=",
    panel.querySelectorAll("button").length,
    "actionButtons=",
    actionBtns.length,
    "submitBtn=",
    !!panel.querySelector('[data-action="submit"]')
  );
  if (!actionBtns.length) {
    console.warn(
      "[EasyFiles] no [data-action] buttons - dumping element tree for diagnosis:",
      Array.from(allEls).map((el) => ({
        tag: el.localName,
        ns: el.namespaceURI,
        attrs: Array.from(el.attributes)
          .map((a) => a.name)
          .join(","),
      }))
    );
  }
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
    // When a site sends an `accept` filter (e.g., Imgur "image/*", Sheets "text/csv,…")
    // we default to showing only matching files. Clicking "Show all" in the
    // panel flips this for the current panel session. Reset to false on each
    // open so the next picker invocation starts back in filtered mode.
    this.showAllRecent = false;
    // Read by the chrome-level nsIFilePicker factory wrapper to decide
    // whether to suppress native picker creation. Both must be truthy and
    // _suppressNativePickerUntil must still be in the future.
    this._suppressNativePicker = false;
    this._suppressNativePickerUntil = 0;
  }

  init() {
    this.panel = buildPanel();
    // Diagnostic logging: when the panel closes against our intent (e.g.
    // a focus-driven autohide despite noautohide=true) the only signal
    // we get is the popuphiding / popuphidden pair. Logging timing +
    // origin event lets us correlate panel death to whatever the page
    // did right before. Cheap to leave on; fires at most twice per open.
    this.panel.addEventListener("popupshown", () => {
      this._lastShownAt = Date.now();
      console.log("[EasyFiles] popupshown at", this._lastShownAt);
    });
    this.panel.addEventListener("popuphiding", (e) => {
      const dt = this._lastShownAt
        ? Date.now() - this._lastShownAt
        : "n/a";
      console.log(
        "[EasyFiles] popuphiding (closing)",
        "msSinceShown=" + dt,
        "submitted=" + this._submitted,
        "originalTarget=",
        e.originalTarget?.id || e.originalTarget?.nodeName
      );
    });
    this.panel.addEventListener("popuphidden", () => this._onHidden());
    this.panel.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.panel.hidePopup();
    });

    // With noautohide=true the platform won't dismiss us when the user
    // clicks elsewhere. Reproduce that affordance manually so users can
    // still click anywhere to cancel — but only on chrome-side mousedowns
    // (browser UI) and only when our panel is currently open. Content
    // clicks live in another process and we deliberately don't try to
    // catch them here; selecting a file or pressing Esc is the in-content
    // dismissal path.
    const onChromeMouseDown = (e) => {
      if (!this.panel || this.panel.state !== "open") return;
      if (this.panel.contains(e.target)) return;
      console.log(
        "[EasyFiles] chrome mousedown outside panel; dismissing",
        e.target?.id || e.target?.nodeName
      );
      try {
        this.panel.hidePopup();
      } catch {}
    };
    document.addEventListener("mousedown", onChromeMouseDown, true);
    this._onChromeMouseDown = onChromeMouseDown;

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

    // Single window-level dispatcher pattern. Instead of each controller
    // attaching its own listener (which leaks across script reloads since
    // pre-destroy() versions can't be cleaned up), we keep ONE function
    // reference on window._easyFilesPickerListener. Every script reload
    // removes the old one (whatever it was) and installs a fresh one that
    // delegates to whatever window._easyFilesController points at right now.
    if (window._easyFilesPickerListener) {
      try {
        window.removeEventListener(
          "EasyFiles:RequestPicker",
          window._easyFilesPickerListener
        );
      } catch {}
    }
    const dispatch = (e) => {
      const ctrl = window._easyFilesController;
      if (ctrl) ctrl._onRequest(e);
    };
    window.addEventListener("EasyFiles:RequestPicker", dispatch);
    window._easyFilesPickerListener = dispatch;
    console.log(
      "[EasyFiles] controller initialized, panel built, listening for EasyFiles:RequestPicker"
    );
  }

  destroy() {
    // The window-level dispatcher (window._easyFilesPickerListener) is
    // managed by init() across reloads, so we don't touch it here. We just
    // null out our panel reference so any in-flight async handlers no-op.
    if (this._onChromeMouseDown) {
      try {
        document.removeEventListener(
          "mousedown",
          this._onChromeMouseDown,
          true
        );
      } catch {}
      this._onChromeMouseDown = null;
    }
    this.panel = null;
    console.log("[EasyFiles] previous controller destroyed");
  }

  async _onRequest(event) {
    if (!this.panel) {
      console.log(
        "[EasyFiles] _onRequest fired on destroyed controller, ignoring"
      );
      return;
    }
    console.log("[EasyFiles] _onRequest fired, detail=", event.detail);
    const { detail } = event;
    this.activeBrowser = detail.browser;
    this.activeWindowGlobal = detail.windowGlobal;
    this.requestData = detail.data || {};
    this.selectedFiles = [];
    this._submitted = false;
    this.showAllRecent = false;
    // Arm the chrome-level nsIFilePicker suppressor. While these are set,
    // any attempt to open a native file picker (Zen's chrome handler, the
    // OS file dialog, etc.) gets a no-op picker that signals user-cancel.
    // _suppressNativePickerUntil acts as a safety deadline in case
    // _onHidden never fires (controller destroyed mid-flight). 5 seconds
    // is comfortably longer than any real picker open latency.
    this._suppressNativePicker = true;
    this._suppressNativePickerUntil = Date.now() + 5000;

    this._switchTab("recent");
    this._updateInfo();

    this._openPanel(detail);
    this._loadRecent();
  }

  _openPanel(detail) {
    const browser =
      detail.browser ||
      window.gBrowser?.selectedBrowser ||
      document.documentElement;
    const triggerRect = detail.data?.triggerRect;
    let position;
    try {
      position = Services.prefs.getStringPref(PREF_POPUP_POSITION, "trigger");
    } catch {
      position = "trigger";
    }

    console.log(
      "[EasyFiles] opening panel; position=",
      position,
      "triggerRect=",
      triggerRect,
      "panelState(before)=",
      this.panel?.state
    );

    try {
      if (position === "trigger" && triggerRect) {
        // Anchor right under the visible clicked element using screen coords.
        // Firefox auto-flips the panel above the anchor if there isn't enough
        // space below the screen.
        const x = Math.round(triggerRect.screenX);
        const y = Math.round(triggerRect.screenBottom);
        this.panel.openPopupAtScreen(x, y, false);
      } else if (position === "bottom") {
        // Bottom of the page: align panel's bottom edge to browser's bottom
        // edge, horizontally centered.
        this.panel.openPopup(
          browser,
          "bottomcenter bottomcenter",
          0,
          0,
          false,
          false
        );
      } else {
        // Fallback: trigger preferred but no rect (e.g. showOpenFilePicker
        // API call has no DOM target). Anchor near the top-center of the
        // browser content.
        this.panel.openPopup(
          browser,
          "topcenter topcenter",
          0,
          80,
          false,
          false
        );
      }
    } catch (e) {
      console.error("[EasyFiles] openPopup threw:", e);
    }

    Promise.resolve().then(() => {
      console.log(
        "[EasyFiles] panel state after openPopup:",
        this.panel?.state
      );
    });
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
      return;
    }

    const info = resolveRecentFolder();
    if (!info.path) {
      label.textContent = "(no folder configured)";
      label.title =
        "Open mod settings or click 📁 to set the Recent files folder.";
      return;
    }

    let prefix = "📂 ";
    let title = info.path;
    if (info.source === "fallback") {
      prefix = "⚠️ ";
      title =
        "Configured folder is invalid: " +
        (info.configured || "(empty)") +
        "\nFalling back to: " +
        info.path;
    } else if (info.source === "default") {
      title = "Default OS folder: " + info.path;
    }
    label.textContent = prefix + collapsePath(info.path);
    label.title = title;
  }

  async _loadRecent() {
    const list = this.panel.querySelector('[data-list="recent"]');
    list.innerHTML = '<div class="ef-empty">Loading…</div>';
    this._updateFolderLabel();

    try {
      const limit = getLimitPref(15);
      const accept = (this.requestData?.accept || "").toLowerCase();
      const acceptParts = accept
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const source = this._getRecentSource();
      const t0 = Date.now();
      let scan;
      if (source === "downloads") {
        const items = await this._collectFromDownloadHistory();
        scan = {
          items,
          path: "(Zen download history)",
          totalEntries: items.length,
          error: null,
          source,
        };
      } else {
        scan = this._collectFromFolder();
      }
      console.log(
        "[EasyFiles] recent scan:",
        "source=" + scan.source,
        "path=" + scan.path,
        "rawEntries=" + scan.totalEntries,
        "items=" + scan.items.length,
        "acceptParts=" + acceptParts.length,
        "took=" + (Date.now() - t0) + "ms",
        scan.error ? "error=" + scan.error : ""
      );

      const items = scan.items;
      items.sort((a, b) => b.mtime - a.mtime);

      list.innerHTML = "";

      // No accept filter: just render the most recent N items, no toggle UI
      // needed. The whole site wants any file — everything matches.
      if (!acceptParts.length) {
        const display = items.slice(0, limit);
        this.recentDownloads = display;
        if (!display.length) {
          list.appendChild(this._buildEmptyMessage(scan));
          return;
        }
        for (const item of display) {
          list.appendChild(this._makeRow(item, true));
        }
        return;
      }

      // Accept filter present. Split items into matches/non-matches BEFORE
      // slicing so the user always sees up to `limit` files that the site
      // will actually accept (rather than burning slots on dimmed misses).
      const matching = [];
      const nonMatching = [];
      for (const it of items) {
        if (acceptMatches(it.name, it.mime, acceptParts)) {
          matching.push(it);
        } else {
          nonMatching.push(it);
        }
      }

      // Show-all mode (toggled by the user via "Show all"): render matches
      // first, then dimmed non-matches, both capped at `limit` combined.
      if (this.showAllRecent) {
        const merged = matching.concat(nonMatching).slice(0, limit);
        this.recentDownloads = merged;
        if (!merged.length) {
          list.appendChild(this._buildEmptyMessage(scan));
          return;
        }
        for (const it of merged) {
          list.appendChild(
            this._makeRow(it, acceptMatches(it.name, it.mime, acceptParts))
          );
        }
        list.appendChild(
          this._buildShowAllToggleRow({
            mode: "showLess",
            acceptedCount: matching.length,
            hiddenCount: 0,
            accept,
          })
        );
        return;
      }

      // Default mode: only show matches.
      const display = matching.slice(0, limit);
      this.recentDownloads = display;

      if (!display.length) {
        // No matching recent files. Show a clear explanation, then offer to
        // expand to the unfiltered list so the user can override.
        const note = document.createElementNS(
          "http://www.w3.org/1999/xhtml",
          "div"
        );
        note.className = "ef-note";
        note.textContent = `No recent files match what this site accepts (${escapeHtml(
          accept
        )}).`;
        list.appendChild(note);
        if (nonMatching.length) {
          list.appendChild(
            this._buildShowAllToggleRow({
              mode: "showAll",
              acceptedCount: 0,
              hiddenCount: nonMatching.length,
              accept,
            })
          );
        } else {
          list.appendChild(this._buildEmptyMessage(scan));
        }
        return;
      }

      for (const item of display) {
        list.appendChild(this._makeRow(item, true));
      }

      if (nonMatching.length) {
        list.appendChild(
          this._buildShowAllToggleRow({
            mode: "showAll",
            acceptedCount: matching.length,
            hiddenCount: nonMatching.length,
            accept,
          })
        );
      }
    } catch (e) {
      console.error("[EasyFiles] load recent failed", e);
      list.innerHTML = `<div class="ef-empty">Error: ${escapeHtml(
        String(e.message || e)
      )}</div>`;
    }
  }

  // Footer row that toggles between filtered ("Show all N hidden") and
  // unfiltered ("Show only matching") views. Lives inline in the recent list
  // so it's contextually obvious — no separate settings menu to discover.
  _buildShowAllToggleRow({ mode, hiddenCount }) {
    const ns = "http://www.w3.org/1999/xhtml";
    const row = document.createElementNS(ns, "div");
    row.className = "ef-show-all-row";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");

    const label = document.createElementNS(ns, "span");
    label.className = "ef-show-all-label";
    if (mode === "showAll") {
      label.textContent = `Show ${hiddenCount} more recent file${
        hiddenCount === 1 ? "" : "s"
      } (this site says it doesn't accept them)`;
    } else {
      label.textContent = "Show only files this site accepts";
    }
    row.appendChild(label);

    // Listener attached directly because this row is built dynamically per
    // _loadRecent() call, after init()'s [data-action] delegation already ran.
    const trigger = () => this._handleAction("toggle-show-all");
    row.addEventListener("click", trigger);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        trigger();
      }
    });

    return row;
  }

  // Render an actionable empty state. Tells the user exactly which folder
  // was scanned, how many entries were skipped (subdirectories etc.), and
  // suggests next steps based on what went wrong.
  _buildEmptyMessage(scan) {
    const ns = "http://www.w3.org/1999/xhtml";
    const wrap = document.createElementNS(ns, "div");
    wrap.className = "ef-empty";

    const lines = [];
    if (scan.source === "downloads") {
      lines.push("No items in Zen's download history.");
      lines.push(
        "Tip: switch the source to a folder using the ⇄ button above."
      );
    } else if (scan.source === "none" || !scan.path) {
      lines.push("Could not find a folder to scan.");
      lines.push("Click 📁 to choose one, or set it in Sine mod settings.");
    } else if (scan.error) {
      lines.push("Could not read the folder:");
      lines.push(scan.path);
      lines.push("Reason: " + scan.error);
    } else if (scan.totalEntries === 0) {
      lines.push("Folder is empty:");
      lines.push(scan.path);
    } else {
      // We saw entries but ended up with zero usable files (e.g., the folder
      // only contained subfolders, or all entries were skipped).
      lines.push("Folder has no regular files:");
      lines.push(scan.path);
      lines.push(
        `(${scan.totalEntries} entries seen, but none were files we could list.)`
      );
    }

    const info = resolveRecentFolder();
    if (
      scan.source === "fallback" ||
      (info.configured && !info.prefIsValid && scan.source !== "none")
    ) {
      lines.push("");
      lines.push(
        "⚠️ Your configured folder isn't a valid directory: " +
          (info.configured || "(empty)")
      );
      lines.push("Falling back to system default. Click 📁 to fix.");
    }

    for (const line of lines) {
      const div = document.createElementNS(ns, "div");
      div.textContent = line;
      wrap.appendChild(div);
    }
    return wrap;
  }

  async _collectFromDownloadHistory() {
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

  // Synchronous nsIFile-based listing. Reading metadata via IOUtils.stat() in a
  // loop is O(N) async calls and gets unusably slow on large folders (the
  // user's Downloads has ~7700 files). nsIFile.directoryEntries hits the OS
  // once and lets us read leafName/fileSize/lastModifiedTime cheaply per entry.
  //
  // Returns a scan record:
  //   { items, path, source, totalEntries, error }
  //  - items: the {path,name,size,mtime,mime} objects suitable for the UI
  //  - path: the actual folder we scanned (may differ from the configured
  //    pref if we fell back to a default)
  //  - source: "pref" | "default" | "fallback" | "none"
  //  - totalEntries: count of every entry the OS returned, before filtering
  //    out subdirectories/dotfiles. Lets the empty state distinguish
  //    "folder really has nothing" from "folder is full of subfolders".
  //  - error: human-readable reason this scan produced nothing, or null.
  _collectFromFolder() {
    const info = resolveRecentFolder();
    const empty = (error = null) => ({
      items: [],
      path: info.path,
      source: info.source,
      totalEntries: 0,
      error,
    });

    if (!info.path) {
      return empty(
        info.configured
          ? `No usable folder. Configured "${info.configured}" is invalid and no system Downloads folder was found.`
          : "No system Downloads folder was found."
      );
    }

    let dir;
    try {
      dir = new FileUtils.File(info.path);
      if (!dir.exists() || !dir.isDirectory()) {
        return empty("Path is not a directory: " + info.path);
      }
    } catch (e) {
      console.warn("EasyFiles: invalid folder", info.path, e);
      return empty("Could not open folder: " + (e?.message || e));
    }

    let entries;
    try {
      entries = dir.directoryEntries;
    } catch (e) {
      console.warn("EasyFiles: directoryEntries failed", info.path, e);
      return empty("Could not enumerate folder: " + (e?.message || e));
    }

    const out = [];
    let total = 0;
    while (true) {
      let file;
      try {
        if (!entries.hasMoreElements()) break;
        file = entries.getNext().QueryInterface(Ci.nsIFile);
      } catch {
        break;
      }
      total++;
      try {
        if (!file.isFile()) continue;
        const name = file.leafName;
        if (name.startsWith(".")) continue;
        out.push({
          path: file.path,
          name,
          size: file.fileSize,
          mtime: file.lastModifiedTime,
          mime: guessMimeType(name),
        });
      } catch {}
    }

    return {
      items: out,
      path: info.path,
      source: info.source,
      totalEntries: total,
      error: null,
    };
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

  _makeRow(item, matchesAccept = true) {
    const ns = "http://www.w3.org/1999/xhtml";
    const row = document.createElementNS(ns, "div");
    row.className = "ef-item" + (matchesAccept ? "" : " ef-item-nomatch");
    row.dataset.path = item.path;
    row.dataset.name = item.name;
    row.tabIndex = 0;
    if (!matchesAccept) {
      row.title = "This file does not match the site's accept filter; the site may reject it.";
    }

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
      case "refresh-recent":
        this._loadRecent();
        break;
      case "toggle-show-all":
        this.showAllRecent = !this.showAllRecent;
        this._loadRecent();
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
    if (!info || !submitBtn) {
      console.error("[EasyFiles] _updateInfo: panel elements missing", {
        panelId: this.panel?.id,
        panelInDoc: !!this.panel?.ownerDocument?.contains(this.panel),
        infoFound: !!info,
        submitFound: !!submitBtn,
        actionButtons: Array.from(
          this.panel?.querySelectorAll("[data-action]") || []
        ).map((b) => b.dataset.action),
        rootChildren: this.panel?.querySelector(".ef-root")?.children.length,
      });
      return;
    }
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
    this.showAllRecent = false;
    this._suppressNativePicker = false;
    this._suppressNativePickerUntil = 0;
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
  console.log(
    "[EasyFiles] mod version " + MOD_VERSION + " init starting; SCRIPT_DIR =",
    SCRIPT_DIR
  );
  try {
    if (window._easyFilesController) {
      try {
        window._easyFilesController.destroy();
      } catch (e) {
        console.warn("[EasyFiles] previous destroy threw:", e);
      }
      window._easyFilesController = null;
    }

    setupDefaults();
    if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) {
      console.log("[EasyFiles] disabled by pref, exiting");
      return;
    }

    injectStyle();

    // Install the nsIFilePicker suppressor BEFORE registering the actor.
    // If anything in registerActor() throws, the suppressor is still
    // active so we at least block the native dialog when our content
    // intercepts catch a click. (And install is idempotent across
    // reloads via the window-level guard, so calling it first does no
    // harm if init runs multiple times.)
    installFilePickerSuppressor();

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
