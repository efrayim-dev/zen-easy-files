// Parent-process side of the EasyFiles JSWindowActor.
// Receives messages from the content actor and dispatches a CustomEvent
// to the chrome window so the panel controller can handle them.

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
