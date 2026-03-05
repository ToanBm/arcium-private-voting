import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getArciumProgram,
  getCompDefAccOffset,
  getCompDefAccAddress,
} from "@arcium-hq/client";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);
const MXE_PROGRAM_ID = new PublicKey("CqUikXpnsHgymR3yN61YYzwj8vH82b7zyJSKaDwvVWED");

async function main() {
  for (const name of ["add_vote", "reveal_tally", "zero_tally"]) {
    const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
    const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
    const [rawCircuitPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("ComputationDefinitionRaw"), compDefPubkey.toBuffer(), Buffer.from([0])],
      arciumProgram.programId
    );
    const acc = await provider.connection.getAccountInfo(rawCircuitPda);
    const compDefAcc = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey).catch(() => null);
    const state = compDefAcc ? JSON.stringify((compDefAcc as any).circuitSource) : "N/A";
    console.log(`${name}: size=${acc ? acc.data.length : "null"} state=${state}`);
  }
}
main().catch(console.error);
