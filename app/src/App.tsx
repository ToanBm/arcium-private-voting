import { useState } from 'react'
import { useWallet } from '@solana/wallet-adapter-react'
import { SystemProgram } from '@solana/web3.js'
import { WalletButton } from './components/WalletButton'
import { ProposalCard } from './components/ProposalCard'
import { CreateProposalModal } from './components/CreateProposalModal'
import { useProgram } from './hooks/useProgram'
import { useProposals } from './hooks/useProposals'
import { useVoterCredits } from './hooks/useVoterCredits'
import { useVotedProposals } from './hooks/useVotedProposals'
import { getVoterCreditsPda } from './lib/pdas'

function CreditBar({ credits, onRegister, onTopUp, topUpLoading, loading }: {
  credits: number | null
  onRegister: () => void
  onTopUp: () => void
  topUpLoading: boolean
  loading: boolean
}) {
  const maxCredits = 100
  const pct = credits !== null ? Math.round((credits / maxCredits) * 100) : 0

  return (
    <div className="flex items-center gap-2">
      {credits !== null ? (
        <>
          <div className="flex items-center gap-2">
            <div className="hidden sm:block w-24 h-1.5 rounded-full bg-white/10 overflow-hidden">
              <div
                className="h-full rounded-full bg-doma-blue transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-xs font-mono text-doma-blue font-medium">{credits} credits</span>
          </div>
          {credits < 25 && (
            <button
              onClick={onTopUp}
              disabled={topUpLoading}
              title="Refill 100 credits (once per 24 h)"
              className="px-2 py-1 rounded-[10px] text-xs font-medium bg-doma-blue/10 hover:bg-doma-blue/20 border border-doma-blue/30 text-doma-blue transition-colors disabled:opacity-50"
            >
              {topUpLoading ? '…' : '+ Top Up'}
            </button>
          )}
        </>
      ) : (
        <button
          onClick={onRegister}
          disabled={loading}
          className="px-3 py-1.5 rounded-[14px] text-xs font-medium bg-doma-blue/10 hover:bg-doma-blue/20 border border-doma-blue/30 text-doma-blue transition-colors disabled:opacity-50"
        >
          {loading ? 'Registering…' : '+ Register as Voter'}
        </button>
      )}
    </div>
  )
}

