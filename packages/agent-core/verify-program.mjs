/* global process, console */
// Asserts the tsconfig `files` list matches the real import closure of the
// protocol entry point, in both directions: a file reachable from the entry
// but missing from the list fails, and a listed file no longer reachable
// fails. `files` alone cannot enforce either — it seeds the program without
// bounding it, and every listed file is in the program by construction.
// Also asserts every file under src/ is part of that closure, so an orphan
// module cannot sit in the package outside the gate's typecheck.
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.join(pkgDir, "tsconfig.json");
const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
if (error) {
  throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
}
const parsed = ts.parseJsonConfigFileContent(config, ts.sys, pkgDir);
if (parsed.errors.length > 0) {
  throw new Error(
    parsed.errors
      .map((e) => ts.flattenDiagnosticMessageText(e.messageText, "\n"))
      .join("\n"),
  );
}

// The roots the closure is computed from. Everything else in `files` must be
// reachable from these, so an ambient .d.ts added to `files` cannot silently
// widen the program.
const entryBasenames = ["globals.d.ts", "agentProtocol.ts"];

const listed = parsed.fileNames.map((f) => path.resolve(f));
const entries = listed.filter((f) => entryBasenames.includes(path.basename(f)));
if (entries.length !== entryBasenames.length) {
  throw new Error(
    `tsconfig \`files\` must list the entry points: ${entryBasenames.join(", ")}`,
  );
}

const program = ts.createProgram({
  rootNames: entries,
  options: parsed.options,
});
const closure = program
  .getSourceFiles()
  .filter((sf) => !program.isSourceFileDefaultLibrary(sf))
  .map((sf) => path.resolve(sf.fileName));

const listedSet = new Set(listed);
const closureSet = new Set(closure);
const unlisted = closure.filter((f) => !listedSet.has(f));
const stale = listed.filter((f) => !closureSet.has(f));
// Even a listed-and-reachable file must live inside the package — the core
// must not reach back into the host repo.
const escapees = closure.filter((f) => !f.startsWith(pkgDir + path.sep));
// And every file on disk under src/ must be in the closure — an orphan would
// be typechecked (and lint-guarded) only loosely, never by this gate.
const onDisk = readdirSync(path.join(pkgDir, "src"), {
  recursive: true,
  withFileTypes: true,
})
  .filter((d) => d.isFile() && /\.(ts|tsx|mts|cts|js|mjs)$/.test(d.name))
  .map((d) => path.resolve(d.parentPath ?? d.path, d.name));
const orphans = onDisk.filter((f) => !closureSet.has(f));

if (
  unlisted.length > 0 ||
  stale.length > 0 ||
  escapees.length > 0 ||
  orphans.length > 0
) {
  for (const f of unlisted) {
    console.error(
      `reachable from the entry but not in tsconfig files: ${path.relative(pkgDir, f)}`,
    );
  }
  for (const f of stale) {
    console.error(
      `listed in tsconfig files but not reachable from the entry: ${path.relative(pkgDir, f)}`,
    );
  }
  for (const f of escapees) {
    console.error(`in the closure but outside the package: ${f}`);
  }
  for (const f of orphans) {
    console.error(
      `on disk under src/ but not in the closure: ${path.relative(pkgDir, f)}`,
    );
  }
  const summary =
    escapees.length > 0
      ? "agent-core reaches outside the package — remove the offending import."
      : orphans.length > 0
        ? "agent-core has files outside the entry closure — wire them into the protocol or remove them."
        : "agent-core `files` drifted from the real closure — update the list to match.";
  console.error(summary);
  process.exit(1);
}
console.log(`agent-core closure verified: ${listedSet.size} files.`);
