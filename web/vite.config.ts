/// <reference types="vitest" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  test: {
    // Node saja, tanpa jsdom: test render memakai react-dom/server
    // (renderToString) dan test util murni — cukup untuk smoke test dan
    // jauh lebih ringan daripada menarik jsdom + testing-library.
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
