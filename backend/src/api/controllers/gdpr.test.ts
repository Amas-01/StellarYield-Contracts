import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  clientQuery: vi.fn(),
}));

vi.mock("../../db/index.js", () => ({
  query: mocks.query,
  pool: { connect: mocks.connect },
}));

async function getTestContext() {
  const { deleteUserGdprData, exportUserGdprData } = await import("./gdpr.js");
  return {
    query: mocks.query,
    exportUserGdprData,
    deleteUserGdprData,
  };
}

function makeRes() {
  return { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as any;
}

function makeReq(params: Record<string, string>, query: Record<string, string> = {}) {
  return { params, query, body: {}, headers: {} } as any;
}

const USER = "G" + "A".repeat(55);
const subject = {
  id: 1,
  address: USER,
  kyc_verified: true,
  aml_flagged: false,
  aml_flagged_at: null,
  created_at: new Date("2026-01-01T00:00:00.000Z"),
  updated_at: new Date("2026-09-01T00:00:00.000Z"),
};

/** A client whose statements all report `rowCount` rows touched. */
function fakeClient(rowCounts: number[] = []) {
  let call = 0;
  mocks.clientQuery.mockImplementation(async () => ({ rowCount: rowCounts[call++] ?? 0 }));
  mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
}

/** Whitespace-normalised statements, so multi-line SQL can be asserted on. */
const statements = () =>
  mocks.clientQuery.mock.calls.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());

