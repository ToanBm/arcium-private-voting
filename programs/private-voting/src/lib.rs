use anchor_lang::prelude::*;
use arcium_anchor::prelude::*;
use arcium_client::idl::arcium::types::CallbackAccount;

declare_id!("CLUBgAStu51VNK9BWaDujZYvrM55MAmfq7CLZ3KY3mmD");

// ---------------------------------------------------------------------------
// Computation definition offsets
// ---------------------------------------------------------------------------
const COMP_DEF_OFFSET_ZERO_TALLY: u32 = comp_def_offset("init_tally");
const COMP_DEF_OFFSET_ADD_VOTE: u32 = comp_def_offset("add_vote");
const COMP_DEF_OFFSET_REVEAL_TALLY: u32 = comp_def_offset("reveal_tally");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_TITLE_LEN: usize = 64;
const MAX_DESC_LEN: usize = 256;
const PROPOSAL_SEED: &[u8] = b"proposal";
const VOTER_RECORD_SEED: &[u8] = b"voter_record";
const VOTER_CREDITS_SEED: &[u8] = b"voter_credits";

/// Default voting credits per registered voter.
/// 100 credits → max 10 votes on one proposal (10² = 100).
const DEFAULT_CREDITS: u64 = 100;

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

#[arcium_program]
pub mod private_voting {
    use super::*;

    // -----------------------------------------------------------------------
    // One-time computation definition initialization
    // -----------------------------------------------------------------------

