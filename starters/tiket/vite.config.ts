import { defineConfig } from 'vite'
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const rawBase = process.env.VB_BASE ?? '/'
const base = rawBase === '/' ? '/' : `${rawBase.replace(/\/+$/, '')}/`
// TanStack Start menghitung basepath router saat BUILD (di-inline ke bundle
// client lewat process.env.TSS_ROUTER_BASEPATH) dan menimpanya saat hidrasi.
// Karena preview disajikan di /api/projects/<id>/live/, basepath harus ikut
// di-set di sini — patch runtime di router.tsx akan ditimpa oleh entry client.
const basepath = base === '/' ? undefined : base.replace(/\/+$/, '')

export default defineConfig({
  base,
  server: {
    port: Number(process.env.PORT ?? 3001),
    strictPort: true,
    host: '127.0.0.1',
    hmr: process.env.VB_HMR_PORT ? { port: Number(process.env.VB_HMR_PORT) } : undefined,
  },
  resolve: { tsconfigPaths: true },
  plugins: [tanstackStart({ router: { basepath } }), viteReact(), tailwindcss()],
})
