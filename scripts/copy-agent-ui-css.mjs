/* global process, console */
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
// It therefore runs ONCE per `npm run build*` / `npm start` invocation, and is
// NOT watched. Editing a sheet under a running `npm start` does trigger a
// scaffold rebuild (`source` includes `packages`), but that rebuild copies the
// stale generated file from addon/content/styles/ — the plugin reloads and
// nothing changes. Re-run `npm run copy:agent-ui-css`, or use the
// reload-driven flow, after editing a shared stylesheet.
//
// Each sheet is copied rather than concatenated into beaver.css, which keeps
// provenance and diffs readable, and it keeps its own filename — so the
// `agent-ui-` prefix is required, both to make the destination obviously
// generated and so one `.gitignore` glob covers every sheet the package adds.
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(
  repoRoot,
  "packages",
  "agent-ui",
  "src",
  "theme",
);
const targetDir = path.join(repoRoot, "addon", "content", "styles");
const REQUIRED_PREFIX = "agent-ui-";

const sheets = readdirSync(sourceDir).filter((name) => name.endsWith(".css"));
const misnamed = sheets.filter((name) => !name.startsWith(REQUIRED_PREFIX));
if (misnamed.length > 0) {
  console.error(
    `agent-ui stylesheets must be named '${REQUIRED_PREFIX}*.css' so the generated copies under addon/content/styles/ stay gitignored: ${misnamed.join(", ")}`,
  );
  process.exit(1);
}
if (sheets.length === 0) {
  console.error(
    `No stylesheets found in ${path.relative(repoRoot, sourceDir)} — the copy step is wired into the build, so an empty directory means the shared styles silently stopped shipping.`,
  );
  process.exit(1);
}

mkdirSync(targetDir, { recursive: true });
for (const name of sheets) {
  copyFileSync(path.join(sourceDir, name), path.join(targetDir, name));
}
console.log(
  `Copied ${sheets.length} agent-ui stylesheet(s) into ${path.relative(repoRoot, targetDir)}: ${sheets.join(", ")}`,
);
