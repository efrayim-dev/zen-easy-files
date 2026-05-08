// Parent-process side of the EasyFiles JSWindowActor.
// Receives messages from the content actor and dispatches a CustomEvent
// to the chrome window so the panel controller can handle them.

export class EasyFilesParent extends JSWindowActorParent {
  receiveMessage(message) {
    const win = this.browsingContext.topChromeWindow;
    if (!win) return;

    switch (message.name) {
      case "EasyFiles:Show": {
        const browser = this.browsingContext.top.embedderElement;
        win.dispatchEvent(
          new win.CustomEvent("EasyFiles:RequestPicker", {
            detail: {
              browser,
              windowGlobal: this.manager,
              data: message.data || {},
            },
          })
        );
        break;
      }
    }
  }
}
