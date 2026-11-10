"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const {
  MoonResourceAuthorityError,
  calculateAuthorityContentHash,
  createMoonResourceAuthority,
} = require(path.join(__dirname, "./moonResourceAuthority"));

const EXPECTED_DATABASE_SCHEMA_VERSION = 1;
const MINIMUM_SOURCE_SCAN_YEAR = 2000;
const MAXIMUM_SOURCE_SCAN_YEAR = 9999;
const ALLOWED_PROFILE_ERROR_CODES = new Set([
  "INVALID_SOURCE_RESOURCE_QUANTITY",
  "RESOURCE_TOTAL_OVER_ONE",
]);
const REQUIRED_COLUMNS = Object.freeze({
  provenance: ["key", "value"],
  systems: ["solar_system_id"],
  source_system_aliases: ["source_system_name"],
  moons: [
    "moon_id",
    "solar_system_id",
    "missing_quantity_count",
    "known_fraction_total",
    "scan_year",
    "sde_match",
  ],
  ores: ["ore_name", "type_id"],
  moon_resources: [
    "moon_id",
    "ore_type_id",
    "quantity_status",
    "quantity_fraction",
  ],
  validation_issues: ["severity", "code", "moon_id"],
});

function fail(code, message, details = {}) {
  throw new MoonResourceAuthorityError(code, message, details);
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(code, `failed to read ${filePath}: ${error.message}`, { filePath });
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function assertDatabaseSchema(db) {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = new Set(
      db.prepare(`PRAGMA table_info(${table})`).all().map((entry) => entry.name),
    );
    if (columns.size === 0) {
      fail("AUTHORITY_TABLE_MISSING", `required authority table ${table} is missing`, { table });
    }
    const missingColumns = requiredColumns.filter((column) => !columns.has(column));
    if (missingColumns.length > 0) {
      fail(
        "AUTHORITY_COLUMN_MISSING",
        `authority table ${table} is missing required column(s): ${missingColumns.join(", ")}`,
        { table, missingColumns },
      );
    }
  }
}

function assertDatabaseIntegrity(db) {
  const integrityRows = db.prepare("PRAGMA integrity_check").all();
  if (
    integrityRows.length !== 1 ||
    String(integrityRows[0].integrity_check || "").toLowerCase() !== "ok"
  ) {
    fail("AUTHORITY_DATABASE_INTEGRITY_FAILED", "SQLite integrity_check failed", {
      integrityRows,
    });
  }
  const foreignKeyRows = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyRows.length > 0) {
    fail("AUTHORITY_DATABASE_FOREIGN_KEY_FAILED", "SQLite foreign_key_check failed", {
      foreignKeyRows,
    });
  }
}

function readProvenance(db) {
  return Object.fromEntries(
    db.prepare("SELECT key, value FROM provenance ORDER BY key").all()
      .map((entry) => [entry.key, entry.value]),
  );
}

function count(db, sql) {
  return Number(db.prepare(sql).get().n);
}

function readDatabaseCounts(db) {
  return {
    systems: count(db, "SELECT count(*) AS n FROM systems"),
    moons: count(db, "SELECT count(*) AS n FROM moons"),
    resources: count(db, "SELECT count(*) AS n FROM moon_resources"),
    ores: count(db, "SELECT count(*) AS n FROM ores"),
    sourceSystemAliases: count(db, "SELECT count(*) AS n FROM source_system_aliases"),
    invalidQuantityMoons: count(
      db,
      "SELECT count(*) AS n FROM moons WHERE missing_quantity_count > 0",
    ),
    invalidQuantityRows: count(
      db,
      "SELECT count(*) AS n FROM moon_resources WHERE quantity_status <> 'valid'",
    ),
    overOneMoons: count(
      db,
      "SELECT count(*) AS n FROM moons " +
        "WHERE missing_quantity_count = 0 AND known_fraction_total > 1.00011",
    ),
    sdeMismatchedMoons: count(db, "SELECT count(*) AS n FROM moons WHERE sde_match = 0"),
    errorIssues: count(
      db,
      "SELECT count(*) AS n FROM validation_issues WHERE severity = 'error'",
    ),
    informationalIssues: count(
      db,
      "SELECT count(*) AS n FROM validation_issues WHERE severity = 'info'",
    ),
  };
}

function assertManifest(manifest, databasePath, databaseHash, databaseSize, counts) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("INVALID_AUTHORITY_MANIFEST", "authority database manifest must be an object");
  }
  if (manifest.schemaVersion !== EXPECTED_DATABASE_SCHEMA_VERSION) {
    fail(
      "UNSUPPORTED_AUTHORITY_DATABASE_SCHEMA",
      `authority database schemaVersion must equal ${EXPECTED_DATABASE_SCHEMA_VERSION}`,
      { actual: manifest.schemaVersion },
    );
  }
  if (manifest.database !== path.basename(databasePath)) {
    fail("AUTHORITY_DATABASE_NAME_MISMATCH", "manifest database name does not match", {
      expected: path.basename(databasePath),
      actual: manifest.database,
    });
  }
  if (Number(manifest.databaseBytes) !== databaseSize) {
    fail("AUTHORITY_DATABASE_SIZE_MISMATCH", "manifest database size does not match", {
      expected: manifest.databaseBytes,
      actual: databaseSize,
    });
  }
  if (String(manifest.databaseSha256 || "").toLowerCase() !== databaseHash) {
    fail("AUTHORITY_DATABASE_HASH_MISMATCH", "manifest database SHA-256 does not match", {
      expected: manifest.databaseSha256,
      actual: databaseHash,
    });
  }
  for (const [key, actual] of Object.entries(counts)) {
    if (Number(manifest[key]) !== actual) {
      fail("AUTHORITY_MANIFEST_COUNT_MISMATCH", `manifest ${key} count does not match`, {
        key,
        expected: manifest[key],
        actual,
      });
    }
  }
}

