import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  getArciumProgram,
  getMXEAccAddress,
  getComputationAccAddress,
  getArciumEnv,
} from "@arcium-hq/client";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);
const arciumEnv = getArciumEnv();

const MXE_PROGRAM_ID = new PublicKey("CqUikXpnsHgymR3yN61YYzwj8vH82b7zyJSKaDwvVWED");

async function main() {
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(getMXEAccAddress(MXE_PROGRAM_ID));
  console.log("MXE keygenOffset (raw):", JSON.stringify(mxeAcc.keygenOffset));
  console.log("MXE keyRecoveryInitOffset (raw):", JSON.stringify((mxeAcc as any).keyRecoveryInitOffset));

  // The keygenOffset is stored as bytes - try to decode as u64 LE
  const keygenOffsetRaw = mxeAcc.keygenOffset as any;
  console.log("keygenOffset type:", typeof keygenOffsetRaw, Array.isArray(keygenOffsetRaw));

  // Try to get keygen computation account
  // The keygen computation is a special computation on the Arcium cluster
  // Let's try different interpretations of the offset
  // Try multiple interpretations
  for (const [label, keygenOffsetBN] of [
    ["hex-le from JSON string", new BN("7189b6cefd62fbb4", 'hex', 'le')],
    ["hex-be from JSON string", new BN("7189b6cefd62fbb4", 'hex', 'be')],
    ["raw BN if it's a BN", BN.isBN(keygenOffsetRaw) ? keygenOffsetRaw : null],
  ] as [string, BN | null][]) {
    if (!keygenOffsetBN) continue;
    console.log(`\n${label}: ${keygenOffsetBN.toString()}`);
    const compAddr = getComputationAccAddress(arciumEnv.arciumClusterOffset, keygenOffsetBN);
    console.log("  Keygen computation account:", compAddr.toBase58());
    const acc = await provider.connection.getAccountInfo(compAddr, "confirmed");
    console.log("  Account exists:", acc !== null, acc ? `(${acc.data.length} bytes)` : "");
  }
}
main().catch(console.error);
