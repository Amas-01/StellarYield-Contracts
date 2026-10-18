import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({ query: vi.fn().mockResolvedValue([]) }));
vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("./stellar.js", () => ({ getSorobanRpc: vi.fn() }));
vi.mock("./vault.js", () => ({ VaultService: vi.fn().mockImplementation(() => ({})) }));
vi.mock("./user.js", () => ({
  UserService: vi.fn().mockImplementation(() => ({
    upsertUser: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("./notifications.js", () => ({ NotificationService: vi.fn().mockImplementation(() => ({})) }));

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import {
  Indexer,
  parseVaultManagerChangedEvent,
  parseVaultStatusChangedEvent,
} from "./indexer.js";
import { query } from "../db/index.js";
import type { NotificationService } from "./notifications.js";
import { TOPIC_EVENT_TYPES } from "./indexerEventTypes.js";
import { isKnownEvent } from "./notificationEvents.js";

const FACTORY_CONTRACT = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";
const VAULT_CONTRACT = "CAUZE223Z3225XAS6DTIAV3ZCK4SD3XSKURGALZJNSCW7CW5QYEHF557";
const OLD_MANAGER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const NEW_MANAGER = "GCRQ4LWKNNGKY2DGPY2QDDMZ5BFCNG2EHJNQ4HF2BMTF2WZT5HF2BMTF2WZ";
const CLOSED_AT = "2026-09-01T12:00:00.000Z";

function statusEvent(payload: xdr.ScVal, topics: xdr.ScVal[] = [nativeToScVal("v_status"), nativeToScVal(VAULT_CONTRACT)]) {
  return {
    id: "evt-status",
    contractId: FACTORY_CONTRACT,
    type: "contract",
    ledger: 5100,
    txHash: "status-tx",
    ledgerClosedAt: CLOSED_AT,
    topic: topics,
    value: payload,
  };
}

function managerEvent(payload: xdr.ScVal, topics: xdr.ScVal[] = [nativeToScVal("vault_manager_changed")]) {
  return {
    id: "evt-manager",
    contractId: VAULT_CONTRACT,
    type: "contract",
    ledger: 5200,
    txHash: "manager-tx",
    ledgerClosedAt: CLOSED_AT,
    topic: topics,
    value: payload,
  };
}

describe("parseVaultStatusChangedEvent (#1065)", () => {
  it("parses the factory's v_status event with the vault in the topics", () => {
    expect(parseVaultStatusChangedEvent(statusEvent(nativeToScVal(false)))).toEqual({
      vault: VAULT_CONTRACT,
      status: "inactive",
    });
    expect(parseVaultStatusChangedEvent(statusEvent(nativeToScVal(true)))?.status).toBe("active");
  });

  it("accepts the long event name and a string status", () => {
    const parsed = parseVaultStatusChangedEvent(
      statusEvent(nativeToScVal("Inactive"), [nativeToScVal("vault_status_changed"), nativeToScVal(VAULT_CONTRACT)]),
    );
    expect(parsed).toEqual({ vault: VAULT_CONTRACT, status: "inactive" });
  });

  it("falls back to the emitting contract when no vault topic is present", () => {
    const parsed = parseVaultStatusChangedEvent(statusEvent(nativeToScVal(true), [nativeToScVal("v_status")]));
    expect(parsed?.vault).toBe(FACTORY_CONTRACT);
  });

  it("returns null for other or malformed events", () => {
    expect(parseVaultStatusChangedEvent(statusEvent(nativeToScVal(true), [nativeToScVal("deposit")]))).toBeNull();
    expect(parseVaultStatusChangedEvent(statusEvent(nativeToScVal(42)))).toBeNull();
    expect(parseVaultStatusChangedEvent(null)).toBeNull();
    expect(parseVaultStatusChangedEvent({})).toBeNull();
  });
});

describe("parseVaultManagerChangedEvent (#1068)", () => {
  it("parses an (old, new) tuple emitted by the vault", () => {
    expect(parseVaultManagerChangedEvent(managerEvent(nativeToScVal([OLD_MANAGER, NEW_MANAGER])))).toEqual({
      vault: VAULT_CONTRACT,
      oldManager: OLD_MANAGER,
      newManager: NEW_MANAGER,
    });
  });

  it("parses a struct payload", () => {
    const parsed = parseVaultManagerChangedEvent(
      managerEvent(nativeToScVal({ new_manager: NEW_MANAGER, old_manager: OLD_MANAGER })),
    );
    expect(parsed).toEqual({ vault: VAULT_CONTRACT, oldManager: OLD_MANAGER, newManager: NEW_MANAGER });
  });

  it("parses a bare new-manager payload", () => {
    const parsed = parseVaultManagerChangedEvent(managerEvent(nativeToScVal(NEW_MANAGER), [nativeToScVal("mgr_chg")]));
    expect(parsed).toEqual({ vault: VAULT_CONTRACT, oldManager: null, newManager: NEW_MANAGER });
  });

  it("reads the vault from topics when a factory emits the event", () => {
    const event = {
      ...managerEvent(nativeToScVal([OLD_MANAGER, NEW_MANAGER]), [
        nativeToScVal("vault_manager_changed"),
        nativeToScVal(VAULT_CONTRACT),
      ]),
      contractId: FACTORY_CONTRACT,
    };
    expect(parseVaultManagerChangedEvent(event)?.vault).toBe(VAULT_CONTRACT);
  });

  it("returns null for other or malformed events", () => {
    expect(parseVaultManagerChangedEvent(managerEvent(nativeToScVal(NEW_MANAGER), [nativeToScVal("deposit")]))).toBeNull();
    expect(parseVaultManagerChangedEvent(managerEvent(nativeToScVal(42)))).toBeNull();
    expect(parseVaultManagerChangedEvent(null)).toBeNull();
  });
});

describe("vault status / manager indexing (#1065, #1068)", () => {
  const mockQuery = query as ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;
  let indexer: Indexer;

  beforeEach(() => {
    vi.clearAllMocks();
    mockQuery.mockResolvedValue([]);
    notify = vi.fn().mockResolvedValue(undefined);
    indexer = new Indexer({ notify, processRetries: vi.fn() } as unknown as NotificationService);
  });

  function callsMatching(fragment: string) {
    return mockQuery.mock.calls.filter(([sql]) => String(sql).includes(fragment));
  }

  it("updates vaults.status and writes a history row for each status transition", async () => {
    mockQuery.mockImplementation((sql: string) =>
      sql.includes("SELECT status FROM vaults") ? Promise.resolve([{ status: "active" }]) : Promise.resolve([]),
    );

    await indexer.processEvent(statusEvent(nativeToScVal(false)));

    const update = callsMatching("UPDATE vaults SET status");
    expect(update[0]?.[1]).toEqual(["inactive", VAULT_CONTRACT]);

    const insert = callsMatching("INSERT INTO vault_status_history");
    expect(insert).toHaveLength(1);
    expect(insert[0][0]).toContain("'status_changed'");
    expect(insert[0][0]).toContain("ON CONFLICT (contract_id, event_type, tx_hash, ledger) DO NOTHING");
    expect(insert[0][1]).toEqual([VAULT_CONTRACT, "active", "inactive", new Date(CLOSED_AT), "status-tx", 5100]);

    expect(callsMatching("INSERT INTO indexed_events")[0]?.[1]?.[3]).toBe("vault_status_changed");
  });

  it("records a transition for a vault that is not indexed yet", async () => {
    await indexer.processEvent(statusEvent(nativeToScVal(true)));

    const insert = callsMatching("INSERT INTO vault_status_history");
    expect(insert[0][1]).toEqual([VAULT_CONTRACT, null, "active", new Date(CLOSED_AT), "status-tx", 5100]);
  });

  it("updates vaults.manager_address, writes a history row and fires vault.manager_changed", async () => {
    await indexer.processEvent(managerEvent(nativeToScVal([OLD_MANAGER, NEW_MANAGER])));

    expect(callsMatching("UPDATE vaults SET manager_address")[0]?.[1]).toEqual([NEW_MANAGER, VAULT_CONTRACT]);

    const insert = callsMatching("INSERT INTO vault_status_history");
    expect(insert).toHaveLength(1);
    expect(insert[0][0]).toContain("'manager_changed'");
    expect(insert[0][1]).toEqual([VAULT_CONTRACT, OLD_MANAGER, NEW_MANAGER, new Date(CLOSED_AT), "manager-tx", 5200]);

    expect(notify).toHaveBeenCalledWith("vault.manager_changed", {
      contractId: VAULT_CONTRACT,
      previousManager: OLD_MANAGER,
      newManager: NEW_MANAGER,
      txHash: "manager-tx",
      ledger: 5200,
    });
  });

  it("falls back to the stored manager when the event omits the previous one", async () => {
    mockQuery.mockImplementation((sql: string) =>
      sql.includes("SELECT manager_address FROM vaults")
        ? Promise.resolve([{ manager_address: OLD_MANAGER }])
        : Promise.resolve([]),
    );

    await indexer.processEvent(managerEvent(nativeToScVal(NEW_MANAGER)));

    expect(callsMatching("INSERT INTO vault_status_history")[0][1][1]).toBe(OLD_MANAGER);
    expect(notify).toHaveBeenCalledWith("vault.manager_changed", expect.objectContaining({ previousManager: OLD_MANAGER }));
  });

  it("registers the event types for the indexer filter and webhook subscriptions", () => {
    expect(TOPIC_EVENT_TYPES["v_status"]).toBe("vault_status_changed");
    expect(TOPIC_EVENT_TYPES["mgr_chg"]).toBe("vault_manager_changed");
    expect(isKnownEvent("vault.manager_changed")).toBe(true);
  });
});
