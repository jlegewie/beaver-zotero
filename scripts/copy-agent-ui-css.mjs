/* global process, console, setTimeout, clearTimeout */
// Copies @beaver/agent-ui's stylesheets into `addon/content/styles/`.
//
// The package ships plain `.css`: the Word add-in `import`s it through
// css-loader, but Zotero's webpack build has no css-loader at all — Beaver's
// styles reach a Zotero window as chrome files, registered app-wide via
// nsIStyleSheetService and linked from the standalone windows' XHTML. So the
// shared sheets have to exist under `addon/content/` before the scaffold runs,
// because `build.assets` in zotero-plugin.config.ts is what copies
// `addon/**/*` into the packaged XPI.
//
// Run from the npm scripts (see `copy:agent-ui-css`) rather than from a scaffold
// build hook, so a missing copy is visible in the build log instead of buried in
// plugin internals.
//
// The build scripts run it once. `npm start` also runs it with `--watch`, which
// re-copies a sheet whenever its source changes (an edit, a checkout, a merge).
// Without that, the scaffold's own rebuild (`source` includes `packages`) keeps
// shipping the stale generated copy: a hot-reloaded bundle's new markup without
// the rules it needs. Only sheets whose content differs are written, so the
// watcher's writes under addon/ cause one more scaffold rebuild, which picks up
// the fresh copy, and never a loop.
//
// Each sheet is copied rather than concatenated into beaver.css, which keeps
// provenance and diffs readable, and it keeps its own filename — so the
// `agent-ui-` prefix is required, both to make the destination obviously
// generated and so one `.gitignore` glob covers every sheet the package adds.
import {
    mkdirSync,
    readFileSync,
    readdirSync,
    watch,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(repoRoot, "packages", "agent-ui", "src", "theme");
const targetDir = path.join(repoRoot, "addon", "content", "styles");
const REQUIRED_PREFIX = "agent-ui-";

/** A file's bytes, or null when it does not exist. */
function readOrNull(file) {
    try {
        return readFileSync(file);
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
}

/**
 * Copies every sheet whose generated copy is missing or differs. Returns the
 * sheets and the ones written, or an error when the source directory breaks
 * the naming contract.
 */
function copySheets() {
    const sheets = readdirSync(sourceDir).filter((name) =>
        name.endsWith(".css"),
    );
    const misnamed = sheets.filter((name) => !name.startsWith(REQUIRED_PREFIX));
    if (misnamed.length > 0) {
        return {
            error: `agent-ui stylesheets must be named '${REQUIRED_PREFIX}*.css' so the generated copies under addon/content/styles/ stay gitignored: ${misnamed.join(", ")}`,
        };
    }
    if (sheets.length === 0) {
        return {
            error: `No stylesheets found in ${path.relative(repoRoot, sourceDir)} — the copy step is wired into the build, so an empty directory means the shared styles silently stopped shipping.`,
        };
    }

    mkdirSync(targetDir, { recursive: true });
    const written = [];
    for (const name of sheets) {
        const source = readFileSync(path.join(sourceDir, name));
        const target = path.join(targetDir, name);
        if (readOrNull(target)?.equals(source)) continue;
        writeFileSync(target, source);
        written.push(name);
    }
    return { sheets, written };
}

const result = copySheets();
if (result.error) {
    console.error(result.error);
    process.exit(1);
}
console.log(
    `Copied ${result.sheets.length} agent-ui stylesheet(s) into ${path.relative(repoRoot, targetDir)}: ${result.sheets.join(", ")}`,
);

if (process.argv.includes("--watch")) {
    // One save arrives as several events; copy once they settle.
    let pending = null;
    watch(sourceDir, () => {
        clearTimeout(pending);
        pending = setTimeout(() => {
            try {
                const next = copySheets();
                if (next.error) console.error(next.error);
                else if (next.written.length > 0) {
                    console.log(
                        `Re-copied agent-ui stylesheet(s): ${next.written.join(", ")}`,
                    );
                }
            } catch (error) {
                console.error(
                    `Copying agent-ui stylesheets failed: ${error.message}`,
                );
            }
        }, 100);
    });
    console.log(
        `Watching ${path.relative(repoRoot, sourceDir)} for stylesheet changes`,
    );
}
