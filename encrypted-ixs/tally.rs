use arcis::*;

/// Private Voting Circuits
///
/// Three circuits power the private voting lifecycle:
///
/// 1. `zero_tally`    — initializes an encrypted running tally of 0 for a new proposal
/// 2. `add_vote`      — adds one voter's encrypted direction to the running tally
/// 3. `reveal_tally`  — decrypts and reveals the final vote count
///
/// Quadratic voting enforcement happens on-chain (in the Solana program), not in the
/// circuit. The circuit's job is purely to accumulate encrypted votes and reveal the
/// result — no individual vote is ever observable.
#[encrypted]
mod circuits {
    use arcis::*;

    /// Initialize a proposal's encrypted tally to zero.
    ///
    /// Called once at proposal creation. Returns an MXE-encrypted 0i64 that
    /// serves as the seed for subsequent `add_vote` calls.
    #[instruction]
    pub fn init_tally() -> Enc<Mxe, i64> {
        Mxe::get().from_arcis(0i64)
    }

    /// Add a single voter's weighted, directional vote to the running tally.
    ///
    /// # Parameters
    /// - `running_tally`: The current encrypted vote sum (MXE-owned, opaque to everyone).
    /// - `new_vote`:      The voter's direction — 1u8 = For, 0u8 = Against — encrypted
    ///                    with the voter's x25519 shared secret so only the voter and
    ///                    MXE cluster know how they voted.
    /// - `weight`:        Plaintext vote weight, equal to the number of votes the voter
    ///                    allocated. The quadratic cost (weight²) is deducted on-chain
    ///                    before this circuit runs, so budget enforcement is already done.
    ///
    /// # Returns
    /// Updated encrypted tally, still MXE-owned. Stored back into the proposal PDA.
    ///
    /// # Privacy guarantee
    /// `new_vote` direction stays secret — only the final aggregate is ever revealed.
    /// `weight` is public (visible on-chain) but the direction it applies to is not.
    #[instruction]
    pub fn add_vote(
        running_tally: Enc<Mxe, i64>,
        new_vote: Enc<Shared, u8>, // 1 = For, 0 = Against
        weight: u64,               // plaintext: number of votes allocated (public)
    ) -> Enc<Mxe, i64> {
        let tally = running_tally.to_arcis();
        let direction = new_vote.to_arcis() as i64;
        let w = weight as i64;

        // direction=1 → contribution = +w (For)
        // direction=0 → contribution = -w (Against)
        // Both branches always execute (MPC branchless), so neither path is observable.
        let contribution = w * (2 * direction - 1);

        Mxe::get().from_arcis(tally + contribution)
    }

    /// Reveal the final vote tally for a closed proposal.
    ///
    /// Called once after the proposal deadline. The plaintext result (net For minus
    /// Against weighted votes) is emitted by the Solana callback and stored on-chain.
    ///
    /// # Parameters
    /// - `running_tally`: The final encrypted tally accumulated from all `add_vote` calls.
    ///
    /// # Returns
    /// Plaintext i64: positive = net For victory, negative = net Against victory.
    #[instruction]
    pub fn reveal_tally(running_tally: Enc<Mxe, i64>) -> i64 {
        let tally = running_tally.to_arcis();
        tally.reveal()
    }
}
