import { getCompDefAccOffset } from "@arcium-hq/client";

for (const name of ["zero_tally", "add_vote", "reveal_tally"]) {
  const offset = Buffer.from(getCompDefAccOffset(name)).readUInt32LE();
  console.log(`${name}: offset = ${offset}`);
}
