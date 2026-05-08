// Content-process side of the EasyFiles JSWindowActor.
//
// Two interception paths:
//
// 1. Click interception on <input type="file"> AND on <label> elements that
//    are associated (via `for=` or by containment) with a file input. Catching
//    the LABEL click is essential because when a user clicks `<label for="x">`,
//    Firefox internally calls inputElement.click() to open the picker — and
//    that synthetic click event has `cancelable: false`, so preventDefault
//    on it is silently a no-op. The original LABEL click IS cancelable, so
//    we must cancel that one.
//
// 2. Override of `window.showOpenFilePicker` (File System Access API). Modern
//    upload UIs like Google Drive Picker, Sheets/Docs uploaders, and many SPAs
//    invoke `showOpenFilePicker` directly instead of clicking a hidden file
//    input — those flows never go through path 1.

export class EasyFilesChild extends JSWindowActorChild {
  pendingInput = null;
  pendingLabel = null; // matched <label> (if any) — some libraries listen here
  pendingApi = null; // { resolve, reject, originalFn, win, multiple }
  _bypassNext = false;
  _injected = false;

  actorCreated() {
    console.log(
      "[EasyFilesChild] actor created in",
      this.contentWindow?.location?.href
    );
    this._injectAPIOverride();
  }

  // Replace window.showOpenFilePicker with a chrome-side wrapper that routes
  // through the EasyFiles panel. We do this in actorCreated() so the override
  // is in place before any page script captures a reference to the original.
  _injectAPIOverride() {
    if (this._injected) return;
    const win = this.contentWindow;
    if (!win) return;
    if (typeof win.showOpenFilePicker !== "function") return;

    this._injected = true;

    const originalFn = win.showOpenFilePicker.bind(win);
    const actor = this;

    const wrapped = function (options) {
      // 'this' here is the content window (exportFunction binds appropriately
      // for unbound function references); we use win from the closure.
      const winRef = win;

      return new winRef.Promise((resolve, reject) => {
        if (actor.pendingApi || actor.pendingInput) {
          reject(
            new winRef.DOMException(
              "Picker is already open.",
              "InvalidStateError"
            )
          );
          return;
        }

        let acceptParts = [];
        let multiple = false;
        try {
          if (options && typeof options === "object") {
            multiple = !!options.multiple;
            const types = options.types;
            if (types && typeof types[Symbol.iterator] === "function") {
              for (const t of types) {
                const accept = t?.accept;
                if (accept && typeof accept === "object") {
                  for (const mime of Object.keys(accept)) {
                    if (mime && mime !== "*/*") acceptParts.push(mime);
                    const exts = accept[mime];
                    if (exts && typeof exts[Symbol.iterator] === "function") {
                      for (const ext of exts) {
                        if (typeof ext === "string") acceptParts.push(ext);
                      }
                    }
                  }
                }
              }
            }
          }
        } catch (e) {
          console.warn("[EasyFilesChild] showOpenFilePicker option parse", e);
        }

        actor.pendingApi = {
          resolve,
          reject,
          originalFn,
          win: winRef,
          multiple,
        };

        try {
          actor.sendAsyncMessage("EasyFiles:Show", {
            accept: acceptParts.join(","),
            multiple,
            capture: "",
            pageURL: winRef.location?.href || "",
            apiMode: "showOpenFilePicker",
          });
        } catch (e) {
          actor.pendingApi = null;
          reject(
            new winRef.DOMException(
              "Failed to open picker: " + (e?.message || e),
              "InvalidStateError"
            )
          );
        }
      });
    };

    try {
      Cu.exportFunction(wrapped, win, { defineAs: "showOpenFilePicker" });
      console.log(
        "[EasyFilesChild] showOpenFilePicker override installed for",
        win.location?.href
      );
    } catch (e) {
      console.error("[EasyFilesChild] exportFunction failed", e);
      this._injected = false;
    }
  }

