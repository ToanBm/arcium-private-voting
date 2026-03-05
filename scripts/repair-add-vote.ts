/**
 * repair-add-vote.ts
 *
 * The add_vote circuit was finalized before all data was written.
 * This script directly writes the missing bytes by calling upload_circuit
 * instructions, bypassing the arcium client's state check.
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/repair-add-vote.ts
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

async function repairCircuit(name: string) {
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey, 0);

  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
  console.log(`\nRepairing ${name} (${rawCircuit.length} bytes)...`);

  // Fetch current on-chain data
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) {
    console.log(`  Raw circuit account not found!`);
    return;
  }
  console.log(`  On-chain account size: ${onChainAcc.data.length} bytes`);

  // Account layout: 8-byte discriminator + 1-byte bump + circuit data
  const onChainData = onChainAcc.data.subarray(9);

  // Find which chunks need uploading (compare on-chain vs expected)
  const totalTxs = Math.ceil(rawCircuit.length / MAX_UPLOAD_PER_TX_BYTES);
  const missing: number[] = [];
  for (let i = 0; i < totalTxs; i++) {
    const start = i * MAX_UPLOAD_PER_TX_BYTES;
    const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, rawCircuit.length);
    const expected = rawCircuit.subarray(start, end);
    const actual = onChainData.subarray(start, end);
    if (!expected.equals(actual)) {
      missing.push(i);
    }
  }
  console.log(`  Missing ${missing.length}/${totalTxs} chunks`);
  if (missing.length === 0) {
    console.log(`  ✓ All data matches — nothing to repair`);
    return;
  }

  // Upload missing chunks one at a time
  const blockInfo = await provider.connection.getLatestBlockhash("confirmed");
  let uploaded = 0;
  let blockhashRefreshed = Date.now();

  for (const idx of missing) {
    const byteOffset = idx * MAX_UPLOAD_PER_TX_BYTES;
    const chunk = rawCircuit.subarray(byteOffset, byteOffset + MAX_UPLOAD_PER_TX_BYTES);

    // Pad to exactly MAX_UPLOAD_PER_TX_BYTES
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
    chunk.copy(padded);

    try {
      await (arciumProgram.methods as any)
        .uploadCircuit(offset, MXE_PROGRAM_ID, 0, Array.from(padded), byteOffset)
        .accounts({ signer: provider.wallet.publicKey })
        .rpc({ commitment: "confirmed", skipPreflight: false });

      uploaded++;
      if (uploaded % 50 === 0) {
        console.log(`  Uploaded ${uploaded}/${missing.length}...`);
      }
    } catch (e: any) {
      const msg = e?.transactionMessage ?? e?.message ?? String(e);
      console.error(`  Failed at chunk ${idx} (offset ${byteOffset}): ${msg}`);
      if (e?.transactionLogs) console.error("  Logs:", e.transactionLogs.slice(-5));
      // Stop on first real failure (not rate limit)
      if (!msg.includes("429") && !msg.includes("Too Many")) throw e;
      // Wait and retry on rate limit
      await new Promise((r) => setTimeout(r, 3000));
      missing.push(idx); // re-queue
    }
  }

  console.log(`  ✓ Uploaded ${uploaded} missing chunks for ${name}`);
}

async function main() {
  console.log(`Program:  ${MXE_PROGRAM_ID.toBase58()}`);
  console.log(`Payer:    ${provider.wallet.publicKey.toBase58()}`);
  await repairCircuit("add_vote");
  console.log("\nDone!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
