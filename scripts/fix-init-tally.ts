/**
 * Upload missing init_tally circuit chunks and finalize the comp def.
 * Safe to re-run — skips already-matching chunks.
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
const MAX_REALLOC_PER_IX = 10240;

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

async function uploadWithRetry(offset: number, byteOffset: number, padded: Buffer, maxRetries = 15): Promise<void> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await (arciumProgram.methods as any)
        .uploadCircuit(offset, MXE_PROGRAM_ID, 0, Array.from(padded), byteOffset)
        .accounts({ signer: provider.wallet.publicKey })
        .rpc({ commitment: "confirmed", skipPreflight: true });
      return;
    } catch (e: any) {
      const msg: string = e?.transactionMessage ?? e?.message ?? String(e);
      if (msg.includes("429") || msg.includes("Too Many")) {
        const delay = Math.min(500 * Math.pow(2, attempt), 16000);
        await sleep(delay);
        continue;
      }
      if (msg.includes("Blockhash not found")) { await sleep(500); continue; }
      throw e;
    }
  }
  throw new Error(`uploadCircuit failed after ${maxRetries} retries at offset ${byteOffset}`);
}

async function sendTxWithRetry(tx: Transaction, maxRetries = 10): Promise<string> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const blockInfo = await provider.connection.getLatestBlockhash({ commitment: "confirmed" });
      tx.recentBlockhash = blockInfo.blockhash;
      tx.lastValidBlockHeight = blockInfo.lastValidBlockHeight;
      tx.feePayer = provider.wallet.publicKey;
      const signed = await provider.wallet.signTransaction(tx);
      const sig = await provider.connection.sendRawTransaction(signed.serialize(), { skipPreflight: true });
      await provider.connection.confirmTransaction({ signature: sig, ...blockInfo }, "confirmed");
      return sig;
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (attempt < maxRetries - 1 && (msg.includes("Blockhash") || msg.includes("429"))) {
        await sleep(1000 * (attempt + 1)); continue;
      }
      throw e;
    }
  }
  throw new Error("sendTxWithRetry exhausted");
}

async function main() {
  const name = "init_tally";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);

  console.log(`CompDef: ${compDefPubkey.toBase58()}`);
  console.log(`RawCircuit PDA: ${rawCircuitPda.toBase58()}`);

  // Check current state
  const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
  const cs = compDef.circuitSource as any;
  const onChain = cs?.onChain?.[0];
  console.log(`isCompleted: ${onChain?.isCompleted ?? "???"}`);

  if (onChain?.isCompleted) {
    console.log("Already finalized — nothing to do!");
    return;
  }

  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
  console.log(`Local circuit: ${rawCircuit.length} bytes`);

  // Check on-chain state
  const onChainAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!onChainAcc) throw new Error("Raw circuit account not found — run init-comp-defs.ts first");
  const onChainData = onChainAcc.data.subarray(9);

  // Size check
  const requiredBytes = rawCircuit.length + 9;
  if (onChainAcc.data.length < requiredBytes) {
    console.log(`Resizing: ${onChainAcc.data.length} → ${requiredBytes} bytes`);
    const delta = requiredBytes - onChainAcc.data.length;
    const ixCount = Math.ceil(delta / MAX_REALLOC_PER_IX);
    const ix = await arciumProgram.methods
      .embiggenRawCircuitAcc(offset, MXE_PROGRAM_ID, 0)
      .accounts({ signer: provider.wallet.publicKey })
      .instruction();
    const tx = new Transaction();
    for (let i = 0; i < ixCount; i++) tx.add(ix);
    await sendTxWithRetry(tx);
    console.log("Resize done");
  }

  // Find missing chunks
  const totalTxs = Math.ceil(rawCircuit.length / MAX_UPLOAD_PER_TX_BYTES);
  const missing: number[] = [];
  for (let i = 0; i < totalTxs; i++) {
    const start = i * MAX_UPLOAD_PER_TX_BYTES;
    const end = Math.min(start + MAX_UPLOAD_PER_TX_BYTES, rawCircuit.length);
    const expected = rawCircuit.subarray(start, end);
    const actual = onChainData.subarray(start, end);
    if (!expected.equals(actual)) missing.push(i);
  }
  console.log(`Missing ${missing.length}/${totalTxs} chunks — uploading...`);

  let uploaded = 0;
  for (const idx of missing) {
    const byteOffset = idx * MAX_UPLOAD_PER_TX_BYTES;
    const chunk = rawCircuit.subarray(byteOffset, byteOffset + MAX_UPLOAD_PER_TX_BYTES);
    const padded = Buffer.alloc(MAX_UPLOAD_PER_TX_BYTES);
    chunk.copy(padded);
    await uploadWithRetry(offset, byteOffset, padded);
    uploaded++;
    if (uploaded % 10 === 0) console.log(`  Progress: ${uploaded}/${missing.length}`);
  }
  console.log(`Uploaded ${uploaded} chunks`);

  // Finalize
  console.log("Finalizing...");
  await (arciumProgram.methods as any)
    .finalizeComputationDefinition(offset, MXE_PROGRAM_ID)
    .accounts({ signer: provider.wallet.publicKey })
    .rpc({ commitment: "confirmed", skipPreflight: true });
  console.log("✓ init_tally finalized!");
}

main().catch(console.error);
