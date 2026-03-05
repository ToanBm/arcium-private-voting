import { AnchorProvider } from '@coral-xyz/anchor'
import BN from 'bn.js'
import { RescueCipher, getMXEPublicKey, x25519, deserializeLE } from '@arcium-hq/client'
import { PROGRAM_ID } from '../constants'

export async function encryptVote(
  direction: 0 | 1,
  provider: AnchorProvider
): Promise<{
  directionCiphertext: number[]
  pubKey: number[]
  nonceBN: BN
}> {
  const mxePubKey = await getMXEPublicKey(provider, PROGRAM_ID)
  if (!mxePubKey) throw new Error('MXE public key not available — MPC cluster may not be ready')

  const privateKey = x25519.utils.randomSecretKey()
  const pubKey = x25519.getPublicKey(privateKey)
  const sharedSecret = x25519.getSharedSecret(privateKey, mxePubKey)
  const cipher = new RescueCipher(sharedSecret)

  const nonceBytes = new Uint8Array(16)
  crypto.getRandomValues(nonceBytes)
  const [ct] = cipher.encrypt([BigInt(direction)], nonceBytes)

  return {
    directionCiphertext: ct,
    pubKey: Array.from(pubKey),
    nonceBN: new BN(deserializeLE(nonceBytes).toString()),
  }
}
