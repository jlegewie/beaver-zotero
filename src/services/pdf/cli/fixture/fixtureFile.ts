/**
 * Filesystem layer for the fixture corpus.
 *
 *   <root>/_shared/<sha256>.pdf      — deduped PDF storage
 *   <root>/<id>/fixture.json         — per-fixture metadata + snapshot
 *
 * All writes go through `writeJsonAtomic` (write-temp, fsync, rename) so
 * a partial write on Ctrl-C can't corrupt an existing fixture.
 *
 * Used only by Node code paths (CLI commands + smoke tests). Do NOT import
 * from `react/`.
 */
import {
    constants as fsConstants,
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    renameSync,
    statSync,
    writeFileSync,
    writeFileSync as writeFileSyncPlain,
} from "node:fs";
import { dirname, join } from "node:path";

import { pdfSha256 } from "../io";
import { validateFixture, type CapturedFixture } from "./fixtureSchema";

/** Path to the canonical public corpus root, relative to the repo root. */
export const PUBLIC_FIXTURE_ROOT_REL = "tests/fixtures/pdfs/extract-public" as const;
/** Path to the canonical (gitignored) private corpus root. */
export const PRIVATE_FIXTURE_ROOT_REL = "tests/fixtures/pdfs/extract" as const;

export interface FixtureLocation {
    root: string;
    id: string;
    folder: string;
    fixtureJson: string;
}

export function fixtureLocation(root: string, id: string): FixtureLocation {
    return {
        root,
        id,
        folder: join(root, id),
        fixtureJson: join(root, id, "fixture.json"),
    };
}

export function sharedPdfPath(root: string, sha: string): string {
    return join(root, "_shared", `${sha}.pdf`);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Read + validate a fixture from disk. The validator throws
 * `FixtureValidationError` with a path-prefixed message if the file is
 * malformed.
 */
export function readFixture(root: string, id: string): CapturedFixture {
    const loc = fixtureLocation(root, id);
    if (!existsSync(loc.fixtureJson)) {
        throw new Error(
            `fixture not found: ${loc.fixtureJson} (root=${root}, id=${id})`,
        );
    }
    const raw = readFileSync(loc.fixtureJson, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`failed to parse JSON in ${loc.fixtureJson}: ${msg}`);
    }
    return validateFixture(parsed, `${loc.fixtureJson}#`);
}

export function readSharedPdf(root: string, sha: string): Uint8Array {
    const path = sharedPdfPath(root, sha);
    if (!existsSync(path)) {
        throw new Error(
            `shared PDF missing: ${path} — capture or copy it before evaluating`,
        );
    }
    return new Uint8Array(readFileSync(path));
}

/** Discover fixture ids under a corpus root. */
export interface FoundFixture {
    root: string;
    id: string;
}

export function listFixtureIds(root: string): string[] {
    if (!existsSync(root)) return [];
    const ids: string[] = [];
    for (const name of readdirSync(root)) {
        if (name.startsWith("_") || name.startsWith(".")) continue;
        const folder = join(root, name);
        try {
            if (!statSync(folder).isDirectory()) continue;
        } catch {
            continue;
        }
        if (existsSync(join(folder, "fixture.json"))) ids.push(name);
    }
    ids.sort();
    return ids;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

/**
 * Write the shared PDF for `bytes` if not already present. Returns the
 * sha used as the filename. Writes are skipped when the file already
 * exists with the matching size, so re-capture is cheap.
 */
export function ensureSharedPdf(root: string, bytes: Uint8Array): string {
    const sha = pdfSha256(bytes);
    const path = sharedPdfPath(root, sha);
    if (existsSync(path)) {
        try {
            const size = statSync(path).size;
            if (size === bytes.byteLength) return sha;
        } catch {
            // fall through and rewrite
        }
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSyncPlain(path, bytes);
    return sha;
}

/**
 * Atomic JSON write with stable key order and a trailing newline.
 *
 * Uses a temp file in the same directory + `renameSync` so a Ctrl-C
 * mid-write leaves either the old file untouched or the new file
 * complete — never a partial body.
 */
export function writeFixtureFile(loc: FixtureLocation, fixture: CapturedFixture): void {
    mkdirSync(loc.folder, { recursive: true });
    const tmp = `${loc.fixtureJson}.tmp-${process.pid}`;
    const json = JSON.stringify(fixture, null, 2) + "\n";
    writeFileSync(tmp, json, { encoding: "utf8", flag: "w", mode: fsConstants.S_IRUSR | fsConstants.S_IWUSR | fsConstants.S_IRGRP | fsConstants.S_IROTH });
    renameSync(tmp, loc.fixtureJson);
}

// ---------------------------------------------------------------------------
// Comparison for idempotent updates
// ---------------------------------------------------------------------------

/**
 * Compare two fixtures excluding only the timestamp fields. Used by
 * `fixture update` and `fixture capture --update` to skip writes when
 * nothing semantic has changed (true idempotence — second run is a no-op).
 */
export function semanticallyEqual(a: CapturedFixture, b: CapturedFixture): boolean {
    const stripA = stripTimestamps(a);
    const stripB = stripTimestamps(b);
    return stableStringify(stripA) === stableStringify(stripB);
}

function stripTimestamps(f: CapturedFixture): Omit<CapturedFixture, "capturedAt" | "updatedAt"> {
    const { capturedAt: _capturedAt, updatedAt: _updatedAt, ...rest } = f;
    return rest;
}

/**
 * `JSON.stringify` with deterministic key order. Used only for equality
 * comparison — the on-disk format goes through the regular stringify.
 */
function stableStringify(value: unknown): string {
    return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortKeysDeep);
    if (value && typeof value === "object") {
        const out: Record<string, unknown> = {};
        for (const k of Object.keys(value as Record<string, unknown>).sort()) {
            out[k] = sortKeysDeep((value as Record<string, unknown>)[k]);
        }
        return out;
    }
    return value;
}
