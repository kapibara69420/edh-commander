import { defineConfig } from 'vite'
export default defineConfig({
  base: './',        // relative paths so GitHub Pages works from any subdirectory
  server: { port: 1999 },
  build: { outDir: 'dist' },
  define: {
    // Baked into the bundle at build time. Check this in the browser
    // console to confirm you're running the latest deployed version.
    __BUILD_TIME__: JSON.stringify(new Date().toISOString())
  }
})
