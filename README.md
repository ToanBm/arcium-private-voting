# Private Voting — Arcium × Solana

**Privacy-preserving quadratic governance voting powered by MPC.**

Votes are cast and tallied inside encrypted shared state managed by Arcium's MPC cluster. Individual vote directions are never observable — only the final net tally is revealed on-chain, with a correctness proof from the cluster.

[![Live App](https://img.shields.io/badge/Live%20App-private--voting.vercel.app-4AC6FF?style=flat-square)](https://private-voting.vercel.app)
[![GitHub](https://img.shields.io/badge/GitHub-yourname%2Fprivate--voting-white?style=flat-square&logo=github)](https://github.com/yourname/private-voting)

---

## How It Works

### The Problem with Transparent Voting

In standard on-chain governance, every vote is visible the moment it lands. This enables:

- **Herd effects** — late voters follow early signals instead of their own conviction.
- **Bribery & coercion** — adversaries can verify compliance in real time.
- **Strategic abstention** — informed voters wait to see which way the wind blows.

### Arcium's Solution

Arcium's MPC (Multi-Party Computation) cluster holds secret shares of the encrypted vote tally. No single node — and no outside observer — can read the intermediate tally during the voting period. Only after the proposal closes does the cluster collectively reveal the plaintext result.

### Quadratic Voting Twist

Each registered voter receives **100 voting credits**. Allocating `N` votes to a proposal costs `N²` credits. This quadratic cost curve:

- Limits extreme concentration of influence (10 votes costs all 100 credits).
- Lets voters signal *intensity* of preference, not just direction.
- Discourages token-whale dominance without requiring token-weighting.

The quadratic deduction is enforced **on-chain** before the MPC computation runs, so budget integrity is provable without revealing anything inside the circuit.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                      Solana Program                            │
│  create_proposal → zero_tally ──────────────────────────────┐ │
│  cast_vote ──────────────────── add_vote circuit ───────────┤ │
│  close_proposal ──────────────── reveal_tally circuit ──────┤ │
│                                                              ↓ │
│                          Proposal PDA                          │
│         running_tally_ciphertext  (Enc<Mxe, i64>)             │
│         result: Option<i64>       (revealed at close)          │
└────────────────────────────────────────────────────────────────┘
                              ↕ CPI
┌────────────────────────────────────────────────────────────────┐
│                     Arcium MPC Cluster                         │
│                                                                │
│  zero_tally()        → Enc<Mxe, 0i64>                         │
│  add_vote(tally, v, w) → Enc<Mxe, tally + w*(2v-1)>           │
│  reveal_tally(tally) → i64  (plaintext, with proof)            │
└────────────────────────────────────────────────────────────────┘
```

### Three MPC Circuits (`encrypted-ixs/tally.rs`)

| Circuit | Inputs | Output | Called When |
|---|---|---|---|
| `zero_tally` | — | `Enc<Mxe, i64>` = 0 | Proposal created |
| `add_vote` | `Enc<Mxe, i64>` tally, `Enc<Shared, u8>` direction, `i64` weight | `Enc<Mxe, i64>` | Each vote |
| `reveal_tally` | `Enc<Mxe, i64>` tally | `i64` (plaintext) | Proposal closed |

### On-chain Accounts

| Account | PDA Seeds | Purpose |
|---|---|---|
| `Proposal` | `[b"proposal", creator, nonce_le_bytes]` | Proposal metadata + encrypted tally |
| `VoterCredits` | `[b"voter_credits", voter]` | Quadratic voting budget per voter |
| `VoterRecord` | `[b"voter_record", voter, proposal]` | Double-vote prevention |

---

## Privacy Guarantees

| What is revealed | What stays private |
|---|---|
| That a vote was cast (tx visible on-chain) | Which way the voter voted |
| How many votes a voter allocated (weight) | Their direction (For/Against) |
| Final net tally at close | Any intermediate count |
| Whether the proposal passed | Individual contributions |

The vote direction is encrypted client-side using **x25519 ECDH + RescueCipher** before the transaction is submitted. The MPC cluster adds the encrypted contribution to the running tally without learning the direction — the branchless circuit evaluates both `+weight` and `-weight` simultaneously and selects the correct result under encryption.

---

## Quadratic Voting Example

| Votes allocated | Credits spent | Credits remaining (from 100) |
|---|---|---|
| 1 | 1 | 99 |
| 3 | 9 | 91 |
| 5 | 25 | 75 |
| 10 | 100 | 0 |

A voter with 100 credits can cast 10 votes on one proposal, or spread their influence: e.g. 7 votes (49 credits) on one proposal and 7 votes (49 credits) on another (total 98 credits, 2 left over).

---

## Getting Started

### Prerequisites

```bash
# Install Arcium toolchain
curl --proto '=https' --tlsv1.2 -sSfL https://install.arcium.com/ | bash

# Verify
arcium --version   # 0.8.5
anchor --version   # 0.32.1
node --version     # 20+
```

### Build

```bash
cd private-voting
yarn install
arcium build
```

### Test (local)

```bash
arcium test
```

### Deploy to Devnet

```bash
arcium deploy \
  --cluster-offset 456 \
  --recovery-set-size 5 \
  --keypair-path ~/.config/solana/id.json \
  --program-keypair target/deploy/private_voting-keypair.json \
  --program-name private_voting \
  --rpc-url devnet
```

After deploy, update `Anchor.toml` cluster to `devnet` and run:

```bash
arcium test --cluster devnet
```

### Run the Frontend

```bash
cd app
npm install
npm run dev   # → http://localhost:3000
```

Connect Phantom or Solflare (set to Devnet), register as a voter, and start creating proposals.

---

## Proposal Lifecycle

```
creator → create_proposal()
       → zero_tally()         [MPC: generates Enc<Mxe,0>]
       ↓ status = Active

voters → cast_vote(Enc(direction), weight)   [up to deadline]
       → add_vote_callback()  [MPC: tally += weight*(2d-1)]

anyone → close_proposal()     [after end_time]
       → reveal_tally_callback() [MPC: reveals final i64]
       ↓ status = Finalized, result = net_tally
```

---

## Project Structure

```
private-voting/
├── Arcium.toml              # Arcium toolchain config
├── Anchor.toml              # Anchor + Solana config
├── encrypted-ixs/
│   └── tally.rs             # Three MPC circuits (zero_tally, add_vote, reveal_tally)
├── programs/
│   └── private-voting/
│       └── src/lib.rs       # Solana program (11 instructions)
├── tests/
│   └── private-voting.ts    # Full lifecycle integration tests (12/12 passing)
├── build/                   # Compiled Arcis circuits + generated TS wrappers
├── scripts/                 # Deployment, circuit upload, and debug utilities
└── app/                     # Frontend (Vite + React + Tailwind)
    ├── src/
    │   ├── lib/             # arcium.ts, encrypt.ts, pdas.ts
    │   ├── hooks/           # useProgram, useProposals, useVoterCredits
    │   └── components/      # WalletButton, ProposalCard, VoteModal, CreateProposalModal
    └── package.json
```

---

## Why Arcium?

Traditional ZK-based private voting requires voters to generate proofs locally (expensive, complex tooling). Arcium's MPC approach:

- **No client-side ZK prover** — voters just encrypt and submit.
- **Correctness proof included** — the MPC cluster signs its output; the Solana program verifies the signature before accepting the result.
- **Composable** — the encrypted tally is a standard Solana PDA; any on-chain program can read the final result after reveal.
