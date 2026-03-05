/**
 * fix-circuits.ts
 *
 * Fixes the remaining circuit uploads:
 *  - add_vote: raw circuit acc exists at 747520 bytes, needs resize to 901313 + upload + finalize
 *  - reveal_tally: comp def doesn't exist yet, needs init + fresh uploadCircuit
 *
 * Run:
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn ts-node scripts/fix-circuits.ts
 */

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, Transaction } from "@solana/web3.js";
import * as fs from "fs";
import {
  getArciumProgram,
  getMXEAccAddress,
  getCompDefAccAddress,
  getCompDefAccOffset,
  getLookupTableAddress,
} from "@arcium-hq/client";
import { PrivateVoting } from "../target/types/private_voting";
import idl from "../target/idl/private_voting.json";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const program = new anchor.Program(idl as anchor.Idl, provider) as unknown as anchor.Program<PrivateVoting>;
const arciumProgram = getArciumProgram(provider);

const MXE_PROGRAM_ID = new PublicKey("CLUBgAStu51VNK9BWaDujZYvrM55MAmfq7CLZ3KY3mmD");
const MAX_REALLOC_PER_IX = 10240;
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

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTxWithRetry(tx: Transaction, maxRetries = 5): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const blockInfo = await provider.connection.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = blockInfo.blockhash;
      tx.lastValidBlockHeight = blockInfo.lastValidBlockHeight;
      tx.feePayer = provider.wallet.publicKey;

      const signed = await provider.wallet.signTransaction(tx);
      const rawTx = signed.serialize();
      const sig = await provider.connection.sendRawTransaction(rawTx, { skipPreflight: true });
      await provider.connection.confirmTransaction(
        { signature: sig, blockhash: blockInfo.blockhash, lastValidBlockHeight: blockInfo.lastValidBlockHeight },
        "confirmed"
      );
      return sig;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (attempt < maxRetries - 1 && (msg.includes("Blockhash") || msg.includes("429"))) {
        console.log(`    retry ${attempt + 1}...`);
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error("sendTxWithRetry exhausted");
}

const MAX_RESIZE_IXS_PER_TX = 18; // ~52 bytes/IX, stays under 1232-byte tx limit

async function resizeRawCircuitAcc(
  offset: number,
  compDefPubkey: PublicKey,
  currentBytes: number,
  requiredBytes: number
) {
  const delta = requiredBytes - currentBytes;
  if (delta <= 0) {
    console.log("  Account already big enough, skipping resize");
    return;
  }
  const ixCount = Math.ceil(delta / MAX_REALLOC_PER_IX);
  const txCount = Math.ceil(ixCount / MAX_RESIZE_IXS_PER_TX);
  console.log(`  Resizing: ${currentBytes} → ${requiredBytes} bytes (${ixCount} IXs across ${txCount} txs)`);

  const ix = await arciumProgram.methods
    .embiggenRawCircuitAcc(offset, MXE_PROGRAM_ID, 0)
    .accounts({ signer: provider.wallet.publicKey })
    .instruction();

  let remaining = ixCount;
  for (let t = 0; t < txCount; t++) {
    const batch = Math.min(remaining, MAX_RESIZE_IXS_PER_TX);
    const tx = new Transaction();
    for (let i = 0; i < batch; i++) tx.add(ix);
    await sendTxWithRetry(tx);
    remaining -= batch;
  }
  console.log("  ✓ Resize complete");
}

async function uploadWithRetry(
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
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (msg.includes("Blockhash not found")) {
        await sleep(500);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`uploadCircuit failed after ${maxRetries} retries at offset ${byteOffset}`);
}

async function uploadMissingChunks(name: string, offset: number, rawCircuit: Buffer) {
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);

  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) throw new Error(`Raw circuit account not found for ${name}`);

  // Layout: 8-byte discriminator + 1-byte bump + circuit data
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
  console.log(`  Missing ${missing.length}/${totalTxs} chunks — uploading...`);

  let uploaded = 0;
  for (const idx of missing) {
    const byteOffset = idx * MAX_UPLOAD_PER_TX_BYTES;
    const chunk = rawCircuit.subarray(byteOffset, byteOffset + MAX_UPLOAD_PER_TX_BYTES);
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
    chunk.copy(padded);
    await uploadWithRetry(offset, byteOffset, padded);
    uploaded++;
    if (uploaded % 20 === 0) console.log(`  Progress: ${uploaded}/${missing.length}`);
  }
  console.log(`  ✓ Uploaded ${uploaded} chunks`);
}

async function finalizeCircuit(offset: number) {
  const tx = await (arciumProgram.methods as any)
    .finalizeComputationDefinition(offset, MXE_PROGRAM_ID)
    .accounts({ signer: provider.wallet.publicKey })
    .transaction();
  await sendTxWithRetry(tx);
  console.log("  ✓ Finalized");
}

