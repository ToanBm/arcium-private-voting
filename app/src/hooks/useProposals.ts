import { useState, useEffect, useCallback } from 'react'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import type { VotingProgram } from './useProgram'

export type ProposalStatus = 'initializing' | 'active' | 'closed' | 'finalized'

export interface ProposalAccount {
  publicKey: PublicKey
  account: {
    creator: PublicKey
    nonce: BN
    title: string
    description: string
    endTime: BN
    voteCount: number
    result: BN | null
    status: Record<ProposalStatus, Record<string, unknown>>
    bump: number
  }
}

const STATUS_ORDER: Record<string, number> = {
  active: 0,
  initializing: 1,
  closed: 2,
  finalized: 3,
}

export function useProposals(program: VotingProgram | null) {
  const [proposals, setProposals] = useState<ProposalAccount[]>([])
  const [loading, setLoading] = useState(false)

  const fetchProposals = useCallback(async () => {
    if (!program) return
    setLoading(true)
    try {
      // Filter by dataSize=448 to skip old 447-byte proposals from a previous
      // deployment that lacked the vote_in_flight field and can't be deserialized.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const all = await (program.account as any).proposal.all([{ dataSize: 448 }])
      const sorted = (all as ProposalAccount[]).sort((a, b) => {
        const aKey = Object.keys(a.account.status)[0]
        const bKey = Object.keys(b.account.status)[0]
        const statusDiff = (STATUS_ORDER[aKey] ?? 9) - (STATUS_ORDER[bKey] ?? 9)
        if (statusDiff !== 0) return statusDiff
        // Within same status: newest end time first
        return b.account.endTime.toNumber() - a.account.endTime.toNumber()
      })
      setProposals(sorted)
    } catch (e) {
      console.error('Failed to fetch proposals:', e)
    } finally {
      setLoading(false)
    }
  }, [program])

  useEffect(() => {
    fetchProposals()
  }, [fetchProposals])

  // Auto-refresh every 8 s while any proposal is pending MPC finalization
  useEffect(() => {
    const hasPending = proposals.some(p => {
      const s = Object.keys(p.account.status)[0]
      return s === 'initializing' || s === 'closed'
    })
    if (!hasPending) return
    const id = setInterval(fetchProposals, 8_000)
    return () => clearInterval(id)
  }, [proposals, fetchProposals])

  return { proposals, loading, refetch: fetchProposals }
}