  handleEvent(event) {
    if (event.type !== "click") return;

    // Diagnostic ping. Helps confirm in the Browser Console that the actor is
    // alive and receiving clicks. Distinguishes "script not loaded" from
    // "loaded but click target wasn't a file input or its label".
    const initialTag =
      (event.target?.tagName || "?") +
      (event.target?.type ? `[type=${event.target.type}]` : "");
    console.log(
      "[EasyFilesChild] click",
      "tag=" + initialTag,
      "trusted=" + event.isTrusted,
      "cancelable=" + event.cancelable,
      "url=" + (this.contentWindow?.location?.href || "?")
    );

    let target = null;
    let matchedVia = "";
    let path = [];
    if (typeof event.composedPath === "function") {
      try {
        path = event.composedPath();
      } catch {}
    }

    // 1. composedPath includes a file input (covers label-contains-input AND
    //    direct INPUT clicks). composedPath also crosses shadow boundaries.
    for (const node of path) {
      if (node?.tagName === "INPUT" && node.type === "file") {
        target = node;
        matchedVia = "input-in-path";
        break;
      }
    }

    // 2. composedPath includes a <label> whose `.control` is a file input.
    //    This is the critical case for label-uses-`for=` patterns (Imgur,
    //    many React/Tailwind upload widgets) where the synthesized INPUT
    //    click is non-cancelable, so we MUST cancel the LABEL click instead.
    let matchedLabel = null;
    if (!target) {
      for (const node of path) {
        if (node?.tagName !== "LABEL") continue;
        let ctrl = null;
        try {
          ctrl = node.control;
        } catch {}
        if (ctrl?.tagName === "INPUT" && ctrl.type === "file") {
          target = ctrl;
          matchedLabel = node;
          matchedVia = "label-control";
          break;
        }
      }
    }

    if (!target) {
      target = event.target;
      if (!target || target.tagName !== "INPUT" || target.type !== "file") {
        return;
      }
      matchedVia = "direct-target";
    }

    console.log(
      "[EasyFilesChild] file input click",
      "via=" + matchedVia,
      "trusted=" + event.isTrusted,
      "cancelable=" + event.cancelable,
      "shift=" + event.shiftKey,
      "disabled=" + target.disabled,
      "bypassNext=" + this._bypassNext,
      "target=",
      target
    );

    if (target.disabled) return;

    if (this._bypassNext) {
      this._bypassNext = false;
      return;
    }

    // Hold Shift to skip our picker and go straight to the native picker.
    if (event.shiftKey) return;

    // NOTE: We deliberately do NOT bail on !event.isTrusted. Many UI libraries
    // (React-Dropzone, Material UI, etc.) implement Browse buttons as a styled
    // element whose onclick calls hiddenInput.click() — that synthesized click
    // has isTrusted=false but is still a user-initiated picker invocation.
    // Platform user-activation rules block silent automated picker opens.

    if (event.cancelable) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      // Non-cancelable click: most likely a non-cancelable synthesized click
      // from element.click() during a label flow. We can't stop the picker
      // from this event, but we still try to show our panel — and we let the
      // caller know via the log so they understand what happened.
      console.warn(
        "[EasyFilesChild] click was not cancelable; native picker may also open. " +
          "If you see both, the LABEL click was missed in capture phase."
      );
    }

    this.pendingInput = target;
    this.pendingLabel = matchedLabel;

    let accept = "";
    let multiple = false;
    let capture = "";
    try {
      accept = target.accept || "";
      multiple = !!target.multiple;
      capture = target.capture || "";
    } catch {}

    // Capture screen-space rect of the visible clicked element so the chrome
    // side can anchor the panel right below it. Walk up from event.target to
    // find the first ancestor with a non-zero bounding rect — file inputs are
    // often display:none or width:0 and we need a real anchor.
    const triggerRect = this._computeTriggerRect(event);

