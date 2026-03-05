import { useState } from 'react'
import { SystemProgram } from '@solana/web3.js'
import { useWallet } from '@solana/wallet-adapter-react'
import BN from 'bn.js'
import { awaitComputationFinalization } from '@arcium-hq/client'
import { AnchorProvider } from '@coral-xyz/anchor'
import type { VotingProgram } from '../hooks/useProgram'
import type { ProposalAccount } from '../hooks/useProposals'
import { getVoterCreditsPda, getVoterRecordPda } from '../lib/pdas'
import { getMxeAcc, getCompAcc, getClusterAcc, getMempoolAcc, getExecPool, getCompDef, randomOffset } from '../lib/arcium'
import { encryptVote } from '../lib/encrypt'

interface Props {
  program: VotingProgram
  provider: AnchorProvider
  proposal: ProposalAccount
  currentCredits: number
  onClose: () => void
  onVoted: () => void
}

type Step = 'form' | 'encrypting' | 'submitting' | 'waiting_mpc' | 'done' | 'error'

export function VoteModal({ program, provider, proposal, currentCredits, onClose, onVoted }: Props) {
  const { publicKey } = useWallet()
  const [direction, setDirection] = useState<0 | 1>(1)
  const [numVotes, setNumVotes] = useState(1)
  const [step, setStep] = useState<Step>('form')
  const [error, setError] = useState('')

  const cost = numVotes * numVotes
  const creditsAfter = currentCredits - cost
  const canVote = step === 'form' && creditsAfter >= 0 && numVotes >= 1 && numVotes <= 10

  async function handleVote() {
    if (!publicKey) return
    setStep('encrypting')
    setError('')

    try {
      const { directionCiphertext, pubKey, nonceBN } = await encryptVote(direction, provider)

      setStep('submitting')
      const computationOffset = randomOffset()
      const [vcPda] = getVoterCreditsPda(publicKey)
      const [vrPda] = getVoterRecordPda(publicKey, proposal.publicKey)

      await program.methods
        .castVote(
          computationOffset,
          directionCiphertext,
          pubKey,
          nonceBN,
          new BN(numVotes)
        )
        .accountsPartial({
          payer: publicKey,
          mxeAccount: getMxeAcc(),
          computationAccount: getCompAcc(computationOffset),
          clusterAccount: getClusterAcc(),
          mempoolAccount: getMempoolAcc(),
          executingPool: getExecPool(),
          compDefAccount: getCompDef('add_vote'),
          proposal: proposal.publicKey,
          voterCredits: vcPda,
          voterRecord: vrPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed', skipPreflight: true })

      setStep('waiting_mpc')
      await awaitComputationFinalization(
        provider,
        computationOffset,
        program.programId,
        'confirmed'
      )

      setStep('done')
      setTimeout(() => {
        onVoted()
        onClose()
      }, 1200)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('already in use') ? 'You already voted on this proposal.' : msg)
      setStep('error')
    }
  }

  const STEP_LABELS: Record<Step, string> = {
    form: '',
    encrypting: 'Encrypting your vote with x25519 + RescueCipher…',
    submitting: 'Submitting transaction…',
    waiting_mpc: 'Arcium MPC is tallying your encrypted vote…',
    done: 'Vote recorded!',
    error: '',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-md mx-4 bg-[linear-gradient(135deg,rgba(11,30,38,0.95)_0%,rgba(11,30,38,0.85)_100%)] border border-white/10 rounded-[20px] shadow-2xl backdrop-blur-xl">
        {/* Header */}
        <div className="px-6 py-4 border-b border-white/10">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-white leading-snug">{proposal.account.title}</h2>
              <p className="text-xs text-white/40 mt-1">Cast an encrypted vote — direction is private</p>
            </div>
            {(step === 'form' || step === 'error') && (
              <button onClick={onClose} className="text-white/30 hover:text-white transition-colors shrink-0">✕</button>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          {(step === 'form' || step === 'error') && (
            <>
              {/* Direction */}
              <div>
                <p className="text-sm font-medium text-white/80 mb-2">Vote direction <span className="text-xs text-doma-blue/70 font-normal">(encrypted on-chain)</span></p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => setDirection(1)}
                    className={`py-3 rounded-[14px] text-sm font-semibold border-2 transition-all ${
                      direction === 1
                        ? 'bg-emerald-900/30 border-emerald-500 text-emerald-300 shadow-glow-green'
                        : 'bg-white/5 border-white/10 text-white/40 hover:border-emerald-700/50'
                    }`}
                  >
                    👍 For
                  </button>
                  <button
                    onClick={() => setDirection(0)}
                    className={`py-3 rounded-[14px] text-sm font-semibold border-2 transition-all ${
                      direction === 0
                        ? 'bg-red-900/30 border-red-500 text-red-300'
                        : 'bg-white/5 border-white/10 text-white/40 hover:border-red-700/50'
                    }`}
                  >
                    👎 Against
                  </button>
                </div>
              </div>

              {/* Votes slider */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium text-white/80">Number of votes</p>
                  <span className="font-mono text-lg font-bold text-white">{numVotes}</span>
                </div>
                <input
                  type="range"
                  min={1}
                  max={Math.min(10, Math.floor(Math.sqrt(currentCredits)))}
                  value={numVotes}
                  onChange={e => setNumVotes(Number(e.target.value))}
                  className="w-full accent-[#4AC6FF]"
                />
                <div className="flex justify-between text-xs text-white/30 mt-1">
                  <span>1</span>
                  <span>{Math.min(10, Math.floor(Math.sqrt(currentCredits)))}</span>
                </div>
              </div>

              {/* Cost breakdown */}
              <div className="bg-doma-blue/5 rounded-[14px] border border-white/10 p-4 space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Quadratic cost</span>
                  <span className="font-mono text-white">{numVotes}² = <span className="text-doma-blue font-semibold">{cost} credits</span></span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-white/50">Current credits</span>
                  <span className="font-mono text-white">{currentCredits}</span>
                </div>
                <div className="border-t border-white/10 pt-2 flex justify-between text-sm font-medium">
                  <span className="text-white/70">Remaining after vote</span>
                  <span className={`font-mono font-bold ${creditsAfter >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {creditsAfter}
                  </span>
                </div>
              </div>

              {/* Lock icon explanation */}
              <div className="flex items-start gap-2.5 text-xs text-white/40">
                <span className="text-base leading-none mt-0.5">🔒</span>
                <span>Your vote direction is encrypted with your ephemeral x25519 key. Only the Arcium MPC cluster can decrypt and tally it — no one can see how you voted.</span>
              </div>

              {step === 'error' && (
                <div className="rounded-[14px] bg-red-900/20 border border-red-800/40 px-3 py-2.5 text-sm text-red-400">
                  {error}
                </div>
              )}
            </>
          )}

          {step !== 'form' && step !== 'error' && (
            <div className="py-6 flex flex-col items-center gap-4">
              {step === 'done' ? (
                <div className="w-14 h-14 rounded-full bg-emerald-900/30 border border-emerald-700/50 flex items-center justify-center text-2xl">
                  ✓
                </div>
              ) : (
                <div className="relative">
                  <div className="w-14 h-14 rounded-full border-2 border-doma-blue/20 border-t-doma-blue animate-spin" />
                  <span className="absolute inset-0 flex items-center justify-center text-lg">🔒</span>
                </div>
              )}
              <p className="text-sm text-white/70 text-center">{STEP_LABELS[step]}</p>
              {step === 'waiting_mpc' && (
                <p className="text-xs text-white/40 text-center max-w-xs">
                  MPC computation in progress (~15–30s). The tally remains encrypted throughout.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {(step === 'form' || step === 'error') && (
          <div className="px-6 pb-5 flex justify-end gap-3">
            <button onClick={onClose} className="px-4 py-2.5 rounded-[14px] text-sm text-white/40 hover:text-white transition-colors">
              Cancel
            </button>
            <button
              onClick={handleVote}
              disabled={!canVote}
              className="px-5 py-2.5 rounded-[14px] text-sm font-bold bg-doma-blue hover:bg-white text-doma-dark transition-all transform hover:scale-105 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
            >
              Cast Encrypted Vote
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