    pub fn init_zero_tally_comp_def(ctx: Context<InitZeroTallyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_add_vote_comp_def(ctx: Context<InitAddVoteCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    pub fn init_reveal_tally_comp_def(ctx: Context<InitRevealTallyCompDef>) -> Result<()> {
        init_comp_def(ctx.accounts, None, None)?;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Voter management
    // -----------------------------------------------------------------------

    pub fn register_voter(ctx: Context<RegisterVoter>) -> Result<()> {
        let vc = &mut ctx.accounts.voter_credits;
        vc.voter = ctx.accounts.voter.key();
        vc.credits = DEFAULT_CREDITS;
        vc.bump = ctx.bumps.voter_credits;
        Ok(())
    }

    // -----------------------------------------------------------------------
    // Proposal lifecycle
    // -----------------------------------------------------------------------

    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_nonce: u64,
        title: String,
        description: String,
        end_time: i64,
    ) -> Result<()> {
        require!(title.len() <= MAX_TITLE_LEN, ErrorCode::TitleTooLong);
        require!(description.len() <= MAX_DESC_LEN, ErrorCode::DescriptionTooLong);

        let proposal = &mut ctx.accounts.proposal;
        proposal.creator = ctx.accounts.creator.key();
        proposal.nonce = proposal_nonce;
        proposal.title = title;
        proposal.description = description;
        proposal.end_time = end_time;
        proposal.vote_count = 0;
        proposal.running_tally_ciphertext = [0u8; 32];
        proposal.running_tally_nonce = 0u128;
        proposal.result = None;
        proposal.status = ProposalStatus::Initializing;
        proposal.bump = ctx.bumps.proposal;
        Ok(())
    }

    /// Queue MPC to produce Enc<Mxe, 0i64> — the seed running tally.
    pub fn zero_tally(
        ctx: Context<ZeroTally>,
        computation_offset: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Initializing,
            ErrorCode::InvalidProposalStatus
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new().build();

        let callback_ix = InitTallyCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.proposal.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;
        Ok(())
    }

    /// Callback: store encrypted zero tally in proposal, activate voting.
    #[arcium_callback(encrypted_ix = "init_tally")]
    pub fn init_tally_callback(
        ctx: Context<InitTallyCallback>,
        output: SignedComputationOutputs<InitTallyOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(InitTallyOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let proposal = &mut ctx.accounts.proposal;
        proposal.running_tally_ciphertext = o.ciphertexts[0];
        proposal.running_tally_nonce = o.nonce;
        proposal.status = ProposalStatus::Active;

        emit!(ProposalActivated { proposal: proposal.key() });
        Ok(())
    }

    /// Cast an encrypted vote with quadratic credit deduction.
    ///
    /// The voter chooses `num_votes` (weight). The quadratic cost `num_votes²`
    /// is deducted on-chain before MPC runs. The vote direction (1=For, 0=Against)
    /// is encrypted so only the MPC cluster can see it.
    pub fn cast_vote(
        ctx: Context<CastVote>,
        computation_offset: u64,
        direction_ciphertext: [u8; 32],
        pub_key: [u8; 32],
        nonce: u128,
        num_votes: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Active,
            ErrorCode::InvalidProposalStatus
        );
        require!(
            Clock::get()?.unix_timestamp < ctx.accounts.proposal.end_time,
            ErrorCode::ProposalEnded
        );
        require!(num_votes > 0, ErrorCode::ZeroVotes);

        let cost = num_votes.checked_mul(num_votes).ok_or(ErrorCode::CreditOverflow)?;
        require!(ctx.accounts.voter_credits.credits >= cost, ErrorCode::InsufficientCredits);
        ctx.accounts.voter_credits.credits -= cost;

        let tally_nonce = ctx.accounts.proposal.running_tally_nonce;
        let tally_ct = ctx.accounts.proposal.running_tally_ciphertext;
        let proposal_key = ctx.accounts.proposal.key();

        ctx.accounts.voter_record.voter = ctx.accounts.payer.key();
        ctx.accounts.voter_record.proposal = proposal_key;
        ctx.accounts.voter_record.weight = num_votes;
        ctx.accounts.voter_record.bump = ctx.bumps.voter_record;

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let args = ArgBuilder::new()
            .plaintext_u128(tally_nonce)
            .encrypted_u8(tally_ct)
            .x25519_pubkey(pub_key)
            .plaintext_u128(nonce)
            .encrypted_u8(direction_ciphertext)
            .plaintext_u64(num_votes)
            .build();

        let callback_ix = AddVoteCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.proposal.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;
        Ok(())
    }

    /// Callback: store updated encrypted tally.
    #[arcium_callback(encrypted_ix = "add_vote")]
    pub fn add_vote_callback(
        ctx: Context<AddVoteCallback>,
        output: SignedComputationOutputs<AddVoteOutput>,
    ) -> Result<()> {
        let o = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(AddVoteOutput { field_0 }) => field_0,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let proposal = &mut ctx.accounts.proposal;
        proposal.running_tally_ciphertext = o.ciphertexts[0];
        proposal.running_tally_nonce = o.nonce;
        proposal.vote_count += 1;

        emit!(VoteCast { proposal: proposal.key(), vote_count: proposal.vote_count });
        Ok(())
    }

    /// Close proposal after deadline and reveal the final tally via MPC.
    pub fn close_proposal(ctx: Context<CloseProposal>, computation_offset: u64) -> Result<()> {
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Active,
            ErrorCode::InvalidProposalStatus
        );
        require!(
            Clock::get()?.unix_timestamp >= ctx.accounts.proposal.end_time,
            ErrorCode::ProposalNotEnded
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let tally_nonce = ctx.accounts.proposal.running_tally_nonce;
        let tally_ct = ctx.accounts.proposal.running_tally_ciphertext;

        let args = ArgBuilder::new().plaintext_u128(tally_nonce).encrypted_u8(tally_ct).build();

        let callback_ix = RevealTallyCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.proposal.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;

        ctx.accounts.proposal.status = ProposalStatus::Closed;
        Ok(())
    }

    /// Re-queue reveal_tally for a proposal stuck in Closed (e.g. nodes were down).
    pub fn retry_reveal_tally(ctx: Context<RetryRevealTally>, computation_offset: u64) -> Result<()> {
        require!(
            ctx.accounts.proposal.status == ProposalStatus::Closed,
            ErrorCode::InvalidProposalStatus
        );

        ctx.accounts.sign_pda_account.bump = ctx.bumps.sign_pda_account;

        let tally_nonce = ctx.accounts.proposal.running_tally_nonce;
        let tally_ct = ctx.accounts.proposal.running_tally_ciphertext;

        let args = ArgBuilder::new().plaintext_u128(tally_nonce).encrypted_u8(tally_ct).build();

        let callback_ix = RevealTallyCallback::callback_ix(
            computation_offset,
            &ctx.accounts.mxe_account,
            &[CallbackAccount {
                pubkey: ctx.accounts.proposal.key(),
                is_writable: true,
            }],
        )?;
        queue_computation(ctx.accounts, computation_offset, args, vec![callback_ix], 1, 0)?;

        Ok(())
    }

    /// Callback: store revealed tally and finalize proposal.
    #[arcium_callback(encrypted_ix = "reveal_tally")]
    pub fn reveal_tally_callback(
        ctx: Context<RevealTallyCallback>,
        output: SignedComputationOutputs<RevealTallyOutput>,
    ) -> Result<()> {
        let tally = match output.verify_output(
            &ctx.accounts.cluster_account,
            &ctx.accounts.computation_account,
        ) {
            Ok(RevealTallyOutput { field_0 }) => field_0 as i64,
            Err(_) => return Err(ErrorCode::AbortedComputation.into()),
        };

        let proposal = &mut ctx.accounts.proposal;
        proposal.result = Some(tally);
        proposal.status = ProposalStatus::Finalized;

        emit!(ProposalFinalized {
            proposal: proposal.key(),
            net_tally: tally,
            passed: tally > 0,
        });
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Account structs — comp def init (uses arcium macro)
// ---------------------------------------------------------------------------

#[init_computation_definition_accounts("init_tally", payer)]
#[derive(Accounts)]
pub struct InitZeroTallyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("add_vote", payer)]
#[derive(Accounts)]
pub struct InitAddVoteCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

#[init_computation_definition_accounts("reveal_tally", payer)]
#[derive(Accounts)]
pub struct InitRevealTallyCompDef<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, address = derive_mxe_pda!())]
    pub mxe_account: Box<Account<'info, MXEAccount>>,
    #[account(mut)]
    /// CHECK: comp_def_account, checked by arcium program.
    pub comp_def_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_mxe_lut_pda!(mxe_account.lut_offset_slot))]
    /// CHECK: address_lookup_table, checked by arcium program.
    pub address_lookup_table: UncheckedAccount<'info>,
    #[account(address = LUT_PROGRAM_ID)]
    /// CHECK: lut_program is the Address Lookup Table program.
    pub lut_program: UncheckedAccount<'info>,
    pub arcium_program: Program<'info, Arcium>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Account structs — queue computation
