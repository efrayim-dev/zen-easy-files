# Zen Easy Files

A Zen Browser mod that replicates Opera's "Easy Files" upload UI.

When you click any `<input type="file">` on a webpage, instead of jumping straight
to the OS file picker, you get a small panel anchored to the page with three
tabs:

- **Recent** — your most recent downloads (filtered by the input's `accept` attribute).
- **Clipboard** — images or files currently on your clipboard.
- **Screenshot** — capture the visible area of the active tab and attach it inline.

Plus a **Browse files…** button to fall through to the native OS file picker.

## How it works

This is a privileged user-chrome script (a `.uc.mjs` file loaded via
`fx-autoconfig`). It registers a `JSWindowActor` pair so that:

1. The **child actor** runs in each content document and intercepts the trusted
   click on `<input type="file">` (capture phase, system event group). It cancels
   the click and asks the parent process to show the panel.
2. The **parent actor** dispatches a `CustomEvent` to the chrome window, where the
   controller opens a XUL `panel` containing the UI.
3. When you pick a file, bytes are sent back through the actor and assigned to
   the input via a `DataTransfer`. `input` and `change` events are dispatched.

Hold **Shift** while clicking the file input to bypass the panel and go straight
to the native OS picker for that one click.

## Layout

```
zen-easy-files/
├── README.md
├── INSTALL.md
├── theme.json                ← Sine mod manifest
├── preferences.json          ← Sine-exposed prefs
├── userChrome.css            ← style entry point (Sine)
├── easy-files.uc.mjs         ← main loader, panel UI, controller
├── EasyFilesParent.sys.mjs   ← JSWindowActor parent
├── EasyFilesChild.sys.mjs    ← JSWindowActor child (intercepts clicks)
└── easy-files.css            ← panel styling
```

## Preferences

| Pref                                    | Type    | Default | Purpose                          |
|-----------------------------------------|---------|---------|----------------------------------|
| `extensions.easy-files.enabled`         | bool    | `true`  | Master toggle                    |
| `extensions.easy-files.recent-limit`    | int     | `15`    | How many recent downloads to show|
| `extensions.easy-files.bypass-modifier` | string  | `shift` | Reserved for future configuration|

Edit them at `about:config`.

## Limitations / things to know

- **Native picker fallback may not always open.** When you click "Browse files…",
  we ask the content actor to call `input.showPicker()` / `input.click()`. Firefox
  requires user activation for that, and crossing the parent → child message
  boundary loses the gesture. If it doesn't open, just close the panel and click
  the file input again with **Shift** held.
- **Security filter** — Firefox blocks setting `<input>.files` programmatically
  on cross-origin frames in some cases. The actor runs with content's principal
  inside the content process and uses the page's own `DataTransfer`, so it works
  for the vast majority of upload widgets (regular form inputs, dropzones, etc.).
- **Shadow DOM** — handled via `composedPath()`.
- **Chromecast / DRM-protected content** can refuse `drawWindow` for the
  Screenshot tab.
- This mod can only be loaded with `fx-autoconfig`-style script support. Zen's
  built-in mod store accepts CSS-only mods; for JS you need an installer like
  Sine (which bundles fx-autoconfig).

See [INSTALL.md](./INSTALL.md) for setup steps.

## License

MIT — do whatever you want, no warranty.
