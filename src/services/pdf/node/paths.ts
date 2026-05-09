/**
 * Resolves the repo root by walking parent directories from this file's
 * location until a `package.json` is found. Independent of `process.cwd()`,
 * so `npm run beaver-extract -- ...` works from any subdirectory.
 *
 * The default WASM dir is `<repoRoot>/addon/content/lib`. Callers can
 * override at runtime via the `BEAVER_EXTRACT_WASM_DIR` env var (read in
 * `bootstrap.ts`).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findRepoRoot(startDir: string): string {
    let dir = startDir;
    while (true) {
        if (existsSync(join(dir, "package.json"))) return dir;
        const parent = dirname(dir);
        if (parent === dir) {
            throw new Error(
                `Could not locate package.json walking up from ${startDir}`,
            );
        }
        dir = parent;
    }
}

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot: string = findRepoRoot(here);
export const defaultWasmDir: string = join(repoRoot, "addon/content/lib");