// ---------------------------------------------------------------------------

#[queue_computation_accounts("init_tally", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct ZeroTally<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ZERO_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("init_tally")]
#[derive(Accounts)]
pub struct InitTallyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ZERO_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

// ---------------------------------------------------------------------------

#[queue_computation_accounts("add_vote", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CastVote<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_VOTE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Box<Account<'info, Cluster>>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Box<Account<'info, FeePool>>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Box<Account<'info, ClockAccount>>,
    #[account(mut)]
    pub proposal: Box<Account<'info, Proposal>>,
    #[account(
        mut,
        seeds = [VOTER_CREDITS_SEED, payer.key().as_ref()],
        bump = voter_credits.bump,
    )]
    pub voter_credits: Box<Account<'info, VoterCredits>>,
    /// PDA uniqueness = double-vote prevention
    #[account(
        init,
        payer = payer,
        space = VoterRecord::SPACE,
        seeds = [VOTER_RECORD_SEED, payer.key().as_ref(), proposal.key().as_ref()],
        bump,
    )]
    pub voter_record: Account<'info, VoterRecord>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("add_vote")]
#[derive(Accounts)]
pub struct AddVoteCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_ADD_VOTE))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

// ---------------------------------------------------------------------------

#[queue_computation_accounts("reveal_tally", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct RetryRevealTally<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[queue_computation_accounts("reveal_tally", payer)]
#[derive(Accounts)]
#[instruction(computation_offset: u64)]
pub struct CloseProposal<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init_if_needed, space = 9, payer = payer,
        seeds = [&SIGN_PDA_SEED], bump,
        address = derive_sign_pda!(),
    )]
    pub sign_pda_account: Account<'info, ArciumSignerAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    #[account(mut, address = derive_mempool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub mempool_account: UncheckedAccount<'info>,
    #[account(mut, address = derive_execpool_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub executing_pool: UncheckedAccount<'info>,
    #[account(mut, address = derive_comp_pda!(computation_offset, mxe_account, ErrorCode::ClusterNotSet))]
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(mut, address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(mut, address = ARCIUM_FEE_POOL_ACCOUNT_ADDRESS)]
    pub pool_account: Account<'info, FeePool>,
    #[account(mut, address = ARCIUM_CLOCK_ACCOUNT_ADDRESS)]
    pub clock_account: Account<'info, ClockAccount>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
    pub arcium_program: Program<'info, Arcium>,
}

