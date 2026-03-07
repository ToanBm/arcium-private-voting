import { useMemo } from 'react'
import { useAnchorWallet, useConnection } from '@solana/wallet-adapter-react'
import { AnchorProvider, Program } from '@coral-xyz/anchor'
import idl from '../idl/private_voting.json'
import { COMMITMENT } from '../constants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type VotingProgram = Program<any>

export function useProgram() {
  const { connection } = useConnection()
  const wallet = useAnchorWallet()

  return useMemo(() => {
    if (!wallet) return null
    const provider = new AnchorProvider(connection, wallet, { commitment: COMMITMENT })
    // Anchor 0.32: Program(idl, provider) — programId is taken from idl.address
    const program = new Program(idl as any, provider) as VotingProgram
    return { program, provider }
  }, [wallet, connection])
}
