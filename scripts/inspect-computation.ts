import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
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
  // Get the most recent ZeroTally tx and find its computation account
  const sigs = await provider.connection.getSignaturesForAddress(MXE_PROGRAM_ID, { limit: 30 }, "confirmed");

  // Find the most recent ZeroTally tx
  for (const s of sigs) {
    const tx = await provider.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    if (logs.some((l: string) => l.includes("ZeroTally") && !l.includes("Callback")) && s.err === null) {
      console.log(`Found ZeroTally tx: ${s.signature}`);
      console.log(`  slot: ${s.slot}`);

      // Look at the accounts in the tx
      const accounts = tx?.transaction?.message?.staticAccountKeys ?? [];
      console.log(`  accounts (${accounts.length}):`);
      for (const acc of accounts) {
        console.log(`    ${acc.toBase58()}`);
        // Try to fetch as computation account
        try {
          const compAcc = await arciumProgram.account.computationAccount.fetchNullable(acc, "confirmed");
          if (compAcc) {
            console.log(`    ^^^ COMPUTATION ACCOUNT: status=${JSON.stringify(compAcc.status)}`);
            console.log(`        outputs=${JSON.stringify((compAcc as any).outputs ?? "N/A")}`);
          }
        } catch {}
      }
      break;
    }
  }
}
main().catch(console.error);
