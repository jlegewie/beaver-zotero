/**
 * Filesystem layer for OCR fixtures.
 *
 *   <root>/_shared/<sha256>.pdf      — shared with extract fixtures
 *   <root>/<id>/ocr.json             — per-PDF OCR fixture
 *
 * OCR fixtures sit in the same corpus root as extract fixtures
 * (`fixtureFile.ts`) and reuse `_shared/<sha>.pdf`. The two are
 * distinguished by file name (`ocr.json` vs `fixture.json`), not by
 * folder naming.
 *
 * Writes go through an atomic write-temp + rename so a Ctrl-C mid-write
 * leaves the existing file untouched.
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
} from "node:fs";
import { join } from "node:path";

import {
    validateOcrFixture,
    type CapturedOcrFixture,
} from "./ocrFixtureSchema";

export interface OcrFixtureLocation {
    root: string;
    id: string;
    folder: string;
    ocrJson: string;
}

export function ocrFixtureLocation(root: string, id: string): OcrFixtureLocation {
    return {
        root,
        id,
        folder: join(root, id),
        ocrJson: join(root, id, "ocr.json"),
    };
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export function readOcrFixture(root: string, id: string): CapturedOcrFixture {
    const loc = ocrFixtureLocation(root, id);
    if (!existsSync(loc.ocrJson)) {
        throw new Error(
            `OCR fixture not found: ${loc.ocrJson} (root=${root}, id=${id})`,
        );
    }
    const raw = readFileSync(loc.ocrJson, "utf8");
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new Error(`failed to parse JSON in ${loc.ocrJson}: ${msg}`);
    }
    return validateOcrFixture(parsed, `${loc.ocrJson}#`);
}

/** Discover ids of folders that contain `ocr.json`. Skips `_*` and `.*`. */
export function listOcrFixtureIds(root: string): string[] {
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
        if (existsSync(join(folder, "ocr.json"))) ids.push(name);
    }
    ids.sort();
    return ids;
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function writeOcrFixtureFile(
    loc: OcrFixtureLocation,
    fixture: CapturedOcrFixture,
): void {
    mkdirSync(loc.folder, { recursive: true });
    const tmp = `${loc.ocrJson}.tmp-${process.pid}`;
    const json = JSON.stringify(fixture, null, 2) + "\n";
    writeFileSync(tmp, json, {
        encoding: "utf8",
        flag: "w",
        mode:
            fsConstants.S_IRUSR |
            fsConstants.S_IWUSR |
            fsConstants.S_IRGRP |
            fsConstants.S_IROTH,
    });
    renameSync(tmp, loc.ocrJson);
}

// ---------------------------------------------------------------------------
// Semantic equality (for idempotent updates)
// ---------------------------------------------------------------------------

/**
 * Compare two OCR fixtures excluding only the timestamp fields. `notes`
 * is intentionally part of semantic identity — `capture --notes "..."`
 * and `update` must not silently no-op when only the note changed.
 */
export function semanticallyEqualOcr(
    a: CapturedOcrFixture,
    b: CapturedOcrFixture,
): boolean {
    return stableStringify(stripTimestamps(a)) === stableStringify(stripTimestamps(b));
}

function stripTimestamps(
    f: CapturedOcrFixture,
): Omit<CapturedOcrFixture, "capturedAt" | "updatedAt"> {
    const { capturedAt: _capturedAt, updatedAt: _updatedAt, ...rest } = f;
    return rest;
}

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
