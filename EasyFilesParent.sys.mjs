// Parent-process side of the EasyFiles JSWindowActor.
// Receives messages from the content actor and dispatches a CustomEvent
// to the chrome window so the panel controller can handle them.

// Bumped on every release so easy-files.uc.mjs can detect when Zen has a
// stale ESM cached version of this file (JSWindowActor module imports do
// NOT get re-fetched when Sine refreshes; they only refresh on a full Zen
// process restart). Mismatch -> loud warning at startup.
export const ACTOR_PARENT_VERSION = "1.6.3";

export class EasyFilesParent extends JSWindowActorParent {
  receiveMessage(message) {
    console.log(
      "[EasyFilesParent] receiveMessage:",
      message.name,
      "data=",
      message.data
    );

    const win = this.browsingContext.topChromeWindow;
    if (!win) {
      console.warn(
        "[EasyFilesParent] no topChromeWindow on browsingContext; cannot dispatch"
      );
      return;
    }

    switch (message.name) {
      case "EasyFiles:Show": {
        // Arm the chrome-side nsIFilePicker suppressor AS EARLY AS
        // POSSIBLE — right when the IPC from content lands in the parent
        // process. Zen's chrome-level file-input handler races us to call
        // nsIFilePicker.createInstance via its own IPC path; if our flag
        // isn't set by then the wrapper falls through to the original
        // factory and the native dialog opens alongside our panel. Doing
        // it here (before the CustomEvent dispatch + listener + handler
        // chain) shaves the race window down to chrome process scheduling.
        try {
          const ctrl = win._easyFilesController;
          if (ctrl) {
            ctrl._suppressNativePicker = true;
            ctrl._suppressNativePickerUntil = Date.now() + 5000;
            console.log(
              "[EasyFilesParent] armed nsIFilePicker suppressor (until +5s)"
            );
          } else {
            console.warn(
              "[EasyFilesParent] no _easyFilesController on chrome window; cannot arm suppressor"
            );
          }
        } catch (e) {
          console.warn(
            "[EasyFilesParent] could not arm suppressor (continuing)",
            e
          );
        }

        let browser = null;
        try {
          browser = this.browsingContext.top.embedderElement;
        } catch (e) {
          console.warn("[EasyFilesParent] could not resolve embedderElement", e);
        }
        try {
          win.dispatchEvent(
            new win.CustomEvent("EasyFiles:RequestPicker", {
              detail: {
                browser,
                windowGlobal: this.manager,
                data: message.data || {},
              },
            })
          );
          console.log(
            "[EasyFilesParent] dispatched EasyFiles:RequestPicker on chrome window",
            "browser=",
            browser
          );
        } catch (e) {
          console.error(
            "[EasyFilesParent] failed to dispatch RequestPicker",
            e
          );
        }
        break;
      }
    }
  }
}