function parseSourceBuild(provenance) {
  const archive = String(provenance.sde_archive || "");
  const match = archive.match(/-(\d+)-jsonl\.zip$/i);
  if (!match) {
    fail(
      "AUTHORITY_SOURCE_BUILD_MISSING",
      "could not derive the SDE build from provenance.sde_archive",
      { archive },
    );
  }
  return Number(match[1]);
}

function readSourceScanYears(db) {
  const invalidRows = db.prepare(
    "SELECT scan_year AS scanYear, count(*) AS moonCount FROM moons " +
      "WHERE scan_year IS NULL OR typeof(scan_year) <> 'integer' " +
      "OR scan_year < ? OR scan_year > ? " +
      "GROUP BY scan_year ORDER BY scan_year",
  ).all(MINIMUM_SOURCE_SCAN_YEAR, MAXIMUM_SOURCE_SCAN_YEAR);
  if (invalidRows.length > 0) {
    fail(
      "AUTHORITY_SOURCE_SCAN_YEAR_INVALID",
      "authority atlas scan years must be four-digit integers",
      { minimumScanYear: MINIMUM_SOURCE_SCAN_YEAR, maximumScanYear: MAXIMUM_SOURCE_SCAN_YEAR,
        invalidRows },
    );
  }
  const scanYears = db.prepare(
    "SELECT DISTINCT scan_year AS scanYear FROM moons ORDER BY scan_year",
  ).all().map((entry) => Number(entry.scanYear));
  if (scanYears.length === 0) {
    fail("AUTHORITY_SOURCE_SCAN_YEAR_MISSING", "authority database contains no scan years");
  }
  return scanYears;
}

function assertKnownProfileErrors(db, counts) {
  const globalErrors = count(
    db,
    "SELECT count(*) AS n FROM validation_issues " +
      "WHERE severity = 'error' AND moon_id IS NULL",
  );
  if (globalErrors > 0) {
    fail(
      "GLOBAL_AUTHORITY_VALIDATION_ERROR",
      "authority database contains error issues not scoped to a moon",
      { globalErrors },
    );
  }

  const errorRows = db.prepare(
    "SELECT code, count(DISTINCT moon_id) AS moon_count " +
      "FROM validation_issues WHERE severity = 'error' " +
      "GROUP BY code ORDER BY code",
  ).all();
  const unknownCodes = errorRows
    .map((entry) => entry.code)
    .filter((code) => !ALLOWED_PROFILE_ERROR_CODES.has(code));
  if (unknownCodes.length > 0) {
    fail(
      "UNKNOWN_AUTHORITY_VALIDATION_ERROR",
      `authority database contains unsupported error code(s): ${unknownCodes.join(", ")}`,
      { unknownCodes },
    );
  }

  const rejectedMoons = count(
    db,
    "SELECT count(DISTINCT moon_id) AS n FROM validation_issues " +
      "WHERE severity = 'error' AND moon_id IS NOT NULL",
  );
  const expectedRejectedMoons = counts.invalidQuantityMoons + counts.overOneMoons;
  if (rejectedMoons !== expectedRejectedMoons) {
    fail(
      "AUTHORITY_REJECTION_COUNT_MISMATCH",
      "error-marked moon count does not match manifest rejection categories",
      { rejectedMoons, expectedRejectedMoons },
    );
  }
  return rejectedMoons;
}

function readEligibleProfiles(db, datasetVersion, profileSourceID) {
  const rows = db.prepare(`
    SELECT
      m.moon_id AS moonID,
      m.solar_system_id AS solarSystemID,
      r.ore_type_id AS typeID,
      r.quantity_fraction AS fraction
    FROM moons AS m
    INNER JOIN moon_resources AS r ON r.moon_id = m.moon_id
    WHERE m.sde_match = 1
      AND NOT EXISTS (
        SELECT 1 FROM validation_issues AS issue
        WHERE issue.moon_id = m.moon_id AND issue.severity = 'error'
      )
    ORDER BY m.moon_id, r.ore_type_id
  `).all();

  const profiles = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.moonID !== row.moonID) {
      current = {
        moonID: row.moonID,
        solarSystemID: row.solarSystemID,
        profileID: `${profileSourceID}:moon:${row.moonID}`,
        datasetVersion,
        sourceStatus: "valid",
        composition: [],
      };
      profiles.push(current);
    }
    current.composition.push({
      typeID: row.typeID,
      fraction: row.fraction,
    });
  }
  return { profiles, resourceRows: rows.length };
}

