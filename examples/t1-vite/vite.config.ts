import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import pleatkit from '@pleatkit/vite-plugin'

const proxy = {
  '/agent': 'http://localhost:8789',
  '/pleatkit-store': { target: 'http://localhost:8790', rewrite: (p: string) => p.replace(/^\/pleatkit-store/, '') },
  '/pleatkit/b': { target: 'http://localhost:8790', rewrite: (p: string) => p.replace(/^\/pleatkit\/b/, '/v1/b') },
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    pleatkit({
      zones: {
        dynamic: ['src/dynamic/**'], // the agent rewrites these
        readonly: ['src/readonly/**'], // the agent reads these
      },
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/readonly/*'],
      css: 'tailwind',
      tailwindEntry: 'src/index.css',
    }),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    // one React for the app and @pleatkit/runtime (needed when pleatkit is linked from a checkout)
    dedupe: ['react', 'react-dom'],
  },
  // the agent server, store-server (the users' versions), and the signed bundles of edits (compile: 'server', the default)
  server: { proxy },
  preview: { proxy },
})
