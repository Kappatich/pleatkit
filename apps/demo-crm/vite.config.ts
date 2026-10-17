import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import morphkit from '@morphkit/vite-plugin'

const root = path.dirname(fileURLToPath(import.meta.url))
const dataPort = process.env.DATA_PORT ?? '8787'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    morphkit({
      zones: {
        dynamic: ['src/dynamic/**'],
        readonly: ['src/readonly/**', 'src/components/ui/**'],
      },
      externals: ['react', 'react-dom', 'react/jsx-runtime', '@/components/ui/*', '@/lib/utils', '@/readonly/*'],
    }),
  ],
  resolve: { alias: { '@': path.join(root, 'src') } },
  server: { port: 5173, proxy: { '/api': `http://localhost:${dataPort}` } },
  preview: { port: 4173, proxy: { '/api': `http://localhost:${dataPort}` } },
})
