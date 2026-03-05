import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;

const PROGRAM_ID = new PublicKey("CqUikXpnsHgymR3yN61YYzwj8vH82b7zyJSKaDwvVWED");

async function main() {
  const sigs = await provider.connection.getSignaturesForAddress(PROGRAM_ID, { limit: 5 }, "confirmed");

  // Find most recent callback tx
  for (const s of sigs) {
    const tx = await provider.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages ?? [];
    if (logs.some((l: string) => l.includes("ZeroTallyCallback"))) {
      console.log(`Callback tx: ${s.signature}`);
      console.log(`  err: ${JSON.stringify(s.err)}`);
      console.log(`  all logs:`);
      for (const log of logs) console.log(`    ${log}`);

      // Get instruction data from the tx
      const msg = (tx?.transaction as any)?.message;
      if (msg) {
        const instructions = msg.instructions ?? msg.compiledInstructions ?? [];
        for (let i = 0; i < instructions.length; i++) {
          const ix = instructions[i];
          const data = ix.data;
          console.log(`\n  Instruction ${i} data (${typeof data}):`);
          if (typeof data === 'string') {
            // base58
            const buf = Buffer.from(require('bs58').decode(data));
            console.log(`    hex: ${buf.toString('hex')}`);
            console.log(`    first byte (variant): ${buf[0]} (0=Success, 1=Failure)`);
          } else if (Buffer.isBuffer(data) || data instanceof Uint8Array) {
            console.log(`    hex: ${Buffer.from(data).toString('hex')}`);
            console.log(`    first byte (variant): ${data[0]}`);
          }
        }
      }
      break;
    }
  }
}
main().catch(console.error);
