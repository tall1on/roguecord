# Client (Vue 3 + Vite + TypeScript + Tauri)

## Install

```bash
npm install
```

## Web development

```bash
npm run dev
```

## Desktop development (Tauri)

```bash
npm run tauri:dev
```

## Production builds

Build web assets:

```bash
npm run build
```

Build desktop app bundles with Tauri:

```bash
npm run tauri:build
```

## Prerequisites for Tauri builds

- Node.js and npm
- Rust toolchain (`rustup` + stable toolchain)
- Platform-specific native build dependencies required by Tauri v2 (for Windows, Visual Studio C++ build tools and WebView2 runtime)