describe("GDPR data export (#1110)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns a portable JSON document with every data category and its record count", async () => {
    const { query, exportUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([
      { contract_id: "CV1", shares: "10", deposited: "100", last_claimed_epoch: 3, first_entry_at: null, last_exit_at: null, updated_at: new Date() },
    ]);
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([]);
    query.mockResolvedValueOnce([
      { id: 7, ledger: 42, tx_hash: "abc", contract_id: "CV1", event_type: "yield_claimed", payload: { user: USER }, created_at: new Date() },
    ]);
    query.mockResolvedValueOnce([]);
    const res = makeRes();

    await exportUserGdprData(makeReq({ address: USER }), res, vi.fn());

    expect(res.status).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.format).toBe("gdpr-data-export");
    expect(body.version).toBe(1);
    expect(body.subject).toEqual(
      expect.objectContaining({ address: USER, kycVerified: true, amlFlagged: false }),
    );
    expect(body.recordCounts).toEqual({
      positions: 1,
      shareBalanceSnapshots: 0,
      redemptionRequests: 0,
      notificationPreferences: 0,
      vaultRoles: 0,
      feeRebates: 0,
      blacklistedAddresses: 0,
      events: 1,
      archivedEvents: 0,
    });
    expect(body.data.positions[0]).toEqual(
      expect.objectContaining({ contractId: "CV1", shares: "10", lastClaimedEpoch: 3 }),
    );
    expect(body.data.events[0]).toEqual(expect.objectContaining({ eventType: "yield_claimed" }));
  });

  it("queries every user-linked table with the subject address", async () => {
    const { query, exportUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    for (let i = 0; i < 9; i += 1) query.mockResolvedValueOnce([]);

    await exportUserGdprData(makeReq({ address: USER }), makeRes(), vi.fn());

    const sqls = query.mock.calls.slice(1).map(([sql]) => String(sql));
    expect(sqls.some((sql) => sql.includes("FROM user_vault_positions"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM share_balance_snapshots"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM redemption_requests"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM user_notification_preferences"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM vault_roles"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM fee_rebates"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM vault_blacklisted_addresses"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("FROM indexed_events_archive"))).toBe(true);
    // The nine data queries, all bound to the subject address.
    for (const [, params] of query.mock.calls.slice(1, 10)) {
      expect(params).toEqual([USER]);
    }
  });

  it("audits the export", async () => {
    const { query, exportUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    for (let i = 0; i < 9; i += 1) query.mockResolvedValueOnce([]);

    await exportUserGdprData(makeReq({ address: USER }), makeRes(), vi.fn());

    const auditSql: string = query.mock.calls.at(-1)![0];
    expect(auditSql).toContain("INSERT INTO admin_audit_log");
    expect(query.mock.calls.at(-1)![1]).toContain("gdpr_export");
  });

  it("404s for an unknown address and 400s for a malformed one", async () => {
    const { query, exportUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([]);
    const notFound = makeRes();
    await exportUserGdprData(makeReq({ address: USER }), notFound, vi.fn());
    expect(notFound.status).toHaveBeenCalledWith(404);

    const next = vi.fn();
    await exportUserGdprData(makeReq({ address: "not-an-address" }), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
  });
});

describe("GDPR data deletion (#1111)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("previews the plan without writing when ?dryRun=true", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([
      {
        // Column names as `loadErasurePlan` receives them: the SQL aliases are
        // quoted so Postgres hands them back camelCased.
        positions: 3,
        shareBalanceSnapshots: 12,
        redemptionRequests: 1,
        notificationPreferences: 4,
        vaultRoles: 1,
        feeRebates: 0,
        blacklistedAddresses: 0,
        events: 5,
        archivedEvents: 2,
      },
    ]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }, { dryRun: "true" }), res, vi.fn());

    expect(res.json).toHaveBeenCalledWith({
      address: USER,
      mode: "dry-run",
      erased: { profile: 1, notificationPreferences: 4, blacklistedAddresses: 0 },
      anonymized: {
        positions: 3,
        shareBalanceSnapshots: 12,
        redemptionRequests: 1,
        vaultRoles: 1,
        feeRebates: 0,
        events: 5,
        archivedEvents: 2,
      },
    });
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("keeps the plan counts camelCased so Postgres cannot fold the aliases", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }, { dryRun: "true" }), res, vi.fn());

    // An unquoted `AS share_balance_snapshots` comes back lower-cased, which
    // silently drops six of the nine counts from the plan.
    const planSql = String(query.mock.calls[1][0]);
    for (const alias of [
      "shareBalanceSnapshots",
      "redemptionRequests",
      "notificationPreferences",
      "vaultRoles",
      "feeRebates",
      "blacklistedAddresses",
      "archivedEvents",
    ]) {
      expect(planSql).toContain(`AS "${alias}"`);
    }
  });

  it("refuses to erase without an explicit confirmation", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json.mock.calls[0][0].message).toContain("?confirm=true");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("never treats ?confirm=false as a confirmation", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }, { confirm: "false" }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(400);
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("erases consent data, anonymises financial records and redacts events in one transaction", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([]);
    // BEGIN, 9 erasure statements, DELETE users, COMMIT
    fakeClient([0, 4, 0, 3, 12, 1, 1, 0, 5, 2, 1, 0]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }, { confirm: "true" }), res, vi.fn());

    const sqls = statements();
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls.at(-1)).toBe("COMMIT");
    expect(sqls).toContain("DELETE FROM user_notification_preferences WHERE user_address = $1");
    expect(sqls).toContain("DELETE FROM vault_blacklisted_addresses WHERE address = $1");
    expect(sqls).toContain("UPDATE user_vault_positions SET user_address = $1 WHERE user_address = $2");
    expect(sqls).toContain("UPDATE fee_rebates SET address = $1 WHERE address = $2");
    expect(sqls).toContain("DELETE FROM users WHERE address = $1");
    // Event payloads are redacted in both the live and the archived table.
    expect(sqls.some((sql) => sql.includes("UPDATE indexed_events SET payload"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("UPDATE indexed_events_archive SET payload"))).toBe(true);
    for (const sql of sqls.filter((s) => s.startsWith("UPDATE indexed_events"))) {
      expect(sql).toContain("'{user}'");
      expect(sql).toContain("'{address}'");
    }
    // Every write binds the redaction placeholder, never string interpolation.
    const writes = mocks.clientQuery.mock.calls.filter(([sql]) =>
      /^(DELETE|UPDATE)\b/i.test(String(sql)),
    );
    for (const [sql, params] of writes) {
      const bound = params as unknown[];
      expect(bound.at(-1)).toBe(USER);
      // Postgres rejects a bind message carrying more parameters than the
      // statement references, so each statement must bind exactly its own.
      const placeholders = new Set(String(sql).match(/\$\d+/g) ?? []);
      expect(bound).toHaveLength(placeholders.size);
    }
    expect(mocks.release).toHaveBeenCalled();

    const body = res.json.mock.calls[0][0];
    expect(body.mode).toBe("applied");
    expect(body.address).toBe(USER);
    expect(body.erased).toEqual({ profile: 1, notificationPreferences: 4, blacklistedAddresses: 0 });
    expect(body.anonymized).toEqual({
      positions: 3,
      shareBalanceSnapshots: 12,
      redemptionRequests: 1,
      vaultRoles: 1,
      feeRebates: 0,
      events: 5,
      archivedEvents: 2,
    });
    expect(body.retentionNote).toContain("anonymised");
    expect(query.mock.calls.at(-1)![1]).toContain("gdpr_erasure");
  });

  it("rolls back and forwards the error when a statement fails", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([subject]);
    query.mockResolvedValueOnce([]);
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "ROLLBACK") return { rowCount: 0 };
      throw new Error("deadlock detected");
    });
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    const next = vi.fn();

    await deleteUserGdprData(makeReq({ address: USER }, { confirm: "true" }), makeRes(), next);

    expect(statements()).toContain("ROLLBACK");
    expect(mocks.release).toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "deadlock detected" }));
  });

  it("blocks erasure while the subject is under an AML hold", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([
      { ...subject, aml_flagged: true, aml_flagged_at: new Date("2026-09-20T00:00:00.000Z") },
    ]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }, { confirm: "true" }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].message).toContain("AML hold");
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("404s for an unknown address", async () => {
    const { query, deleteUserGdprData } = await getTestContext();
    query.mockResolvedValueOnce([]);
    const res = makeRes();

    await deleteUserGdprData(makeReq({ address: USER }, { confirm: "true" }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(404);
    expect(mocks.connect).not.toHaveBeenCalled();
  });
});
