import { Buffer } from 'buffer'
// Make Buffer globally available (needed by @solana/web3.js and @coral-xyz/anchor)
if (typeof window !== 'undefined') {
  ;(window as any).Buffer = Buffer
  ;(window as any).global = window
}
