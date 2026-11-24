import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const base = process.env.VB_BASE ?? '/'

export default defineConfig({
  base,
  server: {
    port: Number(process.env.PORT ?? 3001),
    strictPort: true,
    host: '127.0.0.1',
    hmr: process.env.VB_HMR_PORT ? { port: Number(process.env.VB_HMR_PORT) } : undefined,
  },
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart(), viteReact(), tailwindcss()],
})
