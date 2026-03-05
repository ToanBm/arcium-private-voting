import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
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

function compDefOffsetNum(name: string): number {
  return Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
}

async function main() {
  const name = "zero_tally";
  const offset = compDefOffsetNum(name);

  const rawCircuit = fs.readFileSync(`build/${name}.arcis`);
  const padded = Buffer.alloc(814);
  rawCircuit.subarray(814, 814+814).copy(padded); // chunk 1

  try {
    await (arciumProgram.methods as any)
      .uploadCircuit(offset, MXE_PROGRAM_ID, 0, Array.from(padded), 814)
      .accounts({ signer: provider.wallet.publicKey })
      .rpc({ commitment: "confirmed", skipPreflight: false });
    console.log("Upload succeeded (unexpected!)");
  } catch (e: any) {
    console.log("Error message:", e?.message);
    console.log("Error transactionMessage:", e?.transactionMessage);
    console.log("Error logs:", e?.transactionLogs ?? e?.logs);
    console.log("Error code:", e?.error?.errorCode);
  }
}

main().catch(console.error);
