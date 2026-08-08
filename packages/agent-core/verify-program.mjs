/* global process, console */
// Gate for the @beaver/agent-core package. Asserts seven properties of the
// standalone TypeScript program:
//
// 0. The package resolves its dependencies from the repo root, at the ranges
//    the root declares. The package is never installed on its own, so the
//    typecheck sees the version the plugin ships — but only while the two
//    manifests agree and no stray install sits beside the package.
// 1. The tsconfig `files` list matches the real import closure of the entry
//    points, in both directions: a package file reachable from an entry but
//    missing from the list fails, and a listed file no longer reachable fails.
//    `files` alone cannot enforce either — it seeds the program without
//    bounding it, and every listed file is in the program by construction.
// 2. No file in the closure lives outside the package, other than dependency
//    declarations under node_modules. This is what catches the core reaching
//    back into the host repo.
// 3. Every bare import specifier written by a package file names a dependency
//    the package declares, and never a Node builtin — the core must not assume
//    a Node runtime. This is checked on specifiers rather than on resolved
//    paths because a single declared dependency pulls in the .d.ts graph of
//    packages the core never names, which must not have to be enumerated here.
//    Specifiers that name `node_modules` outright, and `/// <reference>`
//    directives of every kind, are rejected for the same reason: each is a way
//    to reach ambient declarations without naming a dependency.
// 4. The compiler options that make the isolation meaningful are actually set —
//    `types` present and empty, `lib` present and ECMAScript-only. Without
//    this, deleting either line hands the core the whole Node or browser
//    surface with every other check still green.
// 5. The package's own .d.ts files typecheck with `skipLibCheck` off. The build
//    needs it on so a dependency's declarations are not checked against the
//    core's deliberately bare lib, but that would otherwise stop checking
//    globals.d.ts — the file the whole isolation rests on — and silently turn
//    an unresolved type in it into `any`.
// 6. Every file on disk under src/ is part of the closure, so an orphan module
//    cannot sit in the package outside this gate's typecheck.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(pkgDir, "src");
const repoRoot = path.resolve(pkgDir, "..", "..");
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

// `dependencies` and `peerDependencies` are both part of the package's declared
// external contract, so both satisfy the specifier rule. `devDependencies`
// deliberately do not — they are not available to a consumer of the package.
const manifest = JSON.parse(
  readFileSync(path.join(pkgDir, "package.json"), "utf8"),
);
const declaredDeps = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const nodeBuiltins = new Set(builtinModules);

const setupErrors = [];

// The package is never installed on its own: the repo has no workspaces, so
// this manifest is documentation for external consumers while the typecheck
// resolves the repo's own copy. That is deliberate — shared code is then
// checked against the version the plugin ships — but it only holds while the
// root pins everything the core imports and the package has no install of its
// own. Resolving through a transitively hoisted copy instead would leave the
// core checked against a version any install can move. The rules below differ
// per section; see each.
const rootManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const rootDeps = rootManifest.dependencies ?? {};
const rootPinned = new Set([
  ...Object.keys(rootDeps),
  ...Object.keys(rootManifest.devDependencies ?? {}),
]);
for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
  if (rootDeps[name] === undefined) {
    setupErrors.push(
      `dependency '${name}' is not declared in the repo root — the typecheck would resolve it from a hoisted copy nothing pins.`,
    );
  } else if (rootDeps[name] !== range) {
    setupErrors.push(
      `dependency '${name}' is declared as '${range}' here but '${rootDeps[name]}' in the repo root — the two are one value and must move together.`,
    );
  }
}
// A peer's range belongs to whoever consumes the package, so it has no reason
// to match the root's. It still has to be pinned somewhere in the root, or the
// typecheck — and both plugin bundles, which compile this package from source —
// resolve it from a hoisted copy nothing controls.
for (const name of Object.keys(manifest.peerDependencies ?? {})) {
  if (!rootPinned.has(name)) {
    setupErrors.push(
      `peer dependency '${name}' is not pinned by the repo root — the typecheck would resolve it from a hoisted copy nothing pins.`,
    );
  }
}
if (ts.sys.directoryExists(path.join(pkgDir, "node_modules"))) {
  setupErrors.push(
    "packages/agent-core/node_modules exists — the package must resolve its dependencies from the repo root, or the typecheck stops reflecting the version the plugin ships.",
  );
}

