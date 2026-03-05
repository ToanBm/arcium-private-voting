import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as crypto from "crypto";
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

function getRawCircuitPda(compDefPubkey: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("ComputationDefinitionRaw"), compDefPubkey.toBuffer(), Buffer.from([0])],
    arciumProgram.programId
  );
  return pda;
}

async function main() {
  for (const name of ["zero_tally", "add_vote", "reveal_tally"]) {
    const offset = compDefOffsetNum(name);
    const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
    const rawCircuitPda = getRawCircuitPda(compDefPubkey);

    console.log(`\n=== ${name} (offset=${offset}) ===`);
    console.log(`  CompDef: ${compDefPubkey.toBase58()}`);
    console.log(`  RawCircuit PDA: ${rawCircuitPda.toBase58()}`);

    try {
      const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
      const cs = compDef.circuitSource as any;
      const onChain = cs?.onChain?.[0];
      console.log(`  isCompleted: ${onChain?.isCompleted ?? "???"}`);

      // Get hash from circuitSource
      if (onChain?.hash) {
        const hash = Array.isArray(onChain.hash) ? onChain.hash : [...onChain.hash];
        console.log(`  on-chain hash: [${hash.join(',')}]`);
      }
    } catch (e: any) {
      console.log(`  ERROR fetching compDef: ${e.message}`);
    }

    // Local hash from build/
    try {
      const localHashStr = fs.readFileSync(`build/${name}.hash`, "utf8").trim();
      // Hash file is "[a,b,c,...]" format
      const localHash = JSON.parse(localHashStr);
      console.log(`  local hash:    [${localHash.join(',')}]`);
    } catch (e: any) {
      console.log(`  local hash file: ${e.message}`);
    }

    // Check raw circuit account
    try {
      const rawAcc = await provider.connection.getAccountInfo(rawCircuitPda);
      if (rawAcc) {
        console.log(`  raw circuit acc: ${rawAcc.data.length} bytes`);
        // Compare with local
        const localCircuit = fs.readFileSync(`build/${name}.arcis`);
        const onChainCircuit = rawAcc.data.subarray(9); // skip 8-byte discriminator + 1-byte bump
        const match = localCircuit.equals(onChainCircuit.subarray(0, localCircuit.length));
        const zeroPad = onChainCircuit.subarray(localCircuit.length).every((b: number) => b === 0);
        console.log(`  circuit match: ${match}, zero-padded remainder: ${zeroPad}`);
      } else {
        console.log(`  raw circuit acc: NOT FOUND`);
      }
    } catch (e: any) {
      console.log(`  raw circuit acc error: ${e.message}`);
    }
  }
}

main().catch(console.error);
