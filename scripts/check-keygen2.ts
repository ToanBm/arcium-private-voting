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
const KEYGEN_COMP_ACCT = new PublicKey("FLhJKsQNAc1U7WttykfAxtdTZQYx8dheUvK7EsX78knf");

async function main() {
  const acc = await provider.connection.getAccountInfo(KEYGEN_COMP_ACCT, "confirmed");
  console.log("Keygen computation account raw data (hex):");
  console.log(acc?.data.toString("hex"));

  try {
    const compAcc = await arciumProgram.account.computationAccount.fetchNullable(KEYGEN_COMP_ACCT, "confirmed");
    if (compAcc) {
      console.log("\nDecoded status:", JSON.stringify(compAcc.status));
      console.log("Full:", JSON.stringify(compAcc, (k, v) => {
        if (typeof v === 'bigint') return v.toString();
        if (Array.isArray(v) && v.length > 20) return `[${v.length} bytes]`;
        return v;
      }, 2));
    }
  } catch (e: any) {
    console.log("Could not decode as computationAccount:", e.message);
    // Try raw
    const data = acc?.data;
    if (data) {
      console.log("\nRaw first 32 bytes:", data.slice(0, 32).toString("hex"));
    }
  }
}
main().catch(console.error);
