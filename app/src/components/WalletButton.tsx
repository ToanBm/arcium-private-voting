import { useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'

export function WalletButton() {
  const { publicKey, disconnect, connecting } = useWallet()
  const { setVisible } = useWalletModal()

  if (connecting) {
    return (
      <button className="px-4 py-2 rounded-[14px] border border-doma-blue/30 text-doma-blue text-sm font-medium opacity-70 cursor-not-allowed">
        Connecting…
      </button>
    )
  }

  if (publicKey) {
    const addr = publicKey.toBase58()
    const short = `${addr.slice(0, 4)}…${addr.slice(-4)}`
    return (
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs text-white/50 bg-white/5 border border-white/10 px-3 py-2 rounded-[14px]">
          {short}
        </span>
        <button
          onClick={() => disconnect()}
          className="px-3 py-2 text-xs rounded-[14px] border border-red-800/50 text-red-400 hover:bg-red-900/20 transition-colors"
        >
          Disconnect
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={() => setVisible(true)}
      className="px-5 py-2.5 rounded-[14px] bg-doma-blue hover:bg-white text-doma-dark font-bold text-sm transition-all transform hover:scale-105 shadow-glow-blue"
    >
      Connect Wallet
    </button>
  )
}
