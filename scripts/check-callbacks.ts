import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;

const PROGRAM_ID = new PublicKey("CqUikXpnsHgymR3yN61YYzwj8vH82b7zyJSKaDwvVWED");

async function main() {
  const sigs = await provider.connection.getSignaturesForAddress(PROGRAM_ID, { limit: 20 }, "confirmed");
  console.log(`Recent transactions for ${PROGRAM_ID.toBase58()}:`);
  for (const s of sigs) {
    const tx = await provider.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const err = s.err ? JSON.stringify(s.err) : "OK";
    const logs = tx?.meta?.logMessages ?? [];
    const ixLogs = logs.filter((l: string) => l.includes("Instruction") || l.includes("Error") || l.includes("error") || l.includes("Program log"));
    console.log(`\n  ${s.signature.slice(0, 20)}... slot=${s.slot} err=${err}`);
    for (const log of ixLogs.slice(0, 5)) {
      console.log(`    ${log}`);
    }
  }
}
main().catch(console.error);
