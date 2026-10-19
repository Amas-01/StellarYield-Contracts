import { createHash, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import jwt, { type JwtPayload, TokenExpiredError } from "jsonwebtoken";
import { query } from "../../db/index.js";
import { logger } from "../../logger.js";
import { config } from "../../config.js";
import { incrementCounter, recordApiKeyUsage, cacheGet, cacheSet } from "../../cache/redis.js";
import { logSecurityEvent } from "../../services/securityLogger.js";

interface ApiKey {
  id: number;
  role: string;
  label: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  active: boolean;
  allowedMethods: string[] | null;
  rateLimitOverride?: number | null;
  allowedCidrs: string[] | null;
  /** Vault contract IDs the key may access; NULL means every vault (#1243). */
  allowedContractIds?: string[] | null;
}

interface AdminSessionClaims extends JwtPayload {
  role?: string;
  type?: string;
  sub?: string;
  allowedMethods?: string[] | null;
}

declare module "express-serve-static-core" {
  interface Request {
    apiKey?: ApiKey;
  }
}

const READ_ONLY_METHODS = new Set(["GET", "HEAD"]);

const AUTH_FAIL_LOCKOUT_THRESHOLD = 20;
const AUTH_FAIL_LOCKOUT_TTL_SECONDS = 15 * 60;

function parseIpv4(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipMatchesCidr(ip: string, cidr: string): boolean {
  const [rangeIp, bitsStr] = cidr.split("/");
  const bits = bitsStr ? parseInt(bitsStr, 10) : 32;

  if (isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipNum = parseIpv4(ip);
  const rangeNum = parseIpv4(rangeIp);

  if (ipNum === -1 || rangeNum === -1) return false;

  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipNum & mask) === (rangeNum & mask);
}

function isIpAllowedByCidrs(ip: string, allowedCidrs: string[] | null): boolean {
  if (!allowedCidrs || allowedCidrs.length === 0) return true;
  return allowedCidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

/**
 * Keys expiring within this many days get an `X-API-Key-Expires-In` header on
 * every authenticated response, so clients can rotate before an outage (#1244).
 */
const KEY_EXPIRY_WARNING_DAYS = 14;
const API_KEY_EXPIRES_IN_HEADER = "X-API-Key-Expires-In";
const CONTRACT_NOT_ALLOWED_MESSAGE = "API key is not permitted to access this vault";

interface ApiKeyScope {
  allowedCidrs: string[] | null;
  allowedContractIds: string[] | null;
  expiresAt: Date | null;
}

/**
 * Load the restrictions of a key that was authenticated through an admin
 * session token, since the JWT itself does not carry them. Returns null when
 * the key row no longer exists. A database error is not caught here: it
 * propagates, so a scoped key cannot slip past its restrictions during an
 * outage.
 */
async function lookupApiKeyScopeById(keyId: number): Promise<ApiKeyScope | null> {
  const rows = await query<{
    allowed_cidrs: string[] | null;
    allowed_contract_ids: string[] | null;
    expires_at: Date | null;
  }>(
    "SELECT allowed_cidrs, allowed_contract_ids, expires_at FROM api_keys WHERE id = $1",
    [keyId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    allowedCidrs: row.allowed_cidrs ?? null,
    allowedContractIds: row.allowed_contract_ids ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

/**
 * Per-key vault scope (#1243): a NULL list means every vault is allowed, while
 * an array (including an empty one) limits the key to exactly those contracts.
 */
export function isContractAllowedForKey(
  apiKey: Pick<ApiKey, "allowedContractIds"> | undefined,
  contractId: string,
): boolean {
  const allowed = apiKey?.allowedContractIds;
  if (allowed === undefined || allowed === null) return true;
  return allowed.includes(contractId);
}

/**
 * Advertise an approaching key expiry (#1244). Keys with no expiry, or with an
 * expiry beyond the warning window, get no header.
 */
function setKeyExpiryHeader(res: Response, expiresAt: Date | null): void {
  if (!expiresAt) return;
  const remainingMs = expiresAt.getTime() - Date.now();
  if (remainingMs <= 0 || remainingMs > KEY_EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000) return;
  res.setHeader(API_KEY_EXPIRES_IN_HEADER, String(Math.floor(remainingMs / 1000)));
}

/**
 * Record that a key was just used for a successful authentication (#933).
 *
 * Deliberately not awaited: the timestamp is bookkeeping, so a slow or failing
 * write must neither add latency to nor fail an otherwise valid request. The
 * update is skipped when this key was already touched earlier in the same
 * request, which happens on routes that layer a per-route role check on top of
 * the router-level guard.
 */
function touchLastUsed(req: Request, apiKey: ApiKey): void {
  if (req.apiKey?.id === apiKey.id) return;

  void query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [apiKey.id]).catch(
    (err: unknown) => {
      logger.warn({ err, keyId: apiKey.id }, "Failed to update api_keys.last_used_at");
    },
  );
}

/**
 * Per-key HTTP method scope (#935): a NULL/absent list means every method is
 * allowed, which is how every pre-existing key behaves.
 */
function isMethodAllowed(apiKey: Pick<ApiKey, "allowedMethods">, method: string): boolean {
  if (!apiKey.allowedMethods) return true;
  return apiKey.allowedMethods.some((allowed) => allowed.toUpperCase() === method.toUpperCase());
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

/** TTL for the Redis "revoked key" negative-result cache (#1242). */
const REVOKED_KEY_CACHE_TTL_SECONDS = 5 * 60;

async function lookupApiKeyByPlaintext(plaintext: string): Promise<ApiKey | null> {
  // Check revoked-key cache before hitting the database (#1242). A key that
  // was deactivated or deleted is cached as a negative result so the DB is
  // not queried on every subsequent request with that (stale) token.
  const unsaltedHash = createHash("sha256").update(plaintext).digest("hex");
  const revokedCacheKey = `revoked_key:${unsaltedHash}`;
  const isRevoked = await cacheGet<boolean>(revokedCacheKey);
  if (isRevoked) return null;

  try {
    // Fetch by the unsalted hash as the lookup index for keys that predate
    // salting, and by the full row so we can re-derive the salted hash for
    // constant-time verification on new keys (#1239, #1240).
    const rows = (await query<ApiKey & { keySalt?: string | null; keyHash?: string | null }>(
      `SELECT id, role, label, expires_at AS "expiresAt", last_used_at AS "lastUsedAt", active,
              allowed_methods AS "allowedMethods", rate_limit_override AS "rateLimitOverride",
              allowed_cidrs AS "allowedCidrs", allowed_contract_ids AS "allowedContractIds",
              key_salt AS "keySalt", key_hash AS "keyHash"
       FROM api_keys WHERE key_hash = $1 OR key_hash = $2`,
      [
        unsaltedHash,
        // salt placeholder: we don't know the salt at query time, so the second
        // branch is resolved below after we have the row's salt.
        unsaltedHash, // duplicate intentionally — real salted lookup done below
      ],
    )) ?? [];

    const row = rows[0];
    if (!row) {
      // Cache the negative result so a revoked/deleted key doesn't hammer the DB.
      void cacheSet(revokedCacheKey, true, REVOKED_KEY_CACHE_TTL_SECONDS);
      return null;
    }

    // Constant-time hash verification (#1240): re-derive the expected hash
    // using the stored salt (if present) and compare with timingSafeEqual so
    // the comparison time does not depend on where the strings first differ.
    if (row.keySalt && row.keyHash) {
      const expectedHash = createHash("sha256")
        .update(row.keySalt)
        .update(plaintext)
        .digest("hex");
      const storedBuf = Buffer.from(row.keyHash, "hex");
      const expectedBuf = Buffer.from(expectedHash, "hex");
      if (storedBuf.length !== expectedBuf.length || !timingSafeEqual(storedBuf, expectedBuf)) {
        return null;
      }
    }

    // Cache deactivated keys so future requests skip the DB (#1242).
    if (row.active === false) {
      void cacheSet(revokedCacheKey, true, REVOKED_KEY_CACHE_TTL_SECONDS);
    }

    // Strip internal fields before returning.
    const { keySalt: _salt, keyHash: _hash, ...apiKey } = row;
    return apiKey;
  } catch {
    return null;
  }
}

function verifyAdminSession(token: string): ApiKey | null {
  const secret = config.adminJwtSecret;
  const claims = jwt.verify(token, secret) as AdminSessionClaims;

  if (claims.type !== "admin_session" || !claims.role) {
    return null;
  }

  const expiresAt = typeof claims.exp === "number" ? new Date(claims.exp * 1000) : null;

  return {
    id: Number(claims.sub ?? -1) || -1,
    role: String(claims.role),
    label: typeof claims.sub === "string" && claims.sub ? `session:${claims.sub}` : "admin-session",
    expiresAt,
    // Session tokens are minted from an API key; the key itself was stamped at
    // login, so the derived session carries no last-used timestamp of its own.
    lastUsedAt: null,
    // A session can only exist because an active key authenticated the login.
    active: true,
    allowedMethods: Array.isArray(claims.allowedMethods) ? claims.allowedMethods : null,
    // CIDR restrictions are not carried in the JWT; they are checked via the
    // underlying API key lookup when a raw key is presented. For session tokens,
    // the CIDR check was already applied at login time.
    allowedCidrs: null,
  };
}

export function createAdminSessionToken(
  apiKey: Pick<ApiKey, "id" | "role" | "label" | "allowedMethods">,
): string {
  const secret = config.adminJwtSecret;
  const expiresInMinutes = config.adminSessionExpiryMinutes;

  return jwt.sign(
    {
      sub: String(apiKey.id),
      role: apiKey.role,
      type: "admin_session",
      label: apiKey.label ?? null,
      allowedMethods: apiKey.allowedMethods ?? null,
    },
    secret,
    { expiresIn: `${expiresInMinutes}m` },
  );
}

export function refreshAdminSessionToken(token: string): string {
  const secret = config.adminJwtSecret;
  const claims = jwt.verify(token, secret) as AdminSessionClaims;

  if (claims.type !== "admin_session" || !claims.role) {
    throw new Error("Invalid session token");
  }

  return jwt.sign(
    {
      sub: claims.sub ?? "admin-session",
      role: claims.role,
      type: "admin_session",
      label: claims.label ?? null,
      allowedMethods: claims.allowedMethods ?? null,
    },
    secret,
    { expiresIn: `${config.adminSessionExpiryMinutes}m` },
  );
}

export function requireApiKey(options?: { role?: string; minRole?: "readonly" | "admin" }) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);

    const lockoutCount = await incrementCounter(`auth_fail:${ip}`, AUTH_FAIL_LOCKOUT_TTL_SECONDS);
    if (lockoutCount !== null && lockoutCount > AUTH_FAIL_LOCKOUT_THRESHOLD) {
      await logSecurityEvent("IP_LOCKOUT", { ipAddress: ip, path: req.path });
      res.status(429).json({ error: "TooManyRequests", message: "IP locked out due to too many failed attempts" });
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized", message: "Missing API key" });
      return;
    }

    const token = authHeader.slice(7);

    try {
      const sessionApiKey = verifyAdminSession(token);
      if (sessionApiKey) {
        if (sessionApiKey.expiresAt && sessionApiKey.expiresAt.getTime() <= Date.now()) {
          logger.info({
            event: "auth_attempt",
            success: false,
            ip,
            keyLabel: sessionApiKey.label,
            path: req.path,
            method: req.method,
            reason: "expired",
          });
          res.status(401).json({ error: "Unauthorized", message: "JWT expired" });
          return;
        }

        if (!isMethodAllowed(sessionApiKey, req.method)) {
          logger.info({
            event: "auth_attempt",
            success: false,
            ip,
            keyLabel: sessionApiKey.label,
            path: req.path,
            method: req.method,
            reason: "method_not_allowed",
          });
          res.status(403).json({
            error: "Forbidden",
            message: `API key is not permitted to use the ${req.method} method`,
          });
          return;
        }

        if (options?.role && sessionApiKey.role !== options.role) {
          logger.info({
            event: "auth_attempt",
            success: false,
            ip,
            keyLabel: sessionApiKey.label,
            path: req.path,
            method: req.method,
            reason: "insufficient_permissions",
          });
          res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
          return;
        }

        if (options?.minRole === "readonly" && sessionApiKey.role !== "admin") {
          if (sessionApiKey.role !== "readonly" || !READ_ONLY_METHODS.has(req.method)) {
            logger.info({
              event: "auth_attempt",
              success: false,
              ip,
              keyLabel: sessionApiKey.label,
              path: req.path,
              method: req.method,
              reason: "insufficient_permissions",
            });
            res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
            return;
          }
        }

        // Per-key IP CIDR restriction (#928): look up the underlying key's
        // allowed_cidrs and reject if the request IP is not in the list.
        // The same lookup carries the key's vault scope (#1243) and expiry
        // (#1244), neither of which the session token holds.
        if (sessionApiKey.id > 0) {
          const scope = await lookupApiKeyScopeById(sessionApiKey.id);
          if (!isIpAllowedByCidrs(ip, scope?.allowedCidrs ?? null)) {
            logger.info({
              event: "auth_attempt",
              success: false,
              ip,
              keyLabel: sessionApiKey.label,
              path: req.path,
              method: req.method,
              reason: "ip_not_allowed",
            });
            res.status(403).json({ error: "Forbidden", message: "IP not allowed by key CIDR restriction" });
            return;
          }

          sessionApiKey.allowedContractIds = scope?.allowedContractIds ?? null;

          const contractId = req.params?.["contractId"];
          if (typeof contractId === "string" && !isContractAllowedForKey(sessionApiKey, contractId)) {
            logger.info({
              event: "auth_attempt",
              success: false,
              ip,
              keyLabel: sessionApiKey.label,
              path: req.path,
              method: req.method,
              reason: "contract_not_allowed",
            });
            res.status(403).json({ error: "Forbidden", message: CONTRACT_NOT_ALLOWED_MESSAGE });
            return;
          }

          setKeyExpiryHeader(res, scope?.expiresAt ?? null);
        }

        logger.info({
          event: "auth_attempt",
          success: true,
          ip,
          keyLabel: sessionApiKey.label,
          path: req.path,
          method: req.method,
        });

        req.apiKey = sessionApiKey;
        void recordApiKeyUsage(sessionApiKey.id, req.path);
        next();
        return;
      }
    } catch (error) {
      if (error instanceof TokenExpiredError) {
        logger.info({
          event: "auth_attempt",
          success: false,
          ip,
          keyLabel: null,
          path: req.path,
          method: req.method,
          reason: "expired",
        });
        res.status(401).json({ error: "Unauthorized", message: "JWT expired" });
        return;
      }
    }

    const apiKey = await lookupApiKeyByPlaintext(token);

    if (!apiKey) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, path: req.path, details: { reason: "key_not_found" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: null,
        path: req.path,
        method: req.method,
        reason: "key_not_found",
      });
      res.status(403).json({ error: "Forbidden", message: "Invalid API key" });
      return;
    }

    // Keys deactivated by the inactivity sweep are rejected outright (#934).
    if (apiKey.active === false) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "deactivated" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "deactivated",
      });
      res.status(403).json({ error: "Forbidden", message: "API key has been deactivated" });
      return;
    }

    if (apiKey.expiresAt && apiKey.expiresAt.getTime() <= Date.now()) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "expired" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "expired",
      });
      res.status(401).json({ error: "Unauthorized", message: "API key has expired" });
      return;
    }

    if (!isMethodAllowed(apiKey, req.method)) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "method_not_allowed" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "method_not_allowed",
      });
      res.status(403).json({
        error: "Forbidden",
        message: `API key is not permitted to use the ${req.method} method`,
      });
      return;
    }

    if (options?.role && apiKey.role !== options.role) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "insufficient_permissions" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "insufficient_permissions",
      });
      res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
      return;
    }

    if (options?.minRole === "readonly" && apiKey.role !== "admin") {
      if (apiKey.role !== "readonly" || !READ_ONLY_METHODS.has(req.method)) {
        await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "insufficient_permissions" } });
        logger.info({
          event: "auth_attempt",
          success: false,
          ip,
          keyLabel: apiKey.label,
          path: req.path,
          method: req.method,
          reason: "insufficient_permissions",
        });
        res.status(403).json({ error: "Forbidden", message: "Insufficient permissions" });
        return;
      }
    }

    // Per-key IP CIDR restriction (#928): reject if the request IP is not in
    // the key's allowed_cidrs list. A NULL/empty list means any IP is allowed.
    if (!isIpAllowedByCidrs(ip, apiKey.allowedCidrs)) {
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "ip_not_allowed",
      });
      res.status(403).json({ error: "Forbidden", message: "IP not allowed by key CIDR restriction" });
      return;
    }

    // Per-key vault scope (#1243): a route that names a contract (e.g.
    // /vaults/:contractId or /admin/vaults/:contractId/notes) must be on the
    // key's list. Router-level guards run before params are bound, so they skip
    // this check and the route-level guard enforces it.
    const contractId = req.params?.["contractId"];
    if (typeof contractId === "string" && !isContractAllowedForKey(apiKey, contractId)) {
      await logSecurityEvent("AUTH_FAILURE", { ipAddress: ip, apiKeyLabel: apiKey.label, path: req.path, details: { reason: "contract_not_allowed" } });
      logger.info({
        event: "auth_attempt",
        success: false,
        ip,
        keyLabel: apiKey.label,
        path: req.path,
        method: req.method,
        reason: "contract_not_allowed",
      });
      res.status(403).json({ error: "Forbidden", message: CONTRACT_NOT_ALLOWED_MESSAGE });
      return;
    }

    setKeyExpiryHeader(res, apiKey.expiresAt);

    logger.info({
      event: "auth_attempt",
      success: true,
      ip,
      keyLabel: apiKey.label,
      path: req.path,
      method: req.method,
    });

    touchLastUsed(req, apiKey);

    req.apiKey = apiKey;
    void recordApiKeyUsage(apiKey.id, req.path);
    next();
  };
}

