import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import morphkit from '@morphkit/vite-plugin'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    morphkit({
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
    // one React for the app and @morphkit/runtime (needed when morphkit is linked from a checkout)
    dedupe: ['react', 'react-dom'],
  },
  server: { proxy: { '/agent': 'http://localhost:8789' } },
  preview: { proxy: { '/agent': 'http://localhost:8789' } },
})
