# Icons

Binary icon files (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.ico`,
`icon.icns`) are intentionally **not** committed in the initial scaffold to
avoid shipping binary blobs through non-visual code-generation tools.

Before the first `npm run tauri:build`, run:

```bash
cd client
npx @tauri-apps/cli icon public/roguecord.svg --output src-tauri/icons
```

This produces the full icon set referenced by
[`tauri.conf.json`](../tauri.conf.json:1).

For `tauri dev` you can also run the same command once; Tauri will refuse to
build without the icons present on the paths listed in `tauri.conf.json`.

The `.gitkeep` file in this directory exists solely to ensure the directory
is tracked by git.
