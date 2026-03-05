import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  getArciumProgram,
  getMXEAccAddress,
  getClusterAccAddress,
  getArciumEnv,
} from "@arcium-hq/client";

anchor.setProvider(anchor.AnchorProvider.env());
const provider = anchor.getProvider() as anchor.AnchorProvider;
const arciumProgram = getArciumProgram(provider);
const arciumEnv = getArciumEnv();

const MXE_PROGRAM_ID = new PublicKey("CqUikXpnsHgymR3yN61YYzwj8vH82b7zyJSKaDwvVWED");

async function main() {
  const mxeAddress = getMXEAccAddress(MXE_PROGRAM_ID);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAddress);
  console.log("MXE Account:");
  console.log("  address:", mxeAddress.toBase58());
  console.log("  cluster:", JSON.stringify(mxeAcc.cluster));
  console.log("  lutOffsetSlot:", mxeAcc.lutOffsetSlot?.toString());
  console.log("  full:", JSON.stringify(mxeAcc, null, 2));

  if (mxeAcc.cluster !== null) {
    const clusterAddr = getClusterAccAddress(arciumEnv.arciumClusterOffset);
    console.log("\nCluster Account:");
    console.log("  address:", clusterAddr.toBase58());
    try {
      const clusterAcc = await arciumProgram.account.cluster.fetch(clusterAddr);
      console.log("  blsPublicKey:", JSON.stringify((clusterAcc as any).blsPublicKey));
      console.log("  arxNodeCount:", (clusterAcc as any).arxNodes?.length ?? "N/A");
      console.log("  recoverySetSize:", (clusterAcc as any).recoverySetSize ?? "N/A");
      console.log("  full:", JSON.stringify(clusterAcc, (key, val) => {
        if (Array.isArray(val) && val.length > 10) return `[${val.length} bytes]`;
        return val;
      }, 2));
    } catch (e: any) {
      console.log("  fetch error:", e.message);
    }
  }
}
main().catch(console.error);
