// Content-process side of the EasyFiles JSWindowActor.
// Intercepts trusted clicks on <input type="file"> and forwards them to the
// parent process so a custom picker panel can be shown. Receives back either
// a file payload (which is set on the input via DataTransfer) or a request
// to fall through to the native picker.

export class EasyFilesChild extends JSWindowActorChild {
  pendingInput = null;
  _bypassNext = false;

  actorCreated() {
    console.log(
      "[EasyFilesChild] actor created in",
      this.contentWindow?.location?.href
    );
  }

  handleEvent(event) {
    if (event.type !== "click") return;
    const initialTarget = event.composedPath?.()[0] || event.target;
    if (initialTarget?.tagName === "INPUT" && initialTarget.type === "file") {
      console.log(
        "[EasyFilesChild] file input click intercepted",
        initialTarget
      );
    }

    let target = null;
    if (typeof event.composedPath === "function") {
      const path = event.composedPath();
      for (const node of path) {
        if (node?.tagName === "INPUT" && node.type === "file") {
          target = node;
          break;
        }
      }
    }
    if (!target) {
      target = event.target;
      if (!target || target.tagName !== "INPUT" || target.type !== "file") {
        return;
      }
    }

    if (target.disabled) return;

    if (this._bypassNext) {
      this._bypassNext = false;
      return;
    }

    // Hold Shift to skip our picker and go straight to the native picker.
    if (event.shiftKey) return;

    // Only intercept genuine user clicks.
    if (!event.isTrusted) return;

    event.preventDefault();
    event.stopPropagation();

    this.pendingInput = target;

    let accept = "";
    let multiple = false;
    let capture = "";
    try {
      accept = target.accept || "";
      multiple = !!target.multiple;
      capture = target.capture || "";
    } catch {}

    this.sendAsyncMessage("EasyFiles:Show", {
      accept,
      multiple,
      capture,
      pageURL: this.contentWindow?.location?.href || "",
    });
  }

  async receiveMessage(message) {
    switch (message.name) {
      case "EasyFiles:SetFiles": {
        if (!this.pendingInput) return;
        const win = this.contentWindow;
        if (!win) return;

        try {
          const dt = new win.DataTransfer();
          for (const fd of message.data.files || []) {
            const view = fd.bytes instanceof Uint8Array
              ? fd.bytes
              : new Uint8Array(fd.bytes);
            const arrayBuf = new win.ArrayBuffer(view.byteLength);
            new win.Uint8Array(arrayBuf).set(view);
            const blob = new win.Blob([arrayBuf], { type: fd.type || "" });
            const file = new win.File([blob], fd.name, {
              type: fd.type || "",
              lastModified: fd.lastModified || Date.now(),
            });
            dt.items.add(file);
          }
          this.pendingInput.files = dt.files;
          this.pendingInput.dispatchEvent(
            new win.Event("input", { bubbles: true })
          );
          this.pendingInput.dispatchEvent(
            new win.Event("change", { bubbles: true })
          );
        } catch (e) {
          console.error("EasyFilesChild: setting files failed", e);
        }
        this.pendingInput = null;
        break;
      }

      case "EasyFiles:Cancel": {
        this.pendingInput = null;
        break;
      }

      case "EasyFiles:OpenNative": {
        if (!this.pendingInput) return;
        const input = this.pendingInput;
        this.pendingInput = null;
        this._bypassNext = true;
        try {
          if (typeof input.showPicker === "function") {
            input.showPicker();
          } else {
            input.click();
          }
        } catch (e) {
          // Most common cause: missing user activation. The user can hold
          // Shift on the original click to bypass our handler entirely.
          console.warn("EasyFilesChild: native picker open failed", e);
        }
        break;
      }
    }
  }

  didDestroy() {
    this.pendingInput = null;
  }
}
