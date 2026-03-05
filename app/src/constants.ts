import { PublicKey } from '@solana/web3.js'
import { getCompDefAccOffset } from '@arcium-hq/client'

export const PROGRAM_ID = new PublicKey('CLUBgAStu51VNK9BWaDujZYvrM55MAmfq7CLZ3KY3mmD')
export const ARCIUM_CLUSTER_OFFSET = 456 // devnet (number, as required by arcium client API)
export const RPC_URL = 'https://api.devnet.solana.com'
export const COMMITMENT = 'confirmed' as const

export function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE(0)
}
