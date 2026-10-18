import { query } from "../db/index.js";

/**
 * Current factory vault-WASM hash, sourced from the most recently recorded
 * `wasm_upd` event (#837). Returns null when no update event has been indexed
 * yet. Never falls back to an RPC call: the endpoint contract is DB-only.
 */
export async function getCurrentFactoryWasmHash(): Promise<string | null> {
  const rows = await query<{ new_hash: string }>(
    `SELECT new_hash
     FROM factory_wasm_history
     ORDER BY recorded_at DESC, id DESC
     LIMIT 1`,
  );

  return rows[0]?.new_hash ?? null;
}
