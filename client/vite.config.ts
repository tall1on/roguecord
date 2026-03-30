import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_'],
    server: {
        port: 1420,
        strictPort: true,
        host: process.env.TAURI_DEV_HOST || undefined
    },
    build: {
        target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
        minify: process.env.TAURI_DEBUG ? false : 'oxc',
        sourcemap: !!process.env.TAURI_DEBUG
    },
    plugins: [
        vue()
    ]
})
