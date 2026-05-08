# Installing Zen Easy Files (with Sine)

You said you have Sine installed — that gives you two ways to install this mod.
Both end up running the same files.

---

## Option A — Drop the files in directly (fastest, no GitHub)

Sine bundles fx-autoconfig under the hood, so anything ending in `.uc.mjs`
inside your profile's `chrome/JS/` folder is auto-loaded at startup.

### 1. Find your Zen profile folder

In Zen, open `about:support` → look for **Profile Folder** → click **Open Folder**.

It's usually:

```
%APPDATA%\zen\Profiles\<random>.Default (alpha)\
```

### 2. Copy the files

Inside the profile folder, go into `chrome\` (it should already exist because
Sine creates it). Inside that, find or create a `JS\` folder, and copy these
five files into it:

```
<profile>\chrome\JS\
├── easy-files.uc.mjs
├── EasyFilesParent.sys.mjs
├── EasyFilesChild.sys.mjs
└── easy-files.css
```

Don't copy `theme.json`, `userChrome.css`, or `preferences.json` for this
method — those are only needed for Option B.

PowerShell one-liner (adjust the destination if your profile name differs):

```powershell
$dest = (Get-ChildItem "$env:APPDATA\zen\Profiles" -Directory | Where-Object { $_.Name -like "*Default*" } | Select-Object -First 1).FullName + "\chrome\JS"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item C:\Users\efray\zen-easy-files\easy-files.uc.mjs $dest
Copy-Item C:\Users\efray\zen-easy-files\EasyFilesParent.sys.mjs $dest
Copy-Item C:\Users\efray\zen-easy-files\EasyFilesChild.sys.mjs $dest
Copy-Item C:\Users\efray\zen-easy-files\easy-files.css $dest
```

### 3. Clear the startup cache

In Zen, go to `about:support` → click **Clear startup cache** in the top-right
corner. Confirm to restart.

### 4. Test

- Click any file upload on a webpage (e.g., Gmail compose attachment, Imgur).
  The Easy Files panel should appear.
- Hold **Shift** while clicking the file input to bypass the panel for that
  click.

---

## Option B — Install through Sine's UI (auto-updates from GitHub)

This route lets Sine manage the mod (enable/disable, preferences, updates) but
requires the project to be in a public GitHub repo first.

### 1. Push this folder to GitHub

```powershell
cd C:\Users\efray\zen-easy-files
git init -b main
git add .
git commit -m "Initial commit"
gh repo create zen-easy-files --public --source=. --push
```

(Or do it manually — the repo just needs `theme.json` and the JS/CSS files at
the root, which is already the case.)

### 2. Open Zen → Settings → Sine tab

### 3. In the **Local Installation** section

Type `efrayim-dev/zen-easy-files` (or the full URL `https://github.com/efrayim-dev/zen-easy-files`) and
click **Install**.

### 4. Restart Zen when Sine prompts.

### 5. Tweak preferences

In the Sine tab you'll now see "Easy Files" listed with a preferences panel:

- **Enable Easy Files picker** — master toggle
- **Number of recent downloads to show** — default 15

Sine will check the GitHub repo for updates and apply them automatically.

---

## Uninstalling

### If installed via Option A

Delete the four files from `<profile>\chrome\JS\` and clear the startup cache.

### If installed via Option B

In Sine's UI, find Easy Files in your installed mods list and click the remove
button.

---

## Troubleshooting

### Panel never appears

1. Make sure Zen was fully restarted (close every window, not just the tab).
2. `about:config` → confirm `extensions.easy-files.enabled` is `true`.
3. Open the Browser Console (`Ctrl+Shift+J`) and look for errors prefixed
   `EasyFiles` or for failures registering the `JSWindowActor`.
4. Visit a page with a file upload that you know works (Gmail compose, Imgur,
   `https://imgur.com/upload`).

### "Browse files…" doesn't open the native picker

Known limitation — when our chrome panel asks the content actor to open the
native picker, the user-activation gesture has been lost crossing the message
boundary. Workaround: close the panel and **Shift-click** the file input.

### After a Zen update, the mod stopped working

Zen updates sometimes wipe Sine's bootloader files in the install directory.
Re-run the Sine installer (or the manual bootloader steps) and the mod files
in your profile will work again. You should not need to re-copy the four
mod files.

### File appears selected but the upload still uses the original empty input

Some sites (notably ones using Drag-and-Drop libraries) read files from a
custom JS state instead of `<input>.files`. Our injection sets `files`
correctly and dispatches `input` and `change`, which is what the spec
requires, but a small percentage of sites bypass the standard flow. Use the
Shift-click bypass on those sites.