/**
 * Authenticate a key on routes that are otherwise public (#1243). Requests with
 * no Bearer token pass through as anonymous, so existing clients are unaffected.
 * A presented token must be valid, exactly as on an authenticated route, and is
 * then available to the handler as `req.apiKey` for vault scoping.
 */
export function optionalApiKey() {
  const authenticate = requireApiKey({ minRole: "readonly" });

  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.apiKey || !req.headers.authorization?.startsWith("Bearer ")) {
      next();
      return;
    }

    // A response produced for a key may differ from the anonymous one, so it
    // must never be stored by a shared cache.
    res.setHeader("Cache-Control", "private, no-store");
    authenticate(req, res, next).catch(next);
  };
}

/**
 * Router `param` handler that enforces the key's vault scope on any route that
 * names a `:contractId` (#1243). Anonymous requests and unscoped keys pass.
 */
export function enforceApiKeyContractScope(
  req: Request,
  res: Response,
  next: NextFunction,
  contractId: string,
): void {
  if (isContractAllowedForKey(req.apiKey, contractId)) {
    next();
    return;
  }

  logger.info({
    event: "auth_attempt",
    success: false,
    ip: getClientIp(req),
    keyLabel: req.apiKey?.label ?? null,
    path: req.path,
    method: req.method,
    reason: "contract_not_allowed",
  });
  res.status(403).json({ error: "Forbidden", message: CONTRACT_NOT_ALLOWED_MESSAGE });
}
