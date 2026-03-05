import { useState, useEffect, useCallback } from 'react'
import { Connection, PublicKey } from '@solana/web3.js'
import { getVoterRecordPda } from '../lib/pdas'
import type { ProposalAccount } from './useProposals'

export function useVotedProposals(
  connection: Connection | null,
  voter: PublicKey | null,
  proposals: ProposalAccount[]
) {
  const [votedKeys, setVotedKeys] = useState(new Set<string>())

  const proposalsKey = proposals.map(p => p.publicKey.toBase58()).join(',')

  const refetch = useCallback(async () => {
    if (!connection || !voter || proposals.length === 0) {
      setVotedKeys(new Set())
      return
    }
    const pdas = proposals.map(p => getVoterRecordPda(voter, p.publicKey)[0])
    const infos = await connection.getMultipleAccountsInfo(pdas)
    const voted = new Set<string>()
    infos.forEach((info, i) => {
      if (info !== null) voted.add(proposals[i].publicKey.toBase58())
    })
    setVotedKeys(voted)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection, voter?.toBase58(), proposalsKey])

  useEffect(() => { refetch() }, [refetch])

  return { votedKeys, refetch }
}
