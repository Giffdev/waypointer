import { describe, expect, it, vi } from "vitest";
import {
  AIRPORT_RELEASE_MUTABLE_RELATIONS,
  AIRPORT_RELEASE_ROLLBACK_RELATIONS,
  airportReleaseRelationFingerprintQuery,
  assertAirportRollbackEligible,
  fingerprintAirportReleaseRelation,
  type AirportReleaseStateFingerprint,
} from "./airport-release-rollback";
import {
  canonicalJson,
  sha256Bytes,
} from "./airport-release-provenance";
import {
  AIRPORT_ROLLBACK_CONFIRMATION_PREFIX,
  type AirportReleaseTarget,
} from "./airport-release-safety";

const approvalSha256 = "a".repeat(64);
const evidenceSha256 = "b".repeat(64);
const candidateManifestSha256 = "c".repeat(64);
const targetFingerprint = "d".repeat(64);
const migration = {
  boundary: "0014" as const,
  appliedCount: 16,
  ledgerSha256: "e".repeat(64),
  schemaSha256: "f".repeat(64),
  migrationManifestSha256: "1".repeat(64),
};
const emptyRelation = {
  present: true,
  count: 0,
  sha256: "0".repeat(64),
};

function stateWithRelations(
  relations: AirportReleaseStateFingerprint["relations"],
): AirportReleaseStateFingerprint {
  const stateCore = {
    schemaVersion: 4 as const,
    migration,
    relations,
  };
  return {
    ...stateCore,
    stateSha256: sha256Bytes(canonicalJson(stateCore)),
  };
}

const preChangeState = stateWithRelations(
  Object.fromEntries(
    AIRPORT_RELEASE_ROLLBACK_RELATIONS.map((relation) => [
      relation,
      emptyRelation,
    ]),
  ) as AirportReleaseStateFingerprint["relations"],
);

function targetForState(
  state: AirportReleaseStateFingerprint,
): AirportReleaseTarget {
  return {
    fingerprint: targetFingerprint,
    candidateManifestSha256,
    approvalSha256,
    approval: {
      snapshot: {
        id: "snapshot-1",
        preChangeStateSha256: state.stateSha256,
        restoreProcedure: {
          stopConditions: [
            "database-release-post-commit-health-failed",
            "deployment-attestation-mismatch",
            "evidence-persistence-failed",
            "promotion-health-failed",
          ],
        },
      },
    },
  } as unknown as AirportReleaseTarget;
}

function evidenceForState(state: AirportReleaseStateFingerprint) {
  return {
    status: "database-release-passed",
    candidate: { manifestSha256: candidateManifestSha256 },
    target: {
      fingerprint: targetFingerprint,
      approvalSha256,
    },
    snapshot: {
      id: "snapshot-1",
      preChangeState: state,
    },
  };
}

const target = targetForState(preChangeState);
const evidence = evidenceForState(preChangeState);

describe("airport rollback eligibility", () => {
  it("pins the complete mutable-table inventory", () => {
    expect(AIRPORT_RELEASE_MUTABLE_RELATIONS).toEqual([
      "airports",
      "airport_aliases",
    ]);
    expect(AIRPORT_RELEASE_ROLLBACK_RELATIONS).toEqual([
      "airports",
      "airport_aliases",
      "drizzle_migrations",
    ]);
  });

  it("fingerprints each relation with one bounded server-side aggregate", async () => {
    const sql = {
      unsafe: vi
        .fn()
        .mockResolvedValueOnce([{ present: true }])
        .mockResolvedValueOnce([
          {
            row_count: "85836",
            row_fingerprint: "a".repeat(64),
          },
        ]),
    };

    await expect(
      fingerprintAirportReleaseRelation(sql, "airports"),
    ).resolves.toEqual({
      present: true,
      count: 85_836,
      sha256: "a".repeat(64),
    });
    const query = airportReleaseRelationFingerprintQuery("airports");
    expect(query).toContain("count(*)::text as row_count");
    expect(query).toContain("string_agg(");
    expect(query).toContain("sha256(");
    expect(query).toContain("from public.airports value");
    expect(query).not.toContain("select to_jsonb(value) as value");
    expect(sql.unsafe).toHaveBeenNthCalledWith(2, query);
  });

  it("requires an approved stop condition and exact operator confirmation", () => {
    expect(
      assertAirportRollbackEligible(
        target,
        evidence,
        evidenceSha256,
        "promotion-health-failed",
        `${AIRPORT_ROLLBACK_CONFIRMATION_PREFIX}${approvalSha256}:${evidenceSha256}`,
      ),
    ).toEqual(preChangeState);

    expect(() =>
      assertAirportRollbackEligible(
        target,
        evidence,
        evidenceSha256,
        "promotion-health-failed",
        "rollback",
      ),
    ).toThrow(
      expect.objectContaining({ diagnosticCode: "rollback-not-eligible" }),
    );
  });

  it("rejects incomplete or expanded relation inventories even with matching state hashes", () => {
    const invalidRelations = [
      Object.fromEntries(
        Object.entries(preChangeState.relations).filter(
          ([relation]) => relation !== "airport_aliases",
        ),
      ),
      Object.fromEntries(
        Object.entries(preChangeState.relations).filter(
          ([relation]) => relation !== "drizzle_migrations",
        ),
      ),
      {
        ...preChangeState.relations,
        future_mutable_table: emptyRelation,
      },
    ];

    for (const relations of invalidRelations) {
      const invalidState = stateWithRelations(
        relations as AirportReleaseStateFingerprint["relations"],
      );
      expect(() =>
        assertAirportRollbackEligible(
          targetForState(invalidState),
          evidenceForState(invalidState),
          evidenceSha256,
          "promotion-health-failed",
          `${AIRPORT_ROLLBACK_CONFIRMATION_PREFIX}${approvalSha256}:${evidenceSha256}`,
        ),
      ).toThrow(
        expect.objectContaining({
          diagnosticCode: "rollback-not-eligible",
        }),
      );
    }
  });

  it("refuses a different candidate, target, snapshot, or state", () => {
    for (const invalid of [
      { ...evidence, candidate: { manifestSha256: "0".repeat(64) } },
      { ...evidence, target: { ...evidence.target, fingerprint: "0".repeat(64) } },
      { ...evidence, snapshot: { ...evidence.snapshot, id: "other" } },
      {
        ...evidence,
        snapshot: {
          ...evidence.snapshot,
          preChangeState: {
            ...preChangeState,
            stateSha256: "0".repeat(64),
          },
        },
      },
    ]) {
      expect(() =>
        assertAirportRollbackEligible(
          target,
          invalid,
          evidenceSha256,
          "promotion-health-failed",
          `${AIRPORT_ROLLBACK_CONFIRMATION_PREFIX}${approvalSha256}:${evidenceSha256}`,
        ),
      ).toThrow(
        expect.objectContaining({ diagnosticCode: "rollback-not-eligible" }),
      );
    }
  });
});
