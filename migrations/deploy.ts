// Migrations run once on deployment.
// For Arcium programs, the actual initialization of computation definitions
// happens in the test suite / app frontend after the program is deployed.
module.exports = async function (_provider: unknown) {
  // No-op — see tests/private-voting.ts for initXxxCompDef calls.
};
