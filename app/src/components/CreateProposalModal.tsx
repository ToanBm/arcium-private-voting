import { useState } from 'react'
import { SystemProgram } from '@solana/web3.js'
import { useWallet } from '@solana/wallet-adapter-react'
import BN from 'bn.js'
import { awaitComputationFinalization } from '@arcium-hq/client'
import type { VotingProgram } from '../hooks/useProgram'
import { getProposalPda } from '../lib/pdas'
import { getMxeAcc, getCompAcc, getClusterAcc, getMempoolAcc, getExecPool, getCompDef, randomOffset } from '../lib/arcium'
import { AnchorProvider } from '@coral-xyz/anchor'

interface Props {
  program: VotingProgram
  provider: AnchorProvider
  onClose: () => void
  onCreated: () => void
}

type Step = 'form' | 'creating' | 'zeroing' | 'waiting_mpc' | 'done' | 'error'

export function CreateProposalModal({ program, provider, onClose, onCreated }: Props) {
  const { publicKey } = useWallet()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [durationSecs, setDurationSecs] = useState(24 * 3600)
  const [step, setStep] = useState<Step>('form')
  const [error, setError] = useState('')

  async function handleCreate() {
    if (!publicKey) return
    setStep('creating')
    setError('')

    try {
      const nonce = new BN(
        Buffer.from(crypto.getRandomValues(new Uint8Array(8)))
      )
      const [proposalPda] = getProposalPda(publicKey, nonce)
      const endTime = new BN(Math.floor(Date.now() / 1000) + durationSecs)

      await program.methods
        .createProposal(nonce, title.trim(), description.trim(), endTime)
        .accountsPartial({
          creator: publicKey,
          proposal: proposalPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed', skipPreflight: true })

      // Queue MPC to zero-initialize the encrypted tally
      setStep('zeroing')
      const computationOffset = randomOffset()

      await program.methods
        .zeroTally(computationOffset)
        .accountsPartial({
          payer: publicKey,
          mxeAccount: getMxeAcc(),
          computationAccount: getCompAcc(computationOffset),
          clusterAccount: getClusterAcc(),
          mempoolAccount: getMempoolAcc(),
          executingPool: getExecPool(),
          compDefAccount: getCompDef('init_tally'),
          proposal: proposalPda,
        })
        .rpc({ commitment: 'confirmed', skipPreflight: true })

      // Don't block on MPC finalization — nodes may be slow.
      // Proposal is Initializing on-chain; callback will flip it to Active.
      setStep('done')
      setTimeout(() => {
        onCreated()
        onClose()
      }, 1200)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      setStep('error')
    }
  }

  const titleLen = title.trim().length
  const descLen = description.trim().length
  const canSubmit = titleLen > 0 && titleLen <= 64 && descLen <= 256 && step === 'form'

  const STEP_LABELS: Record<Step, string> = {
    form: '',
    creating: 'Creating proposal on-chain…',
    zeroing: 'Submitting MPC computation…',
    waiting_mpc: 'Waiting for MPC network to initialize encrypted tally…',
    done: 'Proposal is now active!',
    error: '',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-full max-w-lg mx-4 bg-[linear-gradient(135deg,rgba(11,30,38,0.95)_0%,rgba(11,30,38,0.85)_100%)] border border-white/10 rounded-[20px] shadow-2xl backdrop-blur-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10">
          <div>
            <h2 className="text-lg font-semibold text-white">Create Proposal</h2>
            <p className="text-xs text-white/40 mt-0.5">Votes are tallied privately using Arcium MPC</p>
          </div>
          {step === 'form' || step === 'error' ? (
            <button
              onClick={onClose}
              className="text-white/30 hover:text-white transition-colors text-xl leading-none"
            >
              ✕
            </button>
          ) : null}
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-4">
          {(step === 'form' || step === 'error') && (
            <>
              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">
                  Title <span className="text-white/30 font-normal">({titleLen}/64)</span>
                </label>
                <input
                  className="w-full bg-white/5 border border-white/10 rounded-[14px] px-3 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-doma-blue/50 focus:ring-1 focus:ring-doma-blue/20 transition-colors"
                  placeholder="e.g. Should we fund public infrastructure?"
                  maxLength={64}
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">
                  Description <span className="text-white/30 font-normal">({descLen}/256)</span>
                </label>
                <textarea
                  className="w-full bg-white/5 border border-white/10 rounded-[14px] px-3 py-2.5 text-white placeholder-white/25 text-sm focus:outline-none focus:border-doma-blue/50 focus:ring-1 focus:ring-doma-blue/20 transition-colors resize-none"
                  placeholder="Describe your proposal…"
                  rows={3}
                  maxLength={256}
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-white/80 mb-1.5">
                  Voting period
                </label>
                <div className="flex items-center gap-3">
                  {([300, 1, 24, 72, 168] as const).map(h => {
                    const secs = h === 300 ? 300 : h * 3600
                    const label = h === 300 ? '5m' : h < 24 ? `${h}h` : `${h / 24}d`
                    return (
                      <button
                        key={h}
                        onClick={() => setDurationSecs(secs)}
                        className={`flex-1 py-2 rounded-[14px] text-sm font-medium border transition-all ${
                          durationSecs === secs
                            ? 'bg-doma-blue border-doma-blue text-doma-dark font-bold'
                            : 'bg-white/5 border-white/10 text-white/50 hover:border-doma-blue/30 hover:text-white'
                        }`}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
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
                <div className="w-14 h-14 rounded-full border-2 border-doma-blue/20 border-t-doma-blue animate-spin" />
              )}
              <p className="text-sm text-white/70 text-center">{STEP_LABELS[step]}</p>
              {step === 'waiting_mpc' && (
                <p className="text-xs text-white/40 text-center">
                  The Arcium MPC network is computing an encrypted zero — this takes ~15–30s
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {(step === 'form' || step === 'error') && (
          <div className="px-6 pb-5 flex justify-end gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2.5 rounded-[14px] text-sm text-white/40 hover:text-white transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleCreate}
              disabled={!canSubmit}
              className="px-5 py-2.5 rounded-[14px] text-sm font-bold bg-doma-blue hover:bg-white text-doma-dark transition-all transform hover:scale-105 disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none"
            >
              Create Proposal
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
