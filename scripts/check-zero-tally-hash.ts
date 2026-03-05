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
  const name = "zero_tally";
  const offset = compDefOffsetNum(name);
  const compDefPubkey = getCompDefAccAddress(MXE_PROGRAM_ID, offset);
  const rawCircuitPda = getRawCircuitPda(compDefPubkey);

  // Print full comp def account
  const compDef = await arciumProgram.account.computationDefinitionAccount.fetch(compDefPubkey);
  console.log("Full comp def:", JSON.stringify(compDef, (k, v) => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v) && v.length > 40) return `[${v.length} bytes: ${v.slice(0,8).join(',')}...]`;
    return v;
  }, 2));

  // Raw circuit account
  const rawAcc = await provider.connection.getAccountInfo(rawCircuitPda);
  if (!rawAcc) { console.log("no raw circuit acc"); return; }

  const onChainCircuit = rawAcc.data.subarray(9);
  const localCircuit = fs.readFileSync(`build/${name}.arcis`);

  console.log(`\nOn-chain raw circuit bytes: ${rawAcc.data.length} (9-byte header + ${onChainCircuit.length} circuit bytes)`);
  console.log(`Local .arcis file: ${localCircuit.length} bytes`);

  // Hash the on-chain circuit bytes (the actual circuit portion)
  const onChainCircuitData = onChainCircuit.subarray(0, localCircuit.length); // trim zero padding
  const onChainHash = crypto.createHash('sha256').update(onChainCircuitData).digest();
  const localHash = crypto.createHash('sha256').update(localCircuit).digest();
  console.log(`\nSHA256 of on-chain circuit: [${[...onChainHash].join(',')}]`);
  console.log(`SHA256 of local circuit:    [${[...localHash].join(',')}]`);
  console.log(`Hashes match: ${onChainHash.equals(localHash)}`);

  // First 16 bytes comparison
  console.log(`\nOn-chain first 16 bytes: ${Buffer.from(onChainCircuitData.subarray(0,16)).toString('hex')}`);
  console.log(`Local first 16 bytes:    ${Buffer.from(localCircuit.subarray(0,16)).toString('hex')}`);

  // Find first diff
  let firstDiff = -1;
  for (let i = 0; i < Math.min(onChainCircuitData.length, localCircuit.length); i++) {
    if (onChainCircuitData[i] !== localCircuit[i]) { firstDiff = i; break; }
  }
  console.log(`First byte difference at offset: ${firstDiff}`);
}

main().catch(console.error);