// Guards the two tsconfig settings the isolation depends on. Both are allowed
// exactly one shape rather than screened for known-bad values: `types` and
// `lib` each mean "everything available" when omitted, and each has more ways
// to name a host surface (WebWorker, DOM.Iterable, ScriptHost, …) than a
// denylist can keep up with.
if (!Array.isArray(parsed.options.types) || parsed.options.types.length > 0) {
  setupErrors.push(
    `tsconfig \`types\` must be present and empty; it is ${JSON.stringify(parsed.options.types)}. Omitting it makes every installed @types package ambient. Declare the host globals the core needs in globals.d.ts instead.`,
  );
}
// The es* and decorators* families are pure ECMAScript; dom*, webworker* and
// scripthost are the host surfaces. `.full` is excluded because those variants
// reference the DOM lib even though their names begin with `es`.
const nonEsLibs = (parsed.options.lib ?? []).filter(
  (lib) => !/^lib\.(es|decorators)/i.test(lib) || /\.full\./i.test(lib),
);
if (!parsed.options.lib || nonEsLibs.length > 0) {
  setupErrors.push(
    `tsconfig \`lib\` must be present and list only ECMAScript libraries; it is ${JSON.stringify(parsed.options.lib)}. Declare the host globals the core needs in globals.d.ts instead.`,
  );
}

// The roots the closure is computed from. Everything else in `files` must be
// reachable from these, so an ambient .d.ts added to `files` cannot silently
// widen the program.
//
// The transport roots are the modules no other package file imports: the
// connection a host opens (`providerConnection` also pulls in `agentService`),
// each backend client a host calls directly, and the three standalone helpers
// (`threadService`, `agentActionQueue`, `attachmentLimits`). Everything else in
// transport/ is reached from one of them.
//
// `protocol/wordProtocol.ts` is a root for the same reason: it declares the op
// envelope a Word client serves and the backend mirrors, so nothing inside the
// package imports it.
//
// The run-state modules are roots too: each is a leaf a client calls to turn an
// agent run into render state, and nothing else in the package imports them.
const entryPaths = [
  "src/globals.d.ts",
  "src/protocol/agentProtocol.ts",
  "src/protocol/wordProtocol.ts",
  "src/transport/providerConnection.ts",
  "src/transport/threadService.ts",
  "src/transport/agentActionQueue.ts",
  "src/transport/attachmentLimits.ts",
  "src/transport/clients/accountService.ts",
  "src/transport/clients/chatService.ts",
  "src/transport/clients/agentActionsService.ts",
  "src/transport/clients/embeddingsService.ts",
  "src/transport/clients/searchService.ts",
  "src/transport/clients/diagnosticsService.ts",
  "src/run-state/toolResultViews.ts",
  "src/run-state/toolResultTypes.ts",
  "src/run-state/toolCallRequest.ts",
  "src/run-state/runResumeHelpers.ts",
].map((p) => path.join(pkgDir, p));

const listed = parsed.fileNames.map((f) => path.resolve(f));
const listedSet = new Set(listed);
const missingEntries = entryPaths.filter((f) => !listedSet.has(f));
if (missingEntries.length > 0) {
  throw new Error(
    `tsconfig \`files\` must list the entry points; missing: ${missingEntries
      .map((f) => path.relative(pkgDir, f))
      .join(", ")}`,
  );
}
const entries = entryPaths;

const program = ts.createProgram({
  rootNames: entries,
  options: parsed.options,
});
const sourceFiles = program
  .getSourceFiles()
  .filter((sf) => !program.isSourceFileDefaultLibrary(sf));
const closure = sourceFiles.map((sf) => path.resolve(sf.fileName));

const isInPackage = (f) => f.startsWith(pkgDir + path.sep);
// Relative to the repo root, so a checkout that itself sits under a directory
// named node_modules does not turn the escapee check into a silent no-op.
const isDependency = (f) =>
  path.relative(repoRoot, f).split(path.sep).includes("node_modules");

const closureSet = new Set(closure);
// `files` describes the package's own surface, so the two-way match is scoped
// to in-package files; a dependency's .d.ts graph is never listed.
const unlisted = closure.filter((f) => isInPackage(f) && !listedSet.has(f));
const stale = listed.filter((f) => !closureSet.has(f));
// Even a listed-and-reachable file must live inside the package — the core
// must not reach back into the host repo. Dependency declarations are the one
// legitimate way to be outside it.
const escapees = closure.filter((f) => !isInPackage(f) && !isDependency(f));

// Collects the module specifiers a file writes, across static imports,
// re-exports, `import type`, `import x =`, dynamic `import()`, and inline
// `import('...')` type references. Relative specifiers are included so the
// caller can reject the ones that spell out `node_modules`.
function collectSpecifiers(sourceFile) {
  const specifiers = new Set();
  const visit = (node) => {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      specifier = node.moduleReference.expression.text;
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      specifier = node.argument.literal.text;
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier !== undefined) {
      specifiers.add(specifier);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

// "@scope/name/sub" -> "@scope/name"; "name/sub" -> "name".
function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : segments[0];
}

const undeclaredImports = [];
const builtinImports = [];
const ambientReferences = [];
// Every file the package owns, not just those under src/: a helper at the
// package root would otherwise be an unguarded region.
for (const sourceFile of sourceFiles) {
  const filePath = path.resolve(sourceFile.fileName);
  if (!isInPackage(filePath)) continue;
  const file = path.relative(pkgDir, filePath);
  for (const { fileName } of sourceFile.typeReferenceDirectives) {
    ambientReferences.push({ file, kind: "types", name: fileName });
  }
  for (const { fileName } of sourceFile.libReferenceDirectives) {
    ambientReferences.push({ file, kind: "lib", name: fileName });
  }
  for (const { fileName } of sourceFile.referencedFiles) {
    ambientReferences.push({ file, kind: "path", name: fileName });
  }
  for (const specifier of collectSpecifiers(sourceFile)) {
    const where = { file, specifier };
    // No legitimate specifier names node_modules. Spelling it out is the one
    // way to reach a dependency's files without naming the dependency, and it
    // works from a relative specifier too.
    if (specifier.split("/").includes("node_modules")) {
      undeclaredImports.push({ ...where, packageName: "node_modules" });
      continue;
    }
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) continue;
    const packageName = packageNameOf(specifier);
    if (specifier.startsWith("node:") || nodeBuiltins.has(packageName)) {
      builtinImports.push(where);
    } else if (!declaredDeps.has(packageName)) {
      undeclaredImports.push({ ...where, packageName });
    }
  }
}

