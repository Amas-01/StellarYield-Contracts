// Test data builders (#1297).
//
// Existing tests repeat long object literals for users, positions and epochs.
// Defaults mirror the snake_case rows application code reads from PostgreSQL.
// Every builder returns a plain object that can be passed straight into a
// mocked `db.query` result and accepts partial overrides for the columns a
// test actually cares about.
import { buildUser, randomStellarAddress } from "./user.js";
import { buildPosition, randomStellarContractId, DEFAULT_CONTRACT_ID } from "./position.js";
import { buildEpoch, buildEpochs } from "./epoch.js";

export {
  buildUser,
  buildPosition,
  buildEpoch,
  buildEpochs,
  randomStellarAddress,
  randomStellarContractId,
  DEFAULT_CONTRACT_ID,
};
export type { UserRow } from "./user.js";
export type { PositionRow } from "./position.js";
export type { EpochRow } from "./epoch.js";
