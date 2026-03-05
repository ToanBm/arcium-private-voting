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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const acc = await (program.account as any).voterCredits.fetch(pda)
      setCredits((acc.credits as { toNumber(): number }).toNumber())
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
