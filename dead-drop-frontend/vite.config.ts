import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  // Load .env files from the parent directory (repo root)
  envDir: '..',
  define: {
    global: 'globalThis'
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      buffer: path.resolve(__dirname, './node_modules/buffer/')
    },
    dedupe: ['@stellar/stellar-sdk']
  },
  optimizeDeps: {
    include: ['@stellar/stellar-sdk', '@stellar/stellar-sdk/contract', '@stellar/stellar-sdk/rpc', 'buffer'],
    // Exclude Noir packages from pre-bundling so that import.meta.url stays
    // relative to their actual node_modules location. @noir-lang/acvm_js loads
    // its WASM binary via new URL('acvm_js_bg.wasm', import.meta.url); if Vite
    // pre-bundles it the URL resolves into .vite/deps/ where the .wasm file
    // doesn't exist, causing a 404 HTML to be fed into WebAssembly.instantiate().
    // @aztec/bb.js is intentionally NOT excluded — its WASM is embedded as a
    // base64 data URL in JS so pre-bundling is safe, and it must be bundled so
    // that its nested CJS dependency (pino/browser.js) gets properly converted
    // to ESM (otherwise Vite can't find the named 'pino' export at runtime).
    exclude: ['@noir-lang/noir_js', '@noir-lang/acvm_js'],
    esbuildOptions: {
      define: {
        global: 'globalThis'
      }
    }
  },
  build: {
    commonjsOptions: {
      transformMixedEsModules: true
    }
  },
  server: {
    port: 3000,
    open: true,
    allowedHosts: true
  }
})
