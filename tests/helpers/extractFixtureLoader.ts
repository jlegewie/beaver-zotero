/**
 * Loader for BeaverExtract regression fixtures.
 *
 * Two corpus roots:
 *   - `extract-public/` — committed, redistributable. Required for CI.
 *   - private corpus    — resolved from `$BEAVER_EXTRACT_FIXTURES_DIR`
 *                         (falls back to the legacy in-tree
 *                         `tests/fixtures/pdfs/extract/`). Best-effort.
 *
 * Schema validation runs at load time so a malformed fixture fails fast
 * with a path-prefixed error rather than a deep-compare crash inside the
 * test runner.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    PUBLIC_FIXTURE_ROOT_REL,
    resolvePrivateFixtureRoot,
    sharedPdfPath,
} from "../../src/beaver-extract/cli/fixture/fixtureFile";
import {
    FixtureValidationError,
    validateFixture,
    type CapturedFixture,
} from "../../src/beaver-extract/cli/fixture/fixtureSchema";

const REPO_ROOT = resolve(__dirname, "..", "..");

export function publicRoot(): string {
    return resolve(REPO_ROOT, PUBLIC_FIXTURE_ROOT_REL);
}

export function privateRoot(): string {
    return resolvePrivateFixtureRoot(REPO_ROOT);
}

export type FixtureScope = "public" | "private";

export interface LoadedFixture {
    root: string;
    scope: FixtureScope;
    id: string;
    path: string;
    fixture: CapturedFixture;
}

export interface LoadOptions {
    /** When true, return [] instead of throwing if the root is missing/empty. */
    skipIfMissing?: boolean;
}

/**
 * Glob `<root>/<id>/fixture.json` and return validated entries. Throws
 * unless `skipIfMissing` is set when the root is missing or empty.
 */
export function loadExtractFixtures(
    root: string,
    opts: LoadOptions = {},
): LoadedFixture[] {
    const exists = existsSync(root);
    if (!exists) {
        if (opts.skipIfMissing) return [];
        throw new Error(`extract fixture root missing: ${root}`);
    }
    const scope: FixtureScope =
        root === publicRoot() ? "public" : "private";

    const fixtures: LoadedFixture[] = [];
    for (const name of readdirSync(root)) {
        if (name.startsWith("_") || name.startsWith(".")) continue;
        const folder = join(root, name);
        try {
            if (!statSync(folder).isDirectory()) continue;
        } catch {
            continue;
        }
        const fixtureJson = join(folder, "fixture.json");
        if (!existsSync(fixtureJson)) continue;
        const raw = readFileSync(fixtureJson, "utf8");
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`failed to parse JSON in ${fixtureJson}: ${msg}`);
        }
        let fixture: CapturedFixture;
        try {
            fixture = validateFixture(parsed, fixtureJson);
        } catch (e) {
            if (
                opts.skipIfMissing &&
                e instanceof FixtureValidationError &&
                /schema: expected/.test(e.message)
            ) {
                continue;
            }
            throw e;
        }
        fixtures.push({ root, scope, id: name, path: fixtureJson, fixture });
    }
    fixtures.sort((a, b) => a.id.localeCompare(b.id));

    if (fixtures.length === 0 && !opts.skipIfMissing) {
        throw new Error(`extract fixture root is empty: ${root}`);
    }
    return fixtures;
}

export function readSharedPdf(root: string, sha: string): Uint8Array {
    const path = sharedPdfPath(root, sha);
    if (!existsSync(path)) {
        throw new Error(
            `shared PDF missing: ${path} — run "beaver-extract fixture capture" or copy the source PDF into _shared/ before evaluating`,
        );
    }
    return new Uint8Array(readFileSync(path));
}
