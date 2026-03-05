import BN from 'bn.js'
import {
  getMXEAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
} from '@arcium-hq/client'
import { PROGRAM_ID, ARCIUM_CLUSTER_OFFSET, compDefOffsetNum } from '../constants'

// ARCIUM_CLUSTER_OFFSET is a number (456 for devnet)
export const getMxeAcc = () => getMXEAccAddress(PROGRAM_ID)
export const getClusterAcc = () => getClusterAccAddress(ARCIUM_CLUSTER_OFFSET)
export const getMempoolAcc = () => getMempoolAccAddress(ARCIUM_CLUSTER_OFFSET)
export const getExecPool = () => getExecutingPoolAccAddress(ARCIUM_CLUSTER_OFFSET)
export const getCompDef = (name: string) =>
  getCompDefAccAddress(PROGRAM_ID, compDefOffsetNum(name))
export const getCompAcc = (computationOffset: BN) =>
  getComputationAccAddress(ARCIUM_CLUSTER_OFFSET, computationOffset)

export function randomOffset(): BN {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  // interpret as little-endian u64
  let val = 0n
  for (let i = 7; i >= 0; i--) {
    val = (val << 8n) | BigInt(bytes[i])
  }
  return new BN(val.toString())
}
