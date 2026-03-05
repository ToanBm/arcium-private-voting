import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;

const KEYGEN_COMP_ACCT = new PublicKey("FLhJKsQNAc1U7WttykfAxtdTZQYx8dheUvK7EsX78knf");
const ARCIUM_PROGRAM = new PublicKey("Arcj82pX7HxYKLR92qvgZUAd7vGS1k4hQvAFcPATFdEQ");

async function main() {
  // Get transactions for the keygen computation account
  const sigs = await provider.connection.getSignaturesForAddress(KEYGEN_COMP_ACCT, { limit: 10 }, "confirmed");
  console.log(`Transactions for keygen computation account (${KEYGEN_COMP_ACCT.toBase58()}):`);

  for (const s of sigs) {
    const tx = await provider.connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    const err = s.err ? JSON.stringify(s.err) : "OK";
    const logs = tx?.meta?.logMessages ?? [];
    console.log(`\n  ${s.signature.slice(0,20)}... err=${err}`);
    for (const log of logs) console.log(`    ${log}`);

    // Get instruction data
    const msg = (tx?.transaction as any)?.message;
    const instructions = msg?.instructions ?? msg?.compiledInstructions ?? [];
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      const data = ix.data;
      let hex = '';
      if (typeof data === 'string') {
        try { hex = Buffer.from(require('bs58').decode(data)).toString('hex'); } catch {}
      } else if (data) {
        hex = Buffer.from(data).toString('hex');
      }
      if (hex) {
        console.log(`    Instruction ${i} data: ${hex.slice(0, 40)}... (${hex.length/2} bytes)`);
        // Check if byte 8 (after 8-byte discriminator) indicates Success(0) or Failure(1)
        if (hex.length >= 18) {
          const variantByte = parseInt(hex.slice(16, 18), 16);
          console.log(`    Variant byte (at offset 8): ${variantByte} (0=Success, 1=Failure)`);
        }
      }
    }
  }
}
main().catch(console.error);