async function fixInitTally() {
  console.log("\n=== init_tally ===");
  const name = "init_tally";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);

  // Comp def should already be initialized
  const compDefAcc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey).catch(() => null);
  if (!compDefAcc) throw new Error("init_tally comp def not found — run init-comp-defs.ts first");

  const circuitSource = compDefAcc.circuitSource as any;
  if ("onChain" in circuitSource && circuitSource.onChain?.[0]?.isCompleted) {
    console.log("  Already finalized — skipping");
    return;
  }

  const rawCircuitPda = getRawCircuitPda(compDefPubkey);
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  const currentBytes = onChainAcc ? onChainAcc.data.length : 0;
  const requiredBytes = rawCircuit.length + 9;

  await resizeRawCircuitAcc(offset, compDefPubkey, currentBytes, requiredBytes);
  await uploadMissingChunks(name, offset, rawCircuit);
  await finalizeCircuit(offset);
}

async function fixAddVote() {
  console.log("\n=== add_vote ===");
  const name = "add_vote";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);

  // Check current state
  const compDefAcc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey).catch(() => null);
  if (compDefAcc) {
    const circuitSource = compDefAcc.circuitSource as any;
    if ("onChain" in circuitSource && circuitSource.onChain?.[0]?.isCompleted) {
      console.log("  Already finalized — skipping");
      return;
    }
  }

  // Init comp def if missing
  if (!compDefAcc) {
    console.log("  Initializing comp def...");
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(MXE_PROGRAM_ID));
    const lutAddress = getLookupTableAddress(MXE_PROGRAM_ID, mxeAcc.lutOffsetSlot);
    await (program.methods as any)
      .initAddVoteCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(MXE_PROGRAM_ID),
        compDefAccount: compDefPubkey,
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    console.log("  ✓ Comp def initialized");
  } else {
    console.log("  Comp def already exists");
  }

  const rawCircuitPda = getRawCircuitPda(compDefPubkey);
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  const currentBytes = onChainAcc ? onChainAcc.data.length : 0;
  const requiredBytes = rawCircuit.length + 9;

  if (!onChainAcc) {
    console.log("  Initializing raw circuit acc...");
    await arciumProgram.methods
      .initRawCircuitAcc(offset, MXE_PROGRAM_ID, 0)
      .accounts({ signer: provider.wallet.publicKey })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    console.log("  ✓ Raw circuit acc initialized");
  }

  await resizeRawCircuitAcc(offset, compDefPubkey, currentBytes, requiredBytes);
  await uploadMissingChunks(name, offset, rawCircuit);
  await finalizeCircuit(offset);
}

async function fixRevealTally() {
  console.log("\n=== reveal_tally ===");
  const name = "reveal_tally";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);

  // Check if already finalized
  const compDefAcc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey).catch(() => null);
  if (compDefAcc) {
    const circuitSource = compDefAcc.circuitSource as any;
    if ("onChain" in circuitSource && circuitSource.onChain?.[0]?.isCompleted) {
      console.log("  Already finalized — skipping");
      return;
    }
  }

  // Init comp def if missing
  if (!compDefAcc) {
    console.log("  Initializing comp def...");
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(MXE_PROGRAM_ID));
    const lutAddress = getLookupTableAddress(MXE_PROGRAM_ID, mxeAcc.lutOffsetSlot);
    await (program.methods as any)
      .initRevealTallyCompDef()
      .accounts({
        payer: provider.wallet.publicKey,
        mxeAccount: getMXEAccAddress(MXE_PROGRAM_ID),
        compDefAccount: compDefPubkey,
        addressLookupTable: lutAddress,
      })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    console.log("  ✓ Comp def initialized");
  } else {
    console.log("  Comp def already exists");
  }

  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  const currentBytes = onChainAcc ? onChainAcc.data.length : 0;
  const requiredBytes = rawCircuit.length + 9;

  // Init raw circuit acc if missing (via arciumProgram directly)
  if (!onChainAcc) {
    console.log("  Initializing raw circuit acc...");
    await arciumProgram.methods
      .initRawCircuitAcc(offset, MXE_PROGRAM_ID, 0)
      .accounts({ signer: provider.wallet.publicKey })
      .rpc({ commitment: "confirmed", skipPreflight: true });
    console.log("  ✓ Raw circuit acc initialized");
  }

  await resizeRawCircuitAcc(offset, compDefPubkey, currentBytes, requiredBytes);
  await uploadMissingChunks(name, offset, rawCircuit);
  await finalizeCircuit(offset);
}

async function main() {
  console.log(`Program: ${MXE_PROGRAM_ID.toBase58()}`);
  console.log(`Payer:   ${provider.wallet.publicKey.toBase58()}`);

  await fixInitTally();
  await fixAddVote();
  await fixRevealTally();

  console.log("\n✓ All done!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
