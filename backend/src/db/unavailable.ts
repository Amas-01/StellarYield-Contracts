// Codes that mean the server is down, refusing, or dropped the connection.
const UNAVAILABLE_PG_CODES = new Set([
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "08007", // transaction_resolution_unknown
]);

const UNAVAILABLE_NET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
]);

// pg-pool reports these without a code, so the message is the only signal.
const UNAVAILABLE_MESSAGES = [
  "timeout exceeded when trying to connect",
  "Connection terminated",
];

const MAX_DEPTH = 3;

/**
 * True when the database could not be reached at all (server down, connection
 * refused or reset, pool could not open a connection). A query that ran and
 * failed is not unavailability. Decides between a stale copy and a 503 (#1254).
 */
export function isDatabaseUnavailableError(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > MAX_DEPTH) return false;
  const { code, message, errors } = err as { code?: unknown; message?: unknown; errors?: unknown };

  if (typeof code === "string" && (UNAVAILABLE_PG_CODES.has(code) || UNAVAILABLE_NET_CODES.has(code))) {
    return true;
  }
  if (typeof message === "string" && UNAVAILABLE_MESSAGES.some((text) => message.includes(text))) {
    return true;
  }
  // AggregateError from a connect attempt that tried several addresses.
  if (Array.isArray(errors)) {
    return errors.some((inner) => isDatabaseUnavailableError(inner, depth + 1));
  }
  return false;
}
