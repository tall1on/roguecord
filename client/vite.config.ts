import {defineConfig} from 'vite'
import vue from '@vitejs/plugin-vue'

const EMOJI_CACHE_CONTROL_HEADER = 'public, max-age=31536000, immutable'

const addEmojiCacheHeader = (req: { url?: string }, res: { setHeader: (name: string, value: string) => void }, next: () => void) => {
    if (req.url && /\.svg(?:\?.*)?$/i.test(req.url)) {
        res.setHeader('Cache-Control', EMOJI_CACHE_CONTROL_HEADER)
    }

    next()
}

const tauriHost = process.env.TAURI_DEV_HOST

// https://vite.dev/config/
export default defineConfig({
    clearScreen: false,
    envPrefix: ['VITE_', 'TAURI_', 'TAURI_ENV_*'],
    server: {
        port: 1420,
        strictPort: true,
        host: tauriHost || false,
        hmr: tauriHost
            ? { protocol: 'ws', host: tauriHost, port: 1421 }
            : undefined,
        watch: { ignored: ['**/src-tauri/**'] }
    },
    build: {
        target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
        minify: process.env.TAURI_DEBUG ? false : 'oxc',
        sourcemap: !!process.env.TAURI_DEBUG
    },
    plugins: [
        vue(),
        {
            name: 'roguecord-emoji-cache-headers',
            configureServer(server) {
                server.middlewares.use('/svg', addEmojiCacheHeader)
            },
            configurePreviewServer(server) {
                server.middlewares.use('/svg', addEmojiCacheHeader)
            }
        }
    ]
})
