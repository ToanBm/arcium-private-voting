import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { PROGRAM_ID } from '../constants'

export function getVoterCreditsPda(voter: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('voter_credits'), voter.toBuffer()],
    PROGRAM_ID
  )
}

export function getVoterRecordPda(
  voter: PublicKey,
  proposal: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('voter_record'), voter.toBuffer(), proposal.toBuffer()],
    PROGRAM_ID
  )
}

export function getProposalPda(
  creator: PublicKey,
  nonce: BN
): [PublicKey, number] {
  const nonceBytes = nonce.toArrayLike(Buffer, 'le', 8)
  return PublicKey.findProgramAddressSync(
    [Buffer.from('proposal'), creator.toBuffer(), nonceBytes],
    PROGRAM_ID
  )
}
