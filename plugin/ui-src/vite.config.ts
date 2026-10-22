import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const buildMarker = (): Plugin => ({
  name: 'dbx-ui-build-success',
  closeBundle() { console.log('DBX_UI_BUILD_SUCCESS') },
})

export default defineConfig(({ mode }) => {
  const smoke = mode === 'smoke'
  return {
    base: './',
    plugins: smoke ? [vue()] : [vue(), buildMarker()],
    build: smoke
      ? { outDir: process.env.SMOKE_OUT_DIR || '../../.smoke-chart', emptyOutDir: true, rollupOptions: { input: process.env.SMOKE_INPUT || 'chart-smoke.html' } }
      : { outDir: '../ui', emptyOutDir: true },
    test: { environment: 'jsdom', include: ['test/**/*.test.ts'] },
  }
})
