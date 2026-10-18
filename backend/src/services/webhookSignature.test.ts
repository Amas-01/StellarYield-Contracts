import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  buildSignatureHeaders,
  generateWebhookSecret,
  isWithinRotationWindow,
  secretRotationWindowHours,
  PREVIOUS_SIGNATURE_HEADER,
  SIGNATURE_HEADER,
} from "./webhookSignature.js";

const PAYLOAD = '{"event":"deposit"}';

function hmac(secret: string, payload = PAYLOAD): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("secret rotation window (#1062)", () => {
  it("defaults to 24 hours", () => {
    expect(secretRotationWindowHours()).toBe(24);
  });

  it("treats a rotation inside the window as pending", () => {
    const rotatedAt = new Date(Date.now() - 60 * 60 * 1000);
    expect(isWithinRotationWindow(rotatedAt)).toBe(true);
  });

  it("treats a rotation past the window as expired", () => {
    const rotatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
    expect(isWithinRotationWindow(rotatedAt)).toBe(false);
  });

  it("is never pending without a rotation timestamp", () => {
    expect(isWithinRotationWindow(null)).toBe(false);
    expect(isWithinRotationWindow(undefined)).toBe(false);
  });

  it("emits both signatures during the transition window", () => {
    const headers = buildSignatureHeaders(
      {
        secret: "new-secret",
        previous_secret: "old-secret",
        secret_rotated_at: new Date(Date.now() - 60 * 60 * 1000),
      },
      PAYLOAD,
    );

    expect(headers[SIGNATURE_HEADER]).toBe(hmac("new-secret"));
    expect(headers[PREVIOUS_SIGNATURE_HEADER]).toBe(hmac("old-secret"));
  });

  it("emits only the current signature after the window closes", () => {
    const headers = buildSignatureHeaders(
      {
        secret: "new-secret",
        previous_secret: "old-secret",
        secret_rotated_at: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
      PAYLOAD,
    );

    expect(headers[SIGNATURE_HEADER]).toBe(hmac("new-secret"));
    expect(headers[PREVIOUS_SIGNATURE_HEADER]).toBeUndefined();
  });

  it("emits a single signature when no rotation has happened", () => {
    const headers = buildSignatureHeaders({ secret: "only-secret", previous_secret: null }, PAYLOAD);
    expect(headers).toEqual({ [SIGNATURE_HEADER]: hmac("only-secret") });
  });

  it("emits no signature headers for an endpoint without a secret", () => {
    expect(buildSignatureHeaders({ secret: null }, PAYLOAD)).toEqual({});
  });

  it("generates distinct 256-bit secrets", () => {
    const a = generateWebhookSecret();
    const b = generateWebhookSecret();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