// The build sets `skipLibCheck` so a dependency's declarations are not checked
// against the core's bare lib, which also stops checking the package's own
// declarations. Re-check just those with the flag off. A package declaration
// may legitimately name a dependency's types, so the dependency's own files
// can still enter this program — keeping their errors out is the job of the
// in-package filter on the diagnostics below, not of the seeding.
const ownDeclarations = closure.filter(
  (f) => isInPackage(f) && f.endsWith(".d.ts"),
);
if (ownDeclarations.length === 0) {
  setupErrors.push(
    "no package declaration files are in the closure — globals.d.ts is what bounds the core's host surface, so it must be reachable and checked.",
  );
}
const declarationDiagnostics = ts
  .getPreEmitDiagnostics(
    ts.createProgram({
      rootNames: ownDeclarations,
      options: { ...parsed.options, skipLibCheck: false },
    }),
  )
  .filter((d) => d.file && isInPackage(path.resolve(d.file.fileName)))
  .map((d) => {
    const { line } = d.file.getLineAndCharacterOfPosition(d.start ?? 0);
    return `${path.relative(pkgDir, d.file.fileName)}:${line + 1} ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`;
  });

// And every file on disk under src/ must be in the closure — an orphan would
// be typechecked (and lint-guarded) only loosely, never by this gate.
const onDisk = readdirSync(srcDir, {
  recursive: true,
  withFileTypes: true,
})
  .filter((d) => d.isFile() && /\.(ts|tsx|mts|cts|js|mjs)$/.test(d.name))
  .map((d) => path.resolve(d.parentPath ?? d.path, d.name));
const orphans = onDisk.filter((f) => !closureSet.has(f));

if (
  setupErrors.length > 0 ||
  declarationDiagnostics.length > 0 ||
  unlisted.length > 0 ||
  stale.length > 0 ||
  escapees.length > 0 ||
  undeclaredImports.length > 0 ||
  builtinImports.length > 0 ||
  ambientReferences.length > 0 ||
  orphans.length > 0
) {
  for (const message of setupErrors) {
    console.error(message);
  }
  for (const message of declarationDiagnostics) {
    console.error(`${message} (in a package declaration file)`);
  }
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
  for (const { file, specifier, packageName } of undeclaredImports) {
    console.error(
      `${file} imports '${specifier}', but '${packageName}' is not a declared dependency of @beaver/agent-core.`,
    );
  }
  for (const { file, specifier } of builtinImports) {
    console.error(
      `${file} imports the Node builtin '${specifier}' — the core must not assume a Node runtime.`,
    );
  }
  for (const { file, kind, name } of ambientReferences) {
    console.error(
      `${file} has a /// <reference ${kind}="${name}" /> directive — the core declares its host globals in globals.d.ts, not by pulling in ambient types.`,
    );
  }
  for (const f of orphans) {
    console.error(
      `on disk under src/ but not in the closure: ${path.relative(pkgDir, f)}`,
    );
  }
  // First match wins, so the summary names the most fundamental failure when
  // one problem cascades into another.
  const summaries = [
    [
      setupErrors,
      "agent-core's standalone typecheck is not set up the way the package claims — fix the manifest or tsconfig above.",
    ],
    [
      declarationDiagnostics,
      "agent-core's own declarations do not typecheck — an unresolved type there silently becomes `any` wherever it is used.",
    ],
    [
      [...undeclaredImports, ...builtinImports, ...ambientReferences],
      "agent-core imports something it does not declare — drop the import or add the dependency to packages/agent-core/package.json.",
    ],
    [
      escapees,
      "agent-core reaches outside the package — remove the offending import.",
    ],
    [
      orphans,
      "agent-core has files outside the entry closure — wire them into the protocol or remove them.",
    ],
  ];
  console.error(
    summaries.find(([items]) => items.length > 0)?.[1] ??
      "agent-core `files` drifted from the real closure — update the list to match.",
  );
  process.exit(1);
}
console.log(`agent-core closure verified: ${listedSet.size} files.`);