    this.sendAsyncMessage("EasyFiles:Show", {
      accept,
      multiple,
      capture,
      pageURL: this.contentWindow?.location?.href || "",
      apiMode: "input",
      triggerRect,
    });
  }

  _computeTriggerRect(event) {
    try {
      const path = event.composedPath ? event.composedPath() : [event.target];
      const win = this.contentWindow;
      const screenOriginX = win?.mozInnerScreenX || 0;
      const screenOriginY = win?.mozInnerScreenY || 0;
      for (const node of path) {
        if (!node || typeof node.getBoundingClientRect !== "function") continue;
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return {
            screenX: r.left + screenOriginX,
            screenY: r.top + screenOriginY,
            screenBottom: r.bottom + screenOriginY,
            width: r.width,
            height: r.height,
          };
        }
      }
    } catch (e) {
      console.warn("[EasyFilesChild] computeTriggerRect failed:", e);
    }
    return null;
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "EasyFiles:SetFiles": {
        if (this.pendingApi) {
          this._resolveApiWithFiles(message.data.files || []);
          return;
        }
        if (this.pendingInput) {
          this._setFilesOnInput(message.data.files || []);
          return;
        }
        return;
      }

      case "EasyFiles:Cancel": {
        if (this.pendingApi) {
          const { reject, win } = this.pendingApi;
          this.pendingApi = null;
          try {
            reject(
              new win.DOMException("The user aborted a request.", "AbortError")
            );
          } catch {}
          return;
        }
        this.pendingInput = null;
        this.pendingLabel = null;
        return;
      }

      case "EasyFiles:OpenNative": {
        if (this.pendingApi) {
          const { resolve, reject, originalFn, win } = this.pendingApi;
          this.pendingApi = null;
          try {
            const p = originalFn();
            // p is a content-side Promise; chain through.
            p.then(
              (r) => {
                try {
                  resolve(r);
                } catch {}
              },
              (e) => {
                try {
                  reject(e);
                } catch {}
              }
            );
          } catch (e) {
            try {
              reject(
                new win.DOMException(
                  "Failed to open native picker: " + (e?.message || e),
                  "InvalidStateError"
                )
              );
            } catch {}
          }
          return;
        }
        if (!this.pendingInput) return;
        const input = this.pendingInput;
        this.pendingInput = null;
        this.pendingLabel = null;
        this._bypassNext = true;
        try {
          if (typeof input.showPicker === "function") input.showPicker();
          else input.click();
        } catch (e) {
          // Most common cause: missing user activation. The user can hold
          // Shift on the original click to bypass our handler entirely.
          console.warn("EasyFilesChild: native picker open failed", e);
        }
        return;
      }
    }
  }

  _setFilesOnInput(files) {
    if (!this.pendingInput) {
      console.warn("[EasyFilesChild] _setFilesOnInput: no pendingInput");
      return;
    }
    const win = this.contentWindow;
    if (!win) {
      this.pendingInput = null;
      this.pendingLabel = null;
      return;
    }

    const input = this.pendingInput;
    const label = this.pendingLabel;
    this.pendingInput = null;
    this.pendingLabel = null;

    if (!input.isConnected) {
      console.warn(
        "[EasyFilesChild] target input is no longer in the DOM; site may have replaced it. Aborting file drop."
      );
      return;
    }

    try {
      const dt = new win.DataTransfer();
      for (const fd of files) {
        // The bytes arrived from the parent via sendAsyncMessage and live in
        // *this* (chrome) compartment. We can't pass that buffer directly into
        // a content-scope Blob constructor — Firefox's cross-compartment
        // security wrappers throw "Permission denied to access object". The
        // fix is to structured-clone the underlying ArrayBuffer INTO the
        // content scope using Cu.cloneInto, then build the Blob from that.
        const sourceBuffer =
          fd.bytes instanceof Uint8Array
            ? fd.bytes.buffer.slice(
                fd.bytes.byteOffset,
                fd.bytes.byteOffset + fd.bytes.byteLength
              )
            : fd.bytes;
        const contentBuffer = Cu.cloneInto(sourceBuffer, win);
        const blob = new win.Blob([contentBuffer], { type: fd.type || "" });
        const file = new win.File([blob], fd.name, {
          type: fd.type || "",
          lastModified: fd.lastModified || Date.now(),
        });
        dt.items.add(file);
      }

      // Use the native setter on HTMLInputElement.prototype.files so any value-
      // tracking proxy from React/Vue/etc. sees a real assignment. Direct
      // `input.files = ...` can be a silent no-op when the framework has
      // wrapped the property descriptor.
      let setterUsed = "direct";
      try {
        const proto = win.HTMLInputElement?.prototype;
        const desc =
          proto && Object.getOwnPropertyDescriptor(proto, "files");
        if (desc?.set) {
          desc.set.call(input, dt.files);
          setterUsed = "native-setter";
        } else {
          input.files = dt.files;
        }
      } catch (e) {
        console.warn(
          "[EasyFilesChild] native files setter failed, falling back",
          e
        );
        try {
          input.files = dt.files;
        } catch (e2) {
          console.error(
            "[EasyFilesChild] direct files assignment also failed",
            e2
          );
        }
      }

      const inputEvt = new win.Event("input", {
        bubbles: true,
        composed: true,
      });
      const changeEvt = new win.Event("change", {
        bubbles: true,
        composed: true,
      });
      input.dispatchEvent(inputEvt);
      input.dispatchEvent(changeEvt);

      // Some upload widgets attach their listener to the LABEL wrapper, not the
      // hidden input itself. Re-fire change there too — harmless if nobody is
      // listening, decisive if they are.
      if (label && label.isConnected) {
        try {
          label.dispatchEvent(
            new win.Event("change", { bubbles: true, composed: true })
          );
        } catch {}
      }

      console.log(
        "[EasyFilesChild] files dropped:",
        files.map((f) => `${f.name}(${f.bytes?.byteLength ?? f.bytes?.length}b)`).join(", "),
        "setter=" + setterUsed,
        "input.files.length=" + input.files?.length,
        "input=",
        input,
        "alsoFiredOnLabel=" + !!(label && label.isConnected)
      );
    } catch (e) {
      console.error("[EasyFilesChild] setting files failed", e);
    }
  }

  // Resolve a pending showOpenFilePicker() call with the user-picked files.
  // Builds content-side File objects and lightweight FileSystemFileHandle
  // stand-ins (kind: "file", name, getFile(), isSameEntry()). Most consumers
  // only call .getFile() to read the underlying File, which is what matters.
  _resolveApiWithFiles(files) {
    const api = this.pendingApi;
    this.pendingApi = null;
    if (!api) return;
    const { resolve, reject, win, multiple } = api;

    try {
      const contentFiles = [];
      for (const fd of files) {
        const view =
          fd.bytes instanceof Uint8Array ? fd.bytes : new Uint8Array(fd.bytes);
        const arrayBuf = new win.ArrayBuffer(view.byteLength);
        new win.Uint8Array(arrayBuf).set(view);
        const blob = new win.Blob([arrayBuf], { type: fd.type || "" });
        const file = new win.File([blob], fd.name, {
          type: fd.type || "",
          lastModified: fd.lastModified || Date.now(),
        });
        contentFiles.push(file);
      }

      const handles = contentFiles.map((file) => {
        const handle = Cu.cloneInto({ kind: "file", name: file.name }, win);
        Cu.exportFunction(
          function () {
            return win.Promise.resolve(file);
          },
          handle,
          { defineAs: "getFile" }
        );
        Cu.exportFunction(
          function (_other) {
            return win.Promise.resolve(false);
          },
          handle,
          { defineAs: "isSameEntry" }
        );
        return handle;
      });

      const result = multiple ? handles : handles.slice(0, 1);

      // Each `handle` was created via Cu.cloneInto + Cu.exportFunction, so it
      // already lives in the content scope and exposes getFile/isSameEntry to
      // page script. We just need a content-side Array container for them.
      const contentArray = new win.Array();
      for (const h of result) contentArray.push(h);
      resolve(contentArray);
    } catch (e) {
      console.error("EasyFilesChild: building handles failed", e);
      try {
        reject(
          new win.DOMException(
            String(e?.message || e),
            "InvalidStateError"
          )
        );
      } catch {}
    }
  }

  didDestroy() {
    this.pendingInput = null;
    this.pendingLabel = null;
    if (this.pendingApi) {
      try {
        this.pendingApi.reject(
          new this.pendingApi.win.DOMException("Aborted", "AbortError")
        );
      } catch {}
      this.pendingApi = null;
    }
  }
}
