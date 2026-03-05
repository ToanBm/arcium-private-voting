import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { AnchorProvider } from '@coral-xyz/anchor'
import BN from 'bn.js'
import { awaitComputationFinalization } from '@arcium-hq/client'
import type { VotingProgram } from '../hooks/useProgram'
import type { ProposalAccount } from '../hooks/useProposals'
import { StatusBadge } from './StatusBadge'
import { VoteModal } from './VoteModal'
import { getMxeAcc, getCompAcc, getClusterAcc, getMempoolAcc, getExecPool, getCompDef, randomOffset } from '../lib/arcium'

interface Props {
  proposal: ProposalAccount
  program: VotingProgram
  provider: AnchorProvider
  currentCredits: number | null
  hasVoted: boolean
  onRefresh: () => void
}

function formatTimeLeft(endTimeSecs: number): string {
  const now = Math.floor(Date.now() / 1000)
  const diff = endTimeSecs - now
  if (diff <= 0) return 'Ended'
  if (diff < 3600) return `${Math.floor(diff / 60)}m left`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h left`
  return `${Math.floor(diff / 86400)}d left`
}

export function ProposalCard({ proposal, program, provider, currentCredits, hasVoted, onRefresh }: Props) {
  const { publicKey } = useWallet()
  const [showVoteModal, setShowVoteModal] = useState(false)
  const [closing, setClosing] = useState(false)
  const [closeError, setCloseError] = useState('')

  const { account } = proposal
  const statusKey = Object.keys(account.status)[0]
  const endTimeSecs = account.endTime.toNumber()
  const now = Math.floor(Date.now() / 1000)
  const isExpired = now >= endTimeSecs
  const canVote = statusKey === 'active' && !isExpired && !hasVoted && currentCredits !== null && currentCredits >= 1
  const canClose = statusKey === 'active' && isExpired


  async function handleClose() {
    if (!publicKey) return
    setClosing(true)
    setCloseError('')
    try {
      const computationOffset = randomOffset()
      await program.methods
        .closeProposal(computationOffset)
        .accountsPartial({
          payer: publicKey,
          mxeAccount: getMxeAcc(),
          computationAccount: getCompAcc(computationOffset),
          clusterAccount: getClusterAcc(),
          mempoolAccount: getMempoolAcc(),
          executingPool: getExecPool(),
          compDefAccount: getCompDef('reveal_tally'),
          proposal: proposal.publicKey,
        })
        .rpc({ commitment: 'confirmed', skipPreflight: true })

      await awaitComputationFinalization(provider, computationOffset, program.programId, 'confirmed')
      onRefresh()
    } catch (e) {
      setCloseError(e instanceof Error ? e.message : 'Close failed')
    } finally {
      setClosing(false)
    }
  }

  // Tally result display
  const result = account.result as BN | null
  const netTally = result !== null ? result.toNumber() : null
  const passed = netTally !== null && netTally > 0

  return (
    <>
      <div className="bg-doma-card border border-white/10 rounded-2xl p-5 hover:border-doma-blue/20 hover:shadow-glow-blue transition-all backdrop-blur-md group flex flex-col">
        {/* Top row */}
        <div className="flex items-start justify-between gap-3 mb-3">
          <div className="flex-1 min-w-0">
            <h3 className="font-semibold text-white text-sm leading-snug line-clamp-2 group-hover:text-doma-blue transition-colors min-h-[2.4rem]">
              {account.title}
            </h3>
          </div>
          <StatusBadge status={account.status} />
        </div>

        {/* Description */}
        {account.description && (
          <p className="text-xs text-white/40 mb-4 line-clamp-2 leading-relaxed">
            {account.description}
          </p>
        )}

        {/* MPC initializing banner */}
        {statusKey === 'initializing' && (
          <div className="rounded-xl border border-yellow-700/30 bg-yellow-900/10 p-3 mb-4 flex items-center gap-2">
            <span>⚙️</span>
            <span className="text-xs text-yellow-400/80">Waiting for MPC nodes — will activate automatically.</span>
          </div>
        )}

        {/* MPC computing banner */}
        {statusKey === 'closed' && (
          <div className="rounded-xl border border-doma-blue/20 bg-doma-blue/5 p-3 mb-4 flex items-center gap-2">
            <span>🔐</span>
            <span className="text-xs text-doma-blue/80">Waiting for MPC nodes — results will appear automatically.</span>
          </div>
        )}

        {/* Meta + Actions row */}
        <div className="mt-auto flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 text-xs text-white/40">
            <span className="flex items-center gap-1">
              <span>🗳️</span>
              <span>{account.voteCount} vote{account.voteCount !== 1 ? 's' : ''}</span>
            </span>
            <span className="flex items-center gap-1">
              <span>⏱️</span>
              <span>{formatTimeLeft(endTimeSecs)}</span>
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
          {statusKey === 'finalized' && netTally !== null && (
              <span className={`flex items-center gap-1 font-medium px-2 py-0.5 rounded-full border text-xs ${
                passed
                  ? 'text-emerald-400 bg-emerald-900/20 border-emerald-700/40'
                  : 'text-red-400 bg-red-900/20 border-red-800/40'
              }`}>
                {passed ? '✅ Passed' : '❌ Failed'}
                <span className="font-mono">{netTally > 0 ? '+' : ''}{netTally}</span>
              </span>
            )}
          {canVote && (
            <button
              onClick={() => setShowVoteModal(true)}
              className="px-4 py-2 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-xs transition-all transform hover:scale-105 shadow-glow-blue"
            >
              Cast Vote
            </button>
          )}
          {hasVoted && statusKey === 'active' && (
            <span className="px-3 py-2 rounded-[14px] bg-white/5 text-xs text-white/40 border border-white/10">
              ✓ Voted
            </span>
          )}
          {!hasVoted && statusKey === 'active' && isExpired && canClose && (
            <button
              onClick={handleClose}
              disabled={closing}
              className="px-4 py-2 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-xs transition-all transform hover:scale-105 disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
            >
              {closing ? 'Computing MPC…' : 'Reveal Results'}
            </button>
          )}
          {closeError && (
            <span className="text-xs text-red-400">{closeError}</span>
          )}
          </div>
        </div>
      </div>

      {showVoteModal && currentCredits !== null && (
        <VoteModal
          program={program}
          provider={provider}
          proposal={proposal}
          currentCredits={currentCredits}
          onClose={() => setShowVoteModal(false)}
          onVoted={onRefresh}
        />
      )}
    </>
  )
}
