import { describe, it, expect } from "vitest";
import { validateWebhookUrlSsrf } from "./ssrfProtection.js";

describe("ssrfProtection", () => {
  describe("validateWebhookUrlSsrf", () => {
    it("rejects loopback addresses", async () => {
      await expect(validateWebhookUrlSsrf("http://localhost/webhook")).rejects.toThrow("not allowed");
      await expect(validateWebhookUrlSsrf("http://127.0.0.1/webhook")).rejects.toThrow("private");
    });

    it("rejects cloud metadata endpoints", async () => {
      await expect(validateWebhookUrlSsrf("http://169.254.169.254/")).rejects.toThrow("not allowed");
      await expect(validateWebhookUrlSsrf("http://metadata.google.internal/")).rejects.toThrow("not allowed");
      await expect(validateWebhookUrlSsrf("http://100.100.100.200/")).rejects.toThrow("not allowed");
    });

    it("rejects RFC 1918 private ranges", async () => {
      await expect(validateWebhookUrlSsrf("http://10.0.0.1/webhook")).rejects.toThrow("private");
      await expect(validateWebhookUrlSsrf("http://192.168.1.1/webhook")).rejects.toThrow("private");
      await expect(validateWebhookUrlSsrf("http://172.16.0.1/webhook")).rejects.toThrow("private");
      await expect(validateWebhookUrlSsrf("http://172.31.255.255/webhook")).rejects.toThrow("private");
    });

    it("rejects link-local addresses", async () => {
      await expect(validateWebhookUrlSsrf("http://169.254.1.1/webhook")).rejects.toThrow("private");
    });

    it("rejects IPv6 loopback", async () => {
      await expect(validateWebhookUrlSsrf("http://[::1]/webhook")).rejects.toThrow("private");
    });

    it("rejects IPv6 link-local", async () => {
      await expect(validateWebhookUrlSsrf("http://[fe80::1]/webhook")).rejects.toThrow("private");
    });

    it("rejects IPv6 unique local", async () => {
      await expect(validateWebhookUrlSsrf("http://[fc00::1]/webhook")).rejects.toThrow("private");
      await expect(validateWebhookUrlSsrf("http://[fd00::1]/webhook")).rejects.toThrow("private");
    });

    it("rejects invalid URLs", async () => {
      await expect(validateWebhookUrlSsrf("not a url")).rejects.toThrow("Invalid URL");
    });

    it("rejects unresolvable hostnames", async () => {
      await expect(validateWebhookUrlSsrf("http://invalid-domain-12345.example.com/")).rejects.toThrow(
        "resolve",
      );
    });

    it("accepts valid public URLs", async () => {
      await expect(validateWebhookUrlSsrf("https://example.com/webhook")).resolves.toBeUndefined();
      await expect(validateWebhookUrlSsrf("https://api.github.com/webhook")).resolves.toBeUndefined();
    });
  });
});
