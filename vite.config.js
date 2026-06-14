import { defineConfig } from 'vite'
export default defineConfig({
  base: './',        // relative paths so GitHub Pages works from any subdirectory
  server: { port: 1999 },
  build: { outDir: 'dist' }
})
