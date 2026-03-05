/**
 * Re-upload zero_tally circuit bytes to match what was finalized on-chain,
 * then optionally re-finalize if the comp def allows it.
 *
 * The issue: the on-chain raw circuit bytes were partially overwritten by a
 * later build/upload, corrupting them relative to the hash stored in the
 * comp def. The cluster verifies hash(bytes) == stored_hash and returns
 * Failure when they mismatch.
 *
 * Strategy: try calling uploadCircuit anyway (the client-side isCompleted
 * check is skippable), upload the LOCAL bytes, then try re-finalizing.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import {
  getArciumProgram,
  getCompDefAccAddress,
  getCompDefAccOffset,
} from "@arcium-hq/client";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);

const MXE_PROGRAM_ID = new PublicKey("CqUikXpnsHgymR3yN61YYzwj8vH82b7zyJSKaDwvVWED");
const MAX_UPLOAD_PER_TX_BYTES = 814;

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function getRawCircuitPda(compDefPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ComputationDefinitionRaw"), compDefPubkey.toBuffer(), Buffer.from([0])],
    arciumProgram.programId
  );
  return pda;
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function uploadWithRetry(offset: number, byteOffset: number, padded: Buffer, maxRetries = 10): Promise<string | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const sig = await (arciumProgram.methods as any)
        .uploadCircuit(offset, MXE_PROGRAM_ID, 0, Array.from(padded), byteOffset)
        .accounts({ signer: provider.wallet.publicKey })
        .rpc({ commitment: "confirmed", skipPreflight: true });
      return sig;
    } catch (e: any) {
      const msg: string = e?.transactionMessage ?? e?.message ?? String(e);
      if (msg.includes("429") || msg.includes("Too Many")) { await sleep(2000 * (attempt + 1)); continue; }
      if (msg.includes("Blockhash not found")) { await sleep(500); continue; }
      // Return error to caller
      return null;
    }
  }
  return null;
}

async function main() {
  const name = "zero_tally";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);

  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
  console.log(`Circuit size: ${rawCircuit.length} bytes`);

  // Check on-chain state
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) throw new Error("Raw circuit account not found");
  const onChainData = onChainAcc.data.subarray(9);

  // Find all chunks that differ
  const totalTxs = Math.ceil(rawCircuit.length / MAX_UPLOAD_PER_TX_BYTES);
  const missing: number[] = [];
  for (let i = 0; i < totalTxs; i++) {
    const start = i * MAX_UPLOAD_PER_TX_BYTES;
    const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, rawCircuit.length);
    const expected = rawCircuit.subarray(start, end);
    const actual = onChainData.subarray(start, end);
    if (!expected.equals(actual)) missing.push(i);
  }
  console.log(`Differing chunks: ${missing.length}/${totalTxs}`);
  if (missing.length === 0) { console.log("Already matches — nothing to do"); return; }

  // Try uploading the differing chunks (even though comp def is finalized)
  console.log("Attempting to overwrite differing chunks...");
  let successCount = 0;
  let failCount = 0;
  for (const idx of missing) {
    const byteOffset = idx * MAX_UPLOAD_PER_TX_BYTES;
    const chunk = rawCircuit.subarray(byteOffset, byteOffset + MAX_UPLOAD_PER_TX_BYTES);
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
    chunk.copy(padded);
    const sig = await uploadWithRetry(offset, byteOffset, padded);
    if (sig) {
      successCount++;
      if (successCount % 10 === 0) console.log(`  Progress: ${successCount}/${missing.length}`);
    } else {
      failCount++;
      if (failCount === 1) console.log(`  chunk ${idx} failed (comp def may prevent re-upload after finalization)`);
      break; // if first chunk fails, likely all will fail
    }
  }
  console.log(`Uploaded: ${successCount}, failed: ${failCount}`);

  if (successCount === 0) {
    console.log("\nCannot re-upload after finalization — need different strategy.");
    console.log("Options:");
    console.log("  1. Re-run arcium build + re-deploy MXE from scratch");
    console.log("  2. Contact Arcium support");
    return;
  }

  // If some uploaded, try re-finalizing
  if (successCount === missing.length) {
    console.log("\nAll chunks uploaded. Attempting re-finalization...");
    try {
      await (arciumProgram.methods as any)
        .finalizeComputationDefinition(offset, MXE_PROGRAM_ID)
        .accounts({ signer: provider.wallet.publicKey })
        .rpc({ commitment: "confirmed", skipPreflight: true });
      console.log("Re-finalization succeeded!");
    } catch (e: any) {
      console.log("Re-finalization failed:", e?.message ?? e);
    }
  }
}

main().catch(console.error);