export function App() {
  const { publicKey } = useWallet()
  const ctx = useProgram()
  const { proposals, loading: loadingProposals, refetch } = useProposals(ctx?.program ?? null)
  const { credits, registered, loading: loadingCredits, refetch: refetchCredits } = useVoterCredits(
    ctx?.program ?? null,
    publicKey ?? null
  )
  const [showCreate, setShowCreate] = useState(false)
  const [registerLoading, setRegisterLoading] = useState(false)
  const [topUpLoading, setTopUpLoading] = useState(false)
  const [activeFilter, setActiveFilter] = useState<'active' | 'mine' | 'voted' | 'ended'>('active')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 9

  const { votedKeys: votedProposalKeys, refetch: refetchVoted } = useVotedProposals(
    ctx?.provider.connection ?? null,
    publicKey,
    proposals
  )

  async function handleTopUp() {
    if (!ctx || !publicKey) return
    setTopUpLoading(true)
    try {
      const [vcPda] = getVoterCreditsPda(publicKey)
      await ctx.program.methods
        .topUpCredits()
        .accountsPartial({
          voter: publicKey,
          voterCredits: vcPda,
        })
        .rpc({ commitment: 'confirmed', skipPreflight: true })
      await refetchCredits()
    } catch (e) {
      console.error('Top-up failed:', e)
    } finally {
      setTopUpLoading(false)
    }
  }

  async function handleRegister() {
    if (!ctx || !publicKey) return
    setRegisterLoading(true)
    try {
      const [vcPda] = getVoterCreditsPda(publicKey)
      await ctx.program.methods
        .registerVoter()
        .accountsPartial({
          voter: publicKey,
          voterCredits: vcPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: 'confirmed', skipPreflight: true })
      await refetchCredits()
    } catch (e) {
      console.error('Register failed:', e)
    } finally {
      setRegisterLoading(false)
    }
  }

  return (
    <div className="min-h-screen text-white">
      {/* Background glow */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-doma-blue/5 rounded-full blur-[160px] -z-10 pointer-events-none" />

      {/* Header — floating card */}
      <header className="sticky top-0 z-40 px-4 sm:px-6 pt-3">
        <div className="w-4/5 mx-auto bg-doma-card border border-white/10 rounded-[20px] px-6 py-3 backdrop-blur-xl flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-xl">🔐</span>
            <div>
              <h1 className="text-sm font-logo font-extrabold text-white leading-none tracking-wide">Private Voting</h1>
              <p className="text-xs text-white/40 leading-none mt-0.5">Powered by Arcium MPC</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {publicKey && (
              <CreditBar
                credits={credits}
                onRegister={handleRegister}
                onTopUp={handleTopUp}
                topUpLoading={topUpLoading}
                loading={registerLoading || loadingCredits}
              />
            )}
            <WalletButton />
          </div>
        </div>
      </header>

      {/* Body */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {!publicKey ? (
          /* Landing / connect prompt */
          <div className="flex flex-col items-center justify-center py-24 gap-6 animate-fade-in">
            <div className="w-20 h-20 rounded-full bg-doma-blue/10 border border-doma-blue/20 flex items-center justify-center text-4xl shadow-glow-blue">
              🔐
            </div>
            <div className="text-center">
              <h2 className="text-2xl font-bold text-white mb-2">Privacy-Preserving Quadratic Voting</h2>
              <p className="text-white/50 max-w-md leading-relaxed text-sm">
                Vote direction is encrypted on-chain using x25519 key exchange and RescueCipher.
                The Arcium MPC network tallies votes without revealing individual choices.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-4 max-w-sm w-full text-center">
              {[
                { icon: '🔒', label: 'Encrypted votes' },
                { icon: '🧮', label: 'Quadratic cost' },
                { icon: '🌐', label: 'MPC tallying' },
              ].map(({ icon, label }) => (
                <div key={label} className="bg-doma-card border border-white/10 rounded-xl p-3 backdrop-blur-sm">
                  <div className="text-xl mb-1">{icon}</div>
                  <p className="text-xs text-white/50">{label}</p>
                </div>
              ))}
            </div>
            <WalletButton />
          </div>
        ) : (
          <>
            {/* Filter toolbar */}
            <div className="flex items-center justify-between mb-6 gap-3">
              <div className="bg-doma-card border border-white/10 rounded-[20px] p-1 flex items-center gap-1">
                {([
                  { key: 'active', label: 'Active', count: proposals.filter(p => { const s = Object.keys(p.account.status)[0]; return s === 'active' || s === 'initializing' }).length },
                  { key: 'mine',   label: 'Mine',   count: proposals.filter(p => publicKey && p.account.creator.equals(publicKey)).length },
                  { key: 'voted',  label: 'Voted',  count: votedProposalKeys.size },
                  { key: 'ended',  label: 'Closed',  count: proposals.filter(p => { const s = Object.keys(p.account.status)[0]; return s === 'closed' || s === 'finalized' }).length },
                ] as const).map(({ key, label, count }) => (
                  <button
                    key={key}
                    onClick={() => { setActiveFilter(key); setPage(0) }}
                    className={`px-4 py-2 rounded-[14px] text-sm font-bold transition-all flex items-center gap-2 ${
                      activeFilter === key
                        ? 'bg-doma-blue/10 text-doma-blue'
                        : 'text-white/50 hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {label}
                    <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                      activeFilter === key ? 'bg-doma-blue/20 text-doma-blue' : 'bg-white/5 text-white/30'
                    }`}>{count}</span>
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={refetch}
                  className="p-2 rounded-[14px] text-white/40 hover:text-white hover:bg-white/5 transition-colors text-sm"
                  title="Refresh"
                >
                  ↻
                </button>
                {registered && (
                  <button
                    onClick={() => setShowCreate(true)}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105 shadow-glow-blue"
                  >
                    <span>+</span>
                    <span>New Proposal</span>
                  </button>
                )}
              </div>
            </div>

            {/* Not registered notice */}
            {!registered && !loadingCredits && (
              <div className="mb-6 rounded-[20px] border border-doma-blue/20 bg-doma-blue/5 p-4 flex items-center gap-3 backdrop-blur-sm">
                <span className="text-2xl">👋</span>
                <div className="flex-1">
                  <p className="text-sm font-medium text-doma-blue">Register to participate</p>
                  <p className="text-xs text-white/40">Get 100 voting credits to create proposals and cast votes.</p>
                </div>
                <button
                  onClick={handleRegister}
                  disabled={registerLoading}
                  className="px-4 py-2 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105"
                >
                  {registerLoading ? 'Registering…' : 'Register'}
                </button>
              </div>
            )}

            {/* Proposals grid */}
            {(() => {
              const filtered = proposals.filter(p => {
                const s = Object.keys(p.account.status)[0]
                if (activeFilter === 'active') return s === 'active' || s === 'initializing'
                if (activeFilter === 'mine')   return publicKey != null && p.account.creator.equals(publicKey)
                if (activeFilter === 'voted')  return votedProposalKeys.has(p.publicKey.toBase58())
                if (activeFilter === 'ended')  return s === 'closed' || s === 'finalized'
                return true
              })
              const totalPages = Math.ceil(filtered.length / PAGE_SIZE)
              const paginated = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

              return loadingProposals ? (
                <div className="flex items-center justify-center py-16 gap-3 text-white/40">
                  <div className="w-5 h-5 border-2 border-white/20 border-t-doma-blue rounded-full animate-spin" />
                  <span className="text-sm">Loading proposals…</span>
                </div>
              ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-white/40">
                  <span className="text-4xl">🗳️</span>
                  <p className="text-sm">
                    {proposals.length === 0 ? 'No proposals yet. Create the first one!' : 'No proposals match this filter.'}
                  </p>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                    {paginated.map(p => (
                      <ProposalCard
                        key={p.publicKey.toBase58()}
                        proposal={p}
                        program={ctx!.program}
                        provider={ctx!.provider}
                        currentCredits={credits}
                        hasVoted={votedProposalKeys.has(p.publicKey.toBase58())}
                        onRefresh={() => { refetch(); refetchCredits(); refetchVoted() }}
                      />
                    ))}
                  </div>

                  {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-2 mt-6">
                      <button
                        onClick={() => setPage(p => p - 1)}
                        disabled={page === 0}
                        className="px-4 py-2 rounded-[14px] text-sm font-bold bg-doma-card border border-white/10 text-white/50 hover:text-white hover:border-doma-blue/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        ← Prev
                      </button>
                      {Array.from({ length: totalPages }, (_, i) => (
                        <button
                          key={i}
                          onClick={() => setPage(i)}
                          className={`w-9 h-9 rounded-[14px] text-sm font-bold transition-all ${
                            page === i
                              ? 'bg-doma-blue/10 text-doma-blue border border-doma-blue/30'
                              : 'bg-doma-card border border-white/10 text-white/40 hover:text-white hover:border-doma-blue/30'
                          }`}
                        >
                          {i + 1}
                        </button>
                      ))}
                      <button
                        onClick={() => setPage(p => p + 1)}
                        disabled={page === totalPages - 1}
                        className="px-4 py-2 rounded-[14px] text-sm font-bold bg-doma-card border border-white/10 text-white/50 hover:text-white hover:border-doma-blue/30 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        Next →
                      </button>
                    </div>
                  )}
                </>
              )
            })()}
          </>
        )}
      </main>

      {/* Modals */}
      {showCreate && ctx && (
        <CreateProposalModal
          program={ctx.program}
          provider={ctx.provider}
          onClose={() => setShowCreate(false)}
          onCreated={() => { refetch(); refetchCredits() }}
        />
      )}
    </div>
  )
}