function loadMoonResourceAuthorityFromSqlite(databasePath, options = {}) {
  const resolvedDatabasePath = path.resolve(databasePath);
  const manifestPath = path.resolve(
    options.manifestPath || path.join(path.dirname(resolvedDatabasePath), "database-manifest.json"),
  );
  if (!fs.existsSync(resolvedDatabasePath)) {
    fail("AUTHORITY_DATABASE_NOT_FOUND", `authority database not found: ${resolvedDatabasePath}`);
  }
  if (!fs.existsSync(manifestPath)) {
    fail("AUTHORITY_MANIFEST_NOT_FOUND", `authority manifest not found: ${manifestPath}`);
  }

  const manifest = readJson(manifestPath, "INVALID_AUTHORITY_MANIFEST");
  const databaseSize = fs.statSync(resolvedDatabasePath).size;
  const databaseHash = sha256File(resolvedDatabasePath);
  let db;
  try {
    db = new DatabaseSync(resolvedDatabasePath, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    assertDatabaseSchema(db);
    assertDatabaseIntegrity(db);
    const provenance = readProvenance(db);
    const counts = readDatabaseCounts(db);
    assertManifest(manifest, resolvedDatabasePath, databaseHash, databaseSize, counts);

    if (Number(provenance.schema_version) !== EXPECTED_DATABASE_SCHEMA_VERSION) {
      fail(
        "AUTHORITY_PROVENANCE_SCHEMA_MISMATCH",
        "database provenance schema_version does not match the manifest",
      );
    }
    if (provenance.generated_at !== manifest.generatedAt) {
      fail(
        "AUTHORITY_GENERATED_AT_MISMATCH",
        "database provenance generated_at does not match the manifest",
      );
    }

    const sourceBuild = parseSourceBuild(provenance);
    if (options.expectedSourceBuild && sourceBuild !== options.expectedSourceBuild) {
      fail(
        "AUTHORITY_SOURCE_BUILD_MISMATCH",
        `authority SDE build ${sourceBuild} does not match expected build ${options.expectedSourceBuild}`,
        { sourceBuild, expectedSourceBuild: options.expectedSourceBuild },
      );
    }
    const sourceScanYears = readSourceScanYears(db);
    const scanYearIdentity = sourceScanYears.join("-");
    const atlasSourceID = `fusionrift-lowsec-moons-scan-years-${scanYearIdentity}`;
    const rejectedMoons = assertKnownProfileErrors(db, counts);
    const datasetVersion =
      `fusionrift-lowsec-scan-years-${scanYearIdentity}` +
      `+sde-${sourceBuild}+db-${databaseHash.slice(0, 12)}`;
    const { profiles, resourceRows } = readEligibleProfiles(
      db,
      datasetVersion,
      atlasSourceID,
    );
    const eligibleMoons = counts.moons - rejectedMoons - counts.sdeMismatchedMoons;
    if (profiles.length !== eligibleMoons) {
      fail(
        "AUTHORITY_ELIGIBLE_PROFILE_COUNT_MISMATCH",
        "eligible profile count does not match validated moon counts",
        { profileCount: profiles.length, eligibleMoons },
      );
    }

    const dataset = {
      schemaVersion: 1,
      datasetVersion,
      sourceBuild,
      authorityClass: "evidence_snapshot",
      tranquilityExact: false,
      fallbackPolicy: "fail_closed",
      provenance: [
        {
          sourceID: `ccp-sde-${sourceBuild}`,
          sourceKind: "official_sde",
          sourceVersion: String(sourceBuild),
          sha256: String(provenance.sde_archive_sha256 || "").toLowerCase(),
        },
        {
          sourceID: atlasSourceID,
          sourceKind: "normalized_public_atlas_sqlite",
          sourceVersion: String(provenance.generated_at || ""),
          sha256: databaseHash,
        },
      ],
      importSummary: {
        sourceMoons: counts.moons,
        sourceResourceRows: counts.resources,
        eligibleMoons,
        eligibleResourceRows: resourceRows,
        rejectedMoons,
        invalidQuantityMoons: counts.invalidQuantityMoons,
        overOneMoons: counts.overOneMoons,
        sdeMismatchedMoons: counts.sdeMismatchedMoons,
      },
      profiles,
    };
    dataset.contentHash = calculateAuthorityContentHash(dataset);
    return Object.freeze({
      authority: createMoonResourceAuthority(dataset),
      dataset,
      manifest,
      summary: Object.freeze({ ...dataset.importSummary }),
    });
  } catch (error) {
    if (error instanceof MoonResourceAuthorityError) {
      throw error;
    }
    fail("AUTHORITY_DATABASE_READ_FAILED", `failed to load authority database: ${error.message}`, {
      databasePath: resolvedDatabasePath,
    });
  } finally {
    if (db) {
      db.close();
    }
  }
}

module.exports = {
  loadMoonResourceAuthorityFromSqlite,
};
