import { useState, useEffect, useCallback } from 'react'
import { PublicKey } from '@solana/web3.js'
import { getVoterCreditsPda } from '../lib/pdas'
import type { VotingProgram } from './useProgram'

export function useVoterCredits(program: VotingProgram | null, voter: PublicKey | null) {
  const [credits, setCredits] = useState<number | null>(null)
  const [registered, setRegistered] = useState(false)
  const [loading, setLoading] = useState(false)

  const refetch = useCallback(async () => {
    if (!program || !voter) return
    setLoading(true)
    try {
      const [pda] = getVoterCreditsPda(voter)
      // First try the normal Anchor fetch (works for 57-byte accounts).
      // If that fails (e.g. old 49-byte account from a previous deployment that
      // lacked the last_top_up field), fall back to reading raw bytes so existing
      // voters aren't locked out.
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const acc = await (program.account as any).voterCredits.fetch(pda)
        setCredits((acc.credits as { toNumber(): number }).toNumber())
      } catch {
        // Raw fallback: discriminator(8) + voter pubkey(32) + credits(u64 LE) = bytes 40–47
        const info = await program.provider.connection.getAccountInfo(pda)
        if (!info) throw new Error('Account not found')
        const credits = Number(info.data.readBigUInt64LE(40))
        setCredits(credits)
      }
      setRegistered(true)
    } catch {
      setRegistered(false)
      setCredits(null)
    } finally {
      setLoading(false)
    }
  }, [program, voter?.toBase58()])

  useEffect(() => {
    refetch()
  }, [refetch])

  return { credits, registered, loading, refetch }
}
