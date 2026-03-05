import type { ProposalStatus } from '../hooks/useProposals'

const CONFIG: Record<ProposalStatus, { label: string; cls: string }> = {
  initializing: { label: 'Initializing MPC…', cls: 'bg-yellow-900/30 text-yellow-400 border-yellow-700/40' },
  active:       { label: 'Active',            cls: 'bg-emerald-900/30 text-emerald-400 border-emerald-700/40' },
  closed:       { label: 'MPC Computing…',    cls: 'bg-blue-900/30 text-blue-400 border-blue-700/40' },
  finalized:    { label: 'Finalized',         cls: 'bg-purple-900/30 text-purple-400 border-purple-700/40' },
}

export function StatusBadge({ status }: { status: Record<string, unknown> }) {
  const key = (Object.keys(status)[0] as ProposalStatus) ?? 'initializing'
  const { label, cls } = CONFIG[key] ?? CONFIG.initializing
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-medium border rounded-full ${cls}`}>
      {(key === 'initializing' || key === 'closed') && (
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
      )}
      {key === 'active' && (
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
      )}
      {label}
    </span>
  )
}
