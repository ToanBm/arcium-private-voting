import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({
      globals: { Buffer: true, process: true, global: true },
    }),
  ],
  define: {
    'process.env.NODE_DEBUG': JSON.stringify(false),
  },
  optimizeDeps: {
    include: ['@coral-xyz/anchor', '@solana/web3.js', 'bn.js'],
  },
  server: {
    port: 3000,
  },
})
