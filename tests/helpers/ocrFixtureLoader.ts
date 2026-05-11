/**
 * Loader for OCR-detection regression fixtures.
 *
 * OCR fixtures share corpus roots with extract fixtures (`extractFixtureLoader.ts`)
 * but are identified by the presence of `ocr.json` rather than `fixture.json`.
 * Validation runs at load time so a malformed fixture fails fast with a
 * path-prefixed error.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
    validateOcrFixture,
    type CapturedOcrFixture,
} from "../../src/services/pdf/cli/fixture/ocrFixtureSchema";
import {
    privateRoot,
    publicRoot,
    type FixtureScope,
} from "./extractFixtureLoader";

// Re-export for convenience so smoke tests only need one import.
export { publicRoot, privateRoot, readSharedPdf } from "./extractFixtureLoader";
export type { FixtureScope } from "./extractFixtureLoader";

export interface LoadedOcrFixture {
    root: string;
    scope: FixtureScope;
    id: string;
    path: string;
    fixture: CapturedOcrFixture;
}

export interface LoadOcrOptions {
    /** When true, return [] instead of throwing if the root is missing/empty. */
    skipIfMissing?: boolean;
}

/**
 * Glob `<root>/<id>/ocr.json` and return validated entries. Throws
 * unless `skipIfMissing` is set when the root is missing OR empty.
 *
 * Matches the extract loader's contract: the public corpus is required
 * for CI, so a missing root or zero matching `ocr.json` files is fatal.
 * `skipIfMissing` is the escape hatch for the gitignored private corpus.
 */
export function loadOcrFixtures(
    root: string,
    opts: LoadOcrOptions = {},
): LoadedOcrFixture[] {
    const exists = existsSync(root);
    if (!exists) {
        if (opts.skipIfMissing) return [];
        throw new Error(`OCR fixture root missing: ${root}`);
    }
    const scope: FixtureScope = root === publicRoot() ? "public" : "private";

    const fixtures: LoadedOcrFixture[] = [];
    for (const name of readdirSync(root)) {
        if (name.startsWith("_") || name.startsWith(".")) continue;
        const folder = join(root, name);
        try {
            if (!statSync(folder).isDirectory()) continue;
        } catch {
            continue;
        }
        const ocrJson = join(folder, "ocr.json");
        if (!existsSync(ocrJson)) continue;
        const raw = readFileSync(ocrJson, "utf8");
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`failed to parse JSON in ${ocrJson}: ${msg}`);
        }
        const fixture = validateOcrFixture(parsed, ocrJson);
        fixtures.push({ root, scope, id: name, path: ocrJson, fixture });
    }
    fixtures.sort((a, b) => a.id.localeCompare(b.id));

    if (fixtures.length === 0 && !opts.skipIfMissing) {
        throw new Error(`OCR fixture root has no ocr.json files: ${root}`);
    }
    return fixtures;
}
