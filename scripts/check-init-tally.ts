import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as crypto from "crypto";
import { getArciumProgram, getCompDefAccAddress, getCompDefAccOffset } from "@arcium-hq/client";

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
  const name = "init_tally";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);
  console.log(`init_tally offset: ${offset}`);
  console.log(`CompDef: ${compDefPubkey.toBase58()}`);

  const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
  const cs = compDef.circuitSource as any;
  console.log(`isCompleted: ${cs?.onChain?.[0]?.isCompleted}`);

  const rawAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!rawAcc) { console.log("no raw circuit acc"); return; }
  const onChainCircuit = rawAcc.data.subarray(9);
  const localCircuit = fs.readFileSync(`build/${name}.arcis`);
  const match = localCircuit.equals(onChainCircuit.subarray(0, localCircuit.length));
  const onChainHash = crypto.createHash('sha256').update(onChainCircuit.subarray(0, localCircuit.length)).digest();
  const localHash = crypto.createHash('sha256').update(localCircuit).digest();
  console.log(`on-chain bytes: ${rawAcc.data.length}, match: ${match}`);
  console.log(`SHA256 on-chain: [${[...onChainHash].join(',')}]`);
  console.log(`SHA256 local:    [${[...localHash].join(',')}]`);
  console.log(`Hashes match: ${onChainHash.equals(localHash)}`);
}
main().catch(console.error);
