import { createHmac, randomBytes } from "node:crypto";
import { config } from "../config.js";

export const SIGNATURE_HEADER = "X-StellarYield-Signature";

/**
 * Secondary header carrying the signature computed with the *previous* secret
 * during a rotation window (#1062). Receivers can accept either secret until
 * the window closes.
 */
export const PREVIOUS_SIGNATURE_HEADER = "X-StellarYield-Signature-Previous";

/**
 * Length of the zero-downtime transition window in hours. Overridable with
 * `SECRET_ROTATION_WINDOW_HOURS`; defaults to 24.
 */
export function secretRotationWindowHours(): number {
  return config.secretRotationWindowHours;
}

/**
 * True while a rotated-out secret is still being signed with, i.e. the
 * transition window has not elapsed since `secret_rotated_at`.
 */
export function isWithinRotationWindow(
  rotatedAt: Date | string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!rotatedAt) return false;
  const rotated = rotatedAt instanceof Date ? rotatedAt : new Date(rotatedAt);
  if (Number.isNaN(rotated.getTime())) return false;
  const windowMs = secretRotationWindowHours() * 60 * 60 * 1000;
  return now.getTime() - rotated.getTime() < windowMs;
}

export interface SignableWebhook {
  secret: string | null;
  previous_secret?: string | null;
  secret_rotated_at?: Date | string | null;
}

function sign(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

/**
 * Builds the outbound signature headers for a delivery. During a secret
 * rotation window two headers are emitted — one per secret — so the receiver
 * can validate against whichever it still has configured. Outside the window
 * only the current secret is signed with.
 */
export function buildSignatureHeaders(
  webhook: SignableWebhook,
  payload: string,
  now: Date = new Date(),
): Record<string, string> {
  if (!webhook.secret) return {};

  const headers: Record<string, string> = { [SIGNATURE_HEADER]: sign(payload, webhook.secret) };

  if (webhook.previous_secret && isWithinRotationWindow(webhook.secret_rotated_at, now)) {
    headers[PREVIOUS_SIGNATURE_HEADER] = sign(payload, webhook.previous_secret);
  }

  return headers;
}

/** Cryptographically strong secret for a webhook endpoint (#1062). */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}
