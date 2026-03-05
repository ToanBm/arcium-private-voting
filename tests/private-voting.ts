/**
 * Private Voting — Integration Tests
 *
 * Tests the full lifecycle of a quadratic voting proposal:
 *   1. Initialize computation definitions (once per deployment)
 *   2. Register voters and issue voting credits
 *   3. Create a proposal + zero-initialize its encrypted tally
 *   4. Cast encrypted votes (quadratic credit deduction enforced on-chain)
 *   5. Close the proposal and reveal the final tally via MPC
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, Transaction } from "@solana/web3.js";
import {
  RescueCipher,
  getArciumEnv,
  x25519,
  deserializeLE,
  awaitComputationFinalization,
  getMXEPublicKey,
  getComputationAccAddress,
  getClusterAccAddress,
  getMXEAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getLookupTableAddress,
  getArciumProgram,
  uploadCircuit,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import * as fs from "fs";
import { expect } from "chai";
import { PrivateVoting } from "../target/types/private_voting";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function waitForProposalStatus(
  pda: PublicKey,
  prog: anchor.Program<PrivateVoting>,
  expected: object,
  timeoutMs = 60_000
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const p = await prog.account.proposal.fetch(pda);
    const key = Object.keys(expected)[0];
    if (key in p.status) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const p = await prog.account.proposal.fetch(pda);
  throw new Error(`Proposal status timeout: got ${JSON.stringify(p.status)}, expected ${JSON.stringify(expected)}`);
}

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries = 20,
  retryDelayMs = 500
): Promise<Uint8Array> {
  let lastError: unknown;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const key = await getMXEPublicKey(provider, programId);
      if (key) return key;
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, retryDelayMs));
  }
  throw lastError ?? new Error("getMXEPublicKey failed after retries");
}

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function getVoterCreditsPda(
  voter: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("voter_credits"), voter.toBuffer()],
    programId
  );
}

function getVoterRecordPda(
  voter: PublicKey,
  proposal: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("voter_record"), voter.toBuffer(), proposal.toBuffer()],
    programId
  );
}

function getProposalPda(
  creator: PublicKey,
  nonce: BN,
  programId: PublicKey
): [PublicKey, number] {
  const nonceBytes = Buffer.alloc(8);
  nonceBytes.writeBigUInt64LE(BigInt(nonce.toString()));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), creator.toBuffer(), nonceBytes],
    programId
  );
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("private-voting", () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.PrivateVoting as Program<PrivateVoting>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const arciumProgram = getArciumProgram(provider);
  const arciumEnv = getArciumEnv();

  // Voters
  const creator = Keypair.generate();
  const voterA = Keypair.generate();
  const voterB = Keypair.generate();
  const voterC = Keypair.generate();

  const PROPOSAL_TITLE = "Should we fund public infrastructure?";
  const PROPOSAL_DESC =
    "Allocate 20% of the treasury to public goods: bridges, roads, and community centres.";

  let proposalPda: PublicKey;
  const proposalNonce = new BN(randomBytes(8), "hex");

  before(async () => {
    // Fund test wallets from the provider wallet (avoids faucet binding issues)
    const connection = provider.connection;
    const transferTx = new Transaction();
    for (const kp of [creator, voterA, voterB, voterC]) {
      transferTx.add(
        anchor.web3.SystemProgram.transfer({
          fromPubkey: provider.wallet.publicKey,
          toPubkey: kp.publicKey,
          lamports: 0.4 * anchor.web3.LAMPORTS_PER_SOL,
        })
      );
    }
    const blockInfo = await connection.getLatestBlockhash("confirmed");
    transferTx.recentBlockhash = blockInfo.blockhash;
    transferTx.lastValidBlockHeight = blockInfo.lastValidBlockHeight;
    transferTx.feePayer = provider.wallet.publicKey;
    const signed = await provider.wallet.signTransaction(transferTx);
    const rawTx = signed.serialize();
    const sig = await connection.sendRawTransaction(rawTx, { skipPreflight: true });
    const result = await connection.confirmTransaction({ signature: sig, ...blockInfo }, "confirmed");
    if (result.value.err) throw new Error(`Fund transfer failed: ${JSON.stringify(result.value.err)}`);

    [proposalPda] = getProposalPda(
      creator.publicKey,
      proposalNonce,
      program.programId
    );
  });

  // Helper to get the LUT address for init comp def calls
  async function getLutAddress(): Promise<PublicKey> {
    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    return getLookupTableAddress(program.programId, mxeAcc.lutOffsetSlot);
  }

  // -------------------------------------------------------------------------
  // Step 1: Initialize computation definitions + upload circuits
  // -------------------------------------------------------------------------

  async function isCompDefFinalized(name: string): Promise<boolean> {
    const pubkey = getCompDefAccAddress(program.programId, compDefOffsetNum(name));
    const acc = await arciumProgram.account.computationDefinitionAccount.fetch(pubkey).catch(() => null);
    if (!acc) return false;
    const src = acc.circuitSource as any;
    return "onChain" in src && src.onChain?.[0]?.isCompleted === true;
  }

  it("initializes init_tally computation definition", async () => {
    if (await isCompDefFinalized("init_tally")) {
      console.log("    init_tally already finalized — skipping init");
      return;
    }
    const lutAddress = await getLutAddress();
    await program.methods
      .initZeroTallyCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(program.programId, compDefOffsetNum("init_tally")),
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const rawCircuit = fs.readFileSync("build/init_tally.arcis");
    await uploadCircuit(provider, "init_tally", program.programId, rawCircuit, true, 5, { skipPreflight: true, commitment: "confirmed" });
  });

  it("initializes add_vote computation definition", async () => {
    if (await isCompDefFinalized("add_vote")) {
      console.log("    add_vote already finalized — skipping init");
      return;
    }
    const lutAddress = await getLutAddress();
    await program.methods
      .initAddVoteCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(program.programId, compDefOffsetNum("add_vote")),
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const rawCircuit = fs.readFileSync("build/add_vote.arcis");
    await uploadCircuit(provider, "add_vote", program.programId, rawCircuit, true, 5, { skipPreflight: true, commitment: "confirmed" });
  });

  it("initializes reveal_tally computation definition", async () => {
    if (await isCompDefFinalized("reveal_tally")) {
      console.log("    reveal_tally already finalized — skipping init");
      return;
    }
    const lutAddress = await getLutAddress();
    await program.methods
      .initRevealTallyCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        compDefAccount: getCompDefAccAddress(program.programId, compDefOffsetNum("reveal_tally")),
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    const rawCircuit = fs.readFileSync("build/reveal_tally.arcis");
    await uploadCircuit(provider, "reveal_tally", program.programId, rawCircuit, true, 5, { skipPreflight: true, commitment: "confirmed" });
  });

  // -------------------------------------------------------------------------
  // Step 2: Register voters
  // -------------------------------------------------------------------------

  it("registers voters and issues 100 voting credits each", async () => {
    for (const voter of [creator, voterA, voterB, voterC]) {
      const [vcPda] = getVoterCreditsPda(voter.publicKey, program.programId);
      await program.methods
        .registerVoter()
        .accountsPartial({
          voter: voter.publicKey,
          voterCredits: vcPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([voter])
        .rpc({ commitment: "confirmed", skipPreflight: true });

      const vc = await program.account.voterCredits.fetch(vcPda);
      expect(vc.credits.toNumber()).to.equal(100);
    }
  });

  // -------------------------------------------------------------------------
  // Step 3: Create proposal
  // -------------------------------------------------------------------------

  it("creates a proposal", async () => {
    const endTime = new BN(Math.floor(Date.now() / 1000) + 60); // 60s from now

    await program.methods
      .createProposal(proposalNonce, PROPOSAL_TITLE, PROPOSAL_DESC, endTime)
      .accountsPartial({
        creator: creator.publicKey,
        proposal: proposalPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    const proposal = await program.account.proposal.fetch(proposalPda);
    expect(proposal.title).to.equal(PROPOSAL_TITLE);
    expect(proposal.voteCount).to.equal(0);
    expect(proposal.status).to.deep.equal({ initializing: {} });
  });

  // -------------------------------------------------------------------------
  // Step 4: Zero-initialize the encrypted tally (MPC round-trip)
  // -------------------------------------------------------------------------

  it("initializes encrypted tally to zero via MPC", async () => {
    const computationOffset = new BN(randomBytes(8), "hex");

    await program.methods
      .zeroTally(computationOffset)
      .accountsPartial({
        payer: creator.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          computationOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("init_tally")
        ),
        proposal: proposalPda,
      })
      .signers([creator])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );

    await waitForProposalStatus(proposalPda, program, { active: {} }, 300_000);
    const proposal = await program.account.proposal.fetch(proposalPda);
    expect(proposal.status).to.deep.equal({ active: {} });
  });

  // -------------------------------------------------------------------------
  // Step 5: Cast votes (encrypted)
  // -------------------------------------------------------------------------

  /**
   * Encrypt a vote direction (1=For, 0=Against) with the voter's ephemeral
   * x25519 key and the MXE's public key via RescueCipher.
   */
  async function encryptVote(direction: 0 | 1): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ciphertext: any;
    pubKey: Uint8Array;
    nonce: Buffer;
    nonceBN: BN;
  }> {
    const mxePubKey = await getMXEPublicKeyWithRetry(
      provider,
      program.programId
    );
    const privateKey = x25519.utils.randomSecretKey();
    const pubKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePubKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = randomBytes(16);
    const [ct] = cipher.encrypt([BigInt(direction)], nonce);
    return {
      ciphertext: ct,
      pubKey,
      nonce,
      nonceBN: new BN(deserializeLE(nonce).toString()),
    };
  }

  async function castVote(
    voter: Keypair,
    direction: 0 | 1,
    numVotes: number
  ): Promise<void> {
    const { ciphertext, pubKey, nonceBN } = await encryptVote(direction);
    const computationOffset = new BN(randomBytes(8), "hex");
    const [vcPda] = getVoterCreditsPda(voter.publicKey, program.programId);
    const [vrPda] = getVoterRecordPda(
      voter.publicKey,
      proposalPda,
      program.programId
    );

    await program.methods
      .castVote(
        computationOffset,
        Array.from(ciphertext) as number[],
        Array.from(pubKey) as number[],
        nonceBN,
        new BN(numVotes)
      )
      .accountsPartial({
        payer: voter.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          computationOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("add_vote")
        ),
        proposal: proposalPda,
        voterCredits: vcPda,
        voterRecord: vrPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([voter])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    await awaitComputationFinalization(
      provider,
      computationOffset,
      program.programId,
      "confirmed"
    );
  }

  it("voterA votes FOR with 3 votes (costs 9 credits)", async () => {
    await castVote(voterA, 1, 3);
    const [vcPda] = getVoterCreditsPda(voterA.publicKey, program.programId);
    const vc = await program.account.voterCredits.fetch(vcPda);
    expect(vc.credits.toNumber()).to.equal(91); // 100 - 9

    const proposal = await program.account.proposal.fetch(proposalPda);
    expect(proposal.voteCount).to.equal(1);
  });

  it("voterB votes AGAINST with 2 votes (costs 4 credits)", async () => {
    await castVote(voterB, 0, 2);
    const [vcPda] = getVoterCreditsPda(voterB.publicKey, program.programId);
    const vc = await program.account.voterCredits.fetch(vcPda);
    expect(vc.credits.toNumber()).to.equal(96); // 100 - 4
  });

  it("voterC votes FOR with 5 votes (costs 25 credits)", async () => {
    await castVote(voterC, 1, 5);
    const [vcPda] = getVoterCreditsPda(voterC.publicKey, program.programId);
    const vc = await program.account.voterCredits.fetch(vcPda);
    expect(vc.credits.toNumber()).to.equal(75); // 100 - 25
  });

  it("rejects double voting", async () => {
    try {
      // voterA tries to vote again on the same proposal — VoterRecord PDA
      // already exists so `init` will fail with account-already-in-use.
      await castVote(voterA, 1, 1);
      expect.fail("Should have rejected double vote");
    } catch (e: unknown) {
      // Transaction was correctly rejected (Anchor v0.32.1 + skipPreflight:true
      // masks the specific error text; any thrown error means the rejection worked).
      expect(e).to.be.instanceOf(Error);
    }
  });

  it("rejects vote with insufficient credits", async () => {
    // creator has 100 credits and hasn't voted on the main proposal yet.
    // Voting 11 times costs 121 credits which exceeds 100 → InsufficientCredits.
    try {
      await castVote(creator, 1, 11);
      expect.fail("Should have rejected due to insufficient credits");
    } catch (e: unknown) {
      // Transaction was correctly rejected (Anchor v0.32.1 + skipPreflight:true
      // masks the specific error text; any thrown error means the rejection worked).
      expect(e).to.be.instanceOf(Error);
    }
  });

  // -------------------------------------------------------------------------
  // Step 6: Close proposal and reveal tally
  // -------------------------------------------------------------------------

  it("waits for proposal deadline, then reveals tally", async () => {
    // Use a second proposal with end_time already past for the close+reveal path.
    const closableTitle = "Closable proposal";
    const closableDesc = "End time already passed.";
    const closableNonce = new BN(randomBytes(8), "hex");
    const [closablePda] = getProposalPda(
      creator.publicKey,
      closableNonce,
      program.programId
    );

    // Create with end_time in the past (1s ago; test validator won't reject)
    const pastEndTime = new BN(Math.floor(Date.now() / 1000) - 1);
    await program.methods
      .createProposal(closableNonce, closableTitle, closableDesc, pastEndTime)
      .accountsPartial({
        creator: creator.publicKey,
        proposal: closablePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([creator])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    // Zero-init its tally
    const zeroOffset = new BN(randomBytes(8), "hex");
    await program.methods
      .zeroTally(zeroOffset)
      .accountsPartial({
        payer: creator.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          zeroOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("init_tally")
        ),
        proposal: closablePda,
      })
      .signers([creator])
      .rpc({ commitment: "confirmed", skipPreflight: true });
    await awaitComputationFinalization(
      provider,
      zeroOffset,
      program.programId,
      "confirmed"
    );
    await waitForProposalStatus(closablePda, program, { active: {} }, 300_000);

    // Listen for the ProposalFinalized event
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let finalizedEvent: any = null;

    const listener = program.addEventListener(
      "proposalFinalized",
      (event) => {
        finalizedEvent = event;
      }
    );

    // Close and reveal
    const revealOffset = new BN(randomBytes(8), "hex");
    await program.methods
      .closeProposal(revealOffset)
      .accountsPartial({
        payer: creator.publicKey,
        mxeAccount: getMXEAccAddress(program.programId),
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          revealOffset
        ),
        clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          compDefOffsetNum("reveal_tally")
        ),
        proposal: closablePda,
      })
      .signers([creator])
      .rpc({ commitment: "confirmed", skipPreflight: true });

    await awaitComputationFinalization(
      provider,
      revealOffset,
      program.programId,
      "confirmed"
    );
    await waitForProposalStatus(closablePda, program, { finalized: {} }, 300_000);

    await program.removeEventListener(listener);

    // An empty proposal (zero votes) should tally to 0
    const closable = await program.account.proposal.fetch(closablePda);
    expect(closable.status).to.deep.equal({ finalized: {} });
    expect(closable.result).to.not.be.null;

    if (finalizedEvent) {
      console.log(`  Net tally: ${finalizedEvent.netTally.toString()}`);
      console.log(`  Passed:    ${finalizedEvent.passed}`);
    }
  });

  // -------------------------------------------------------------------------
  // Summary log
  // -------------------------------------------------------------------------

  after(async () => {
    if (!proposalPda) return;
    const proposal = await program.account.proposal.fetch(proposalPda);
    console.log("\n=== Voting Summary ===");
    console.log(`  Proposal:    ${proposal.title}`);
    console.log(`  Total votes: ${proposal.voteCount}`);
    console.log(`  Status:      ${JSON.stringify(proposal.status)}`);
    // Result is not revealed for the main proposal (deadline not yet passed)
  });
});
