/**
 * upload-circuit-manual.ts
 *
 * Manually upload circuit bytes + finalize for circuits that are still
 * OnchainPending but whose raw circuit account already has the right size
 * (so the arcium client's uploadCircuit incorrectly skips them).
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/upload-circuit-manual.ts reveal_tally
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import {
  getArciumProgram,
  getCompDefAccOffset,
  getCompDefAccAddress,
} from "@arcium-hq/client";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);

const MXE_PROGRAM_ID = new PublicKey("21hcB1BE1R3yhoYoGbWqP7qfPfdsCRvb6pHTiMRwSpyJ");
const MAX_UPLOAD_PER_TX_BYTES = 814;

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

function getRawCircuitPda(compDefPubkey: PublicKey, rawCircuitIndex: number): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("ComputationDefinitionRaw"),
      compDefPubkey.toBuffer(),
      Buffer.from([rawCircuitIndex]),
    ],
    arciumProgram.programId
  );
  return pda;
}

function buildFinalizeCompDefTx(offset: number) {
  return (arciumProgram.methods as any)
    .finalizeComputationDefinition(offset, MXE_PROGRAM_ID)
    .accounts({ signer: provider.wallet.publicKey })
    .transaction();
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function uploadWithRetry(
  name: string,
  offset: number,
  byteOffset: number,
  padded: Buffer,
  maxRetries = 10
): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await (arciumProgram.methods as any)
        .uploadCircuit(offset, MXE_PROGRAM_ID, 0, Array.from(padded), byteOffset)
        .accounts({ signer: provider.wallet.publicKey })
        .rpc({ commitment: "confirmed", skipPreflight: false });
      return;
    } catch (e: any) {
      const msg: string = e?.transactionMessage ?? e?.message ?? String(e);
      if (msg.includes("429") || msg.includes("Too Many")) {
        const delay = 2000 * (attempt + 1);
        await sleep(delay);
        continue;
      }
      if (msg.includes("Blockhash not found")) {
        // Blockhash expired — just retry, anchor will fetch fresh one
        await sleep(500);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`uploadCircuit failed after ${maxRetries} retries at offset ${byteOffset}`);
}

async function uploadCircuitManual(name: string) {
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey, 0);

  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
  console.log(`\nUploading ${name} (${rawCircuit.length} bytes)...`);

  // Check circuit state
  const compDefAcc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
  const circuitSource = compDefAcc.circuitSource as any;
  if ("onChain" in circuitSource && circuitSource.onChain?.[0]?.isCompleted) {
    console.log(`  Circuit already finalized — skipping`);
    return;
  }

  // Fetch current on-chain data to find missing chunks
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) {
    throw new Error(`Raw circuit account not found`);
  }
  // Account layout: 8-byte discriminator + 1-byte bump + circuit data
  const onChainData = onChainAcc.data.subarray(9);

  const totalTxs = Math.ceil(rawCircuit.length / MAX_UPLOAD_PER_TX_BYTES);
  const missing: number[] = [];
  for (let i = 0; i < totalTxs; i++) {
    const start = i * MAX_UPLOAD_PER_TX_BYTES;
    const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, rawCircuit.length);
    const expected = rawCircuit.subarray(start, end);
    const actual = onChainData.subarray(start, end);
    if (!expected.equals(actual)) missing.push(i);
  }
  console.log(`  Missing ${missing.length}/${totalTxs} chunks`);

  let uploaded = 0;
  for (const idx of missing) {
    const byteOffset = idx * MAX_UPLOAD_PER_TX_BYTES;
    const chunk = rawCircuit.subarray(byteOffset, byteOffset + MAX_UPLOAD_PER_TX_BYTES);
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
    chunk.copy(padded);

    await uploadWithRetry(name, offset, byteOffset, padded);
    uploaded++;
    if (uploaded % 20 === 0) {
      console.log(`  Progress: ${uploaded}/${missing.length} chunks`);
    }
  }

  console.log(`  Uploaded ${uploaded} chunks — finalizing...`);
  const finalizeTx = await buildFinalizeCompDefTx(offset);
  await provider.sendAndConfirm(finalizeTx, [], { commitment: "confirmed" });
  console.log(`  ✓ ${name} finalized`);
}

async function main() {
  const names = process.argv.slice(2);
  if (names.length === 0) {
    console.error("Usage: yarn ts-node scripts/upload-circuit-manual.ts <circuit_name> [...]");
    process.exit(1);
  }

  console.log(`Program: ${MXE_PROGRAM_ID.toBase58()}`);
  console.log(`Payer:   ${provider.wallet.publicKey.toBase58()}`);

  for (const name of names) {
    await uploadCircuitManual(name);
  }
  console.log("\nAll done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
