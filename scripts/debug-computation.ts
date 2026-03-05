/**
 * Debug script: queues a zero_tally computation and reads the raw computation
 * account bytes immediately after finalization to see if the cluster returns
 * Success or Failure.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getArciumProgram,
  getMXEAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getMempoolAccAddress,
  getExecutingPoolAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getArciumEnv,
  awaitComputationFinalization,
} from "@arcium-hq/client";
import { randomBytes } from "crypto";
import { PrivateVoting } from "../target/types/private_voting";
import idl from "../target/idl/private_voting.json";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);
const program = new anchor.Program(idl as anchor.Idl, provider) as unknown as anchor.Program<PrivateVoting>;
const arciumEnv = getArciumEnv();

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

async function main() {
  const payer = (provider.wallet as anchor.Wallet).payer;

  // Create a dummy proposal for zero_tally
  const nonce = new BN(randomBytes(8), "hex");
  const [proposalPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("proposal"), payer.publicKey.toBuffer(),
     (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nonce.toString())); return b; })()],
    program.programId
  );

  await program.methods.createProposal(
    nonce, "Debug", "Debug proposal", new BN(Math.floor(Date.now() / 1000) + 3600)
  ).accountsPartial({
    creator: payer.publicKey,
    proposal: proposalPda,
    systemProgram: anchor.web3.SystemProgram.programId,
  }).signers([payer]).rpc({ commitment: "confirmed", skipPreflight: true });

  console.log("Proposal created:", proposalPda.toBase58());

  const computationOffset = new BN(randomBytes(8), "hex");
  const compAccAddr = getComputationAccAddress(arciumEnv.arciumClusterOffset, computationOffset);

  await program.methods.zeroTally(computationOffset).accountsPartial({
    payer: payer.publicKey,
    mxeAccount: getMXEAccAddress(program.programId),
    computationAccount: compAccAddr,
    clusterAccount: getClusterAccAddress(arciumEnv.arciumClusterOffset),
    mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
    executingPool: getExecutingPoolAccAddress(arciumEnv.arciumClusterOffset),
    compDefAccount: getCompDefAccAddress(program.programId, compDefOffsetNum("zero_tally")),
    proposal: proposalPda,
  }).signers([payer]).rpc({ commitment: "confirmed", skipPreflight: true });

  console.log("ZeroTally queued, computation account:", compAccAddr.toBase58());
  console.log("Awaiting finalization...");

  await awaitComputationFinalization(provider, computationOffset, program.programId, "confirmed", 120_000);

  // Read raw bytes of computation account
  const accInfo = await provider.connection.getAccountInfo(compAccAddr, "confirmed");
  if (!accInfo) {
    console.log("Computation account already closed after finalization");
    return;
  }

  const data = accInfo.data;
  console.log("\nRaw computation account data:");
  console.log("  total bytes:", data.length);
  console.log("  first 64 bytes (hex):", data.slice(0, 64).toString("hex"));

  // The SignedComputationOutputs enum is serialized as:
  // 0 = Success(output_bytes, bls_sig_bytes)
  // 1 = Failure
  // 2 = MarkerForIdlBuildDoNotUseThis
  // The outputs field is somewhere in the account after the status/discriminator
  // Let's look at the account structure
  const compAcc = await arciumProgram.account.computationAccount.fetch(compAccAddr, "confirmed");
  console.log("\nDecoded computation account:");
  console.log("  status:", JSON.stringify(compAcc.status));
  console.log("  outputs field (raw):", JSON.stringify((compAcc as any).outputs ?? "not found"));
  console.log("  Full account:", JSON.stringify(compAcc, (key, val) => {
    if (typeof val === 'bigint') return val.toString();
    if (Array.isArray(val) && val.length > 20) return `[${val.length} bytes: ${val.slice(0, 8).join(',')}...]`;
    return val;
  }, 2));
}

main().catch(console.error);