#[callback_accounts("reveal_tally")]
#[derive(Accounts)]
pub struct RevealTallyCallback<'info> {
    pub arcium_program: Program<'info, Arcium>,
    #[account(address = derive_comp_def_pda!(COMP_DEF_OFFSET_REVEAL_TALLY))]
    pub comp_def_account: Account<'info, ComputationDefinitionAccount>,
    #[account(address = derive_mxe_pda!())]
    pub mxe_account: Account<'info, MXEAccount>,
    /// CHECK: checked by arcium program
    pub computation_account: UncheckedAccount<'info>,
    #[account(address = derive_cluster_pda!(mxe_account, ErrorCode::ClusterNotSet))]
    pub cluster_account: Account<'info, Cluster>,
    #[account(address = ::anchor_lang::solana_program::sysvar::instructions::ID)]
    /// CHECK: instructions sysvar
    pub instructions_sysvar: AccountInfo<'info>,
    #[account(mut)]
    pub proposal: Account<'info, Proposal>,
}

// ---------------------------------------------------------------------------
// Other account structs
// ---------------------------------------------------------------------------

#[derive(Accounts)]
pub struct RegisterVoter<'info> {
    #[account(mut)]
    pub voter: Signer<'info>,
    #[account(
        init,
        payer = voter,
        space = VoterCredits::SPACE,
        seeds = [VOTER_CREDITS_SEED, voter.key().as_ref()],
        bump,
    )]
    pub voter_credits: Account<'info, VoterCredits>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_nonce: u64)]
pub struct CreateProposal<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        init,
        payer = creator,
        space = Proposal::MAX_SPACE,
        seeds = [PROPOSAL_SEED, creator.key().as_ref(), &proposal_nonce.to_le_bytes()],
        bump,
    )]
    pub proposal: Account<'info, Proposal>,
    pub system_program: Program<'info, System>,
}

// ---------------------------------------------------------------------------
// Data accounts
// ---------------------------------------------------------------------------

#[account]
pub struct Proposal {
    pub creator: Pubkey,
    pub nonce: u64,
    pub title: String,
    pub description: String,
    pub end_time: i64,
    pub vote_count: u32,
    pub running_tally_ciphertext: [u8; 32],
    pub running_tally_nonce: u128,
    pub result: Option<i64>,
    pub status: ProposalStatus,
    pub bump: u8,
}

impl Proposal {
    pub const MAX_SPACE: usize = 8 + 32 + 8 + (4 + MAX_TITLE_LEN) + (4 + MAX_DESC_LEN) + 8 + 4 + 32 + 16 + 9 + 1 + 1;
}

#[account]
pub struct VoterCredits {
    pub voter: Pubkey,
    pub credits: u64,
    pub bump: u8,
}
impl VoterCredits {
    pub const SPACE: usize = 8 + 32 + 8 + 1;
}

#[account]
pub struct VoterRecord {
    pub voter: Pubkey,
    pub proposal: Pubkey,
    pub weight: u64,
    pub bump: u8,
}
impl VoterRecord {
    pub const SPACE: usize = 8 + 32 + 32 + 8 + 1;
}

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum ProposalStatus {
    Initializing,
    Active,
    Closed,
    Finalized,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[event]
pub struct ProposalActivated {
    pub proposal: Pubkey,
}

#[event]
pub struct VoteCast {
    pub proposal: Pubkey,
    pub vote_count: u32,
}

#[event]
pub struct ProposalFinalized {
    pub proposal: Pubkey,
    pub net_tally: i64,
    pub passed: bool,
}

// ---------------------------------------------------------------------------
// Errors — single enum; arcium requires AbortedComputation + ClusterNotSet
// ---------------------------------------------------------------------------

#[error_code]
pub enum ErrorCode {
    #[msg("The computation was aborted")]
    AbortedComputation,
    #[msg("MPC cluster not configured")]
    ClusterNotSet,
    #[msg("Proposal title exceeds 64 characters")]
    TitleTooLong,
    #[msg("Proposal description exceeds 256 characters")]
    DescriptionTooLong,
    #[msg("End time must be in the future")]
    EndTimeInPast,
    #[msg("Proposal is not in the expected status for this operation")]
    InvalidProposalStatus,
    #[msg("Voting period has ended")]
    ProposalEnded,
    #[msg("Voting period has not ended yet")]
    ProposalNotEnded,
    #[msg("num_votes must be at least 1")]
    ZeroVotes,
    #[msg("Quadratic credit cost overflows u64")]
    CreditOverflow,
    #[msg("Insufficient voting credits (need num_votes² credits)")]
    InsufficientCredits,
}
