/* global process, console */
// Gate for the @beaver/agent-ui package — the React layer shared between the
// Zotero plugin and the Word add-in. Same shape as agent-core's gate, with one
// structural difference: agent-core proves it has no host surface by starving
// its program of `lib` and `types`, and this package cannot do that, because
// React needs @types/react and a shared component renders into a real DOM. So
// where agent-core screens for known-bad values, this gate asserts the
// allow-list at its exact expected value — no zotero-types, no
// @types/office-js, no `_ZoteroTypes`, and nothing ambient beyond react and
// react-dom.
//
// Asserted properties:
//
// 0. The manifest is resolvable: every peer the package declares is pinned by
//    the repo root (the package is never installed on its own, so the
//    typecheck must see the version the plugin ships), the in-repo peer
//    @beaver/agent-core really is a sibling package, the subpath export map is
//    the one both clients rely on, and no stray install sits beside the
//    package.
// 1. The tsconfig `files` list matches the real import closure of the entry
//    points, in both directions: a package file reachable from an entry but
//    missing from the list fails, and a listed file no longer reachable fails.
//    `files` alone cannot enforce either — it seeds the program without
//    bounding it, and every listed file is in the program by construction.
// 2. No file in the closure lives outside the package, other than dependency
//    declarations under node_modules and the sibling agent-core package. This
//    is what catches a component reaching back into the host repo.
// 3. Every bare import specifier written by a package file names a dependency
//    the package declares, and never a Node builtin — the package runs in a
//    Zotero chrome window and in an Office task pane, neither of which is
//    Node. Because the declared set is exactly react / react-dom / jotai /
//    @beaver/agent-core, this is also what enforces "no external import
//    outside the allow-list". It is checked on specifiers rather than on
//    resolved paths because a single declared dependency pulls in the .d.ts
//    graph of packages this one never names, which must not have to be
//    enumerated here. Specifiers that name `node_modules` outright, and
//    `/// <reference>` directives of every kind, are rejected for the same
//    reason: each is a way to reach ambient declarations without naming a
//    dependency.
// 4. The compiler options that make the isolation meaningful hold their exact
//    allowed values — `types` is precisely react + react-dom, `lib` is
//    precisely ES2020 + DOM, `jsx` compiles for both clients' runtimes, and
//    `paths` maps nothing but the sibling agent-core. Without this, widening
//    any of them hands the package a whole host surface with every other check
//    still green.
// 5. Neither zotero-types nor @types/office-js is anywhere in the program, and
//    no package file names the `_ZoteroTypes` ambient namespace. Checks 3 and 4
//    already close the routes in, so this is the backstop that states the rule
//    directly rather than as a consequence.
// 6. Any .d.ts file the package owns typechecks with `skipLibCheck` off. The
//    build needs it on so a dependency's declarations are not checked against
//    this package's narrow lib, but that would otherwise stop checking the
//    package's own declarations and silently turn an unresolved type in one
//    into `any`. Unlike agent-core, having zero own declarations is the
//    expected state here and is not an error: agent-core's isolation rests on
//    its globals.d.ts, whereas this package deliberately declares no host
//    globals at all.
// 7. Every TypeScript file on disk under src/ is part of the closure, so an
//    orphan module cannot sit in the package outside this gate's typecheck.
//    Stylesheets under src/theme/ are excluded from that scan: they are shipped
//    assets, not part of the TS program (the Zotero build copies them into
//    addon/content/styles/, Word imports them through css-loader).
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(pkgDir, "src");
const repoRoot = path.resolve(pkgDir, "..", "..");
// The one in-repo package agent-ui may consume. It is a declared peer that is
// never installed, so it is resolved through the tsconfig `paths` mapping and
// treated like a dependency by the escapee check below.
const siblingCoreDir = path.join(repoRoot, "packages", "agent-core");
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
// In practice this package declares only peers: React, react-dom and jotai must
// be the consumer's single copy (a second React or a second jotai store means
// broken hooks and state the rest of the add-in cannot see), and agent-core is
// shared source rather than an install.
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
// root pins everything the package imports and the package has no install of
// its own.
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
// typecheck — and the webpack bundle, which compiles this package from source —
// resolves it from a hoisted copy nothing controls. @beaver/agent-core is the
// exception: it is the sibling package in this same repo, so "pinned" means
// "present on disk under packages/", which is checked instead.
const IN_REPO_PEER = "@beaver/agent-core";
for (const name of Object.keys(manifest.peerDependencies ?? {})) {
  if (name === IN_REPO_PEER) continue;
  if (!rootPinned.has(name)) {
    setupErrors.push(
      `peer dependency '${name}' is not pinned by the repo root — the typecheck would resolve it from a hoisted copy nothing pins.`,
    );
  }
}
if (!declaredDeps.has(IN_REPO_PEER)) {
  setupErrors.push(
    `${IN_REPO_PEER} must stay a declared peer dependency — it is the only other package agent-ui may consume, and dropping the declaration would make its imports look undeclared.`,
  );
} else if (!ts.sys.fileExists(path.join(siblingCoreDir, "package.json"))) {
  setupErrors.push(
    `${IN_REPO_PEER} is declared as a peer but packages/agent-core is not present — it is resolved from the sibling directory, not from an install.`,
  );
}
if (ts.sys.directoryExists(path.join(pkgDir, "node_modules"))) {
  setupErrors.push(
    "packages/agent-ui/node_modules exists — the package must resolve its dependencies from the repo root, or the typecheck stops reflecting the version the plugin ships. A second copy of React or jotai there would also break hooks in a consumer.",
  );
}

// The subpath export map both clients rely on. agent-core can use
// `"./*": "./src/*.ts"` because everything it ships is a .ts module; this
// package also ships .tsx components and .css stylesheets, so the pattern has
// to carry the extension from the specifier. tsc does not read `exports` for a
// path-mapped source package, so `typesVersions` is what makes the same
// subpaths resolve for a consumer's typecheck — the two must stay in step.
if (manifest.exports?.["./*"] !== "./src/*") {
  setupErrors.push(
    `package.json \`exports\` must be {"./*": "./src/*"}; it is ${JSON.stringify(manifest.exports)}. The package ships .tsx and .css alongside .ts, so the specifier carries the extension.`,
  );
}
const typesVersionsMap = manifest.typesVersions?.["*"]?.["*"];
if (
  !Array.isArray(typesVersionsMap) ||
  typesVersionsMap.length !== 1 ||
  typesVersionsMap[0] !== "src/*"
) {
  setupErrors.push(
    `package.json \`typesVersions\` must map "*" to ["src/*"]; it is ${JSON.stringify(manifest.typesVersions)}. Without it a consumer's tsc cannot resolve @beaver/agent-ui subpath imports.`,
  );
}

// Guards the tsconfig settings the isolation depends on. Each is pinned to its
// exact allowed value rather than screened for known-bad entries: `types` and
// `lib` each mean "everything available" when omitted, and each has more ways
// to name a host surface (WebWorker, ScriptHost, an ambient @types package, …)
// than a denylist can keep up with. Pinning them is also what keeps
// zotero-types and @types/office-js out of `types` by construction.
const ALLOWED_TYPES = ["react", "react-dom"];
const ALLOWED_LIBS = ["lib.es2020.d.ts", "lib.dom.d.ts"];
const sameSet = (actual, allowed) =>
  Array.isArray(actual) &&
  actual.length === allowed.length &&
  allowed.every((value) => actual.includes(value));
if (!sameSet(parsed.options.types, ALLOWED_TYPES)) {
  setupErrors.push(
    `tsconfig \`types\` must be exactly ${JSON.stringify(ALLOWED_TYPES)}; it is ${JSON.stringify(parsed.options.types)}. Omitting it makes every installed @types package ambient — zotero-types and @types/office-js included. A component that needs host behavior takes it as a prop or through the host registry.`,
  );
}
if (!sameSet(parsed.options.lib, ALLOWED_LIBS)) {
  setupErrors.push(
    `tsconfig \`lib\` must be exactly ${JSON.stringify(ALLOWED_LIBS)}; it is ${JSON.stringify(parsed.options.lib)}. DOM is here because shared components render into a document; anything beyond it (WebWorker, ScriptHost, …) is a host surface this package must not assume.`,
  );
}
// See the tsconfig comment: the classic runtime is the intersection of the two
// consumers' JSX transforms, so every .tsx file must import React explicitly.
if (parsed.options.jsx !== ts.JsxEmit.React) {
  setupErrors.push(
    'tsconfig `jsx` must be "react" (the classic runtime). beaver-zotero transforms JSX with @babel/preset-react in its default classic mode, so a file that omits `import React from \'react\'` compiles here and then fails at runtime there. "react" is what forces the import that works in both clients.',
  );
}
// The only path mapping allowed. Anything else would be a route back into the
// host repo that the escapee check below could not distinguish from the
// sibling package.
const pathKeys = Object.keys(parsed.options.paths ?? {});
if (
  pathKeys.length !== 1 ||
  pathKeys[0] !== `${IN_REPO_PEER}/*` ||
  !sameSet(parsed.options.paths?.[pathKeys[0]], ["../agent-core/src/*"])
) {
  setupErrors.push(
    `tsconfig \`paths\` must map only "${IN_REPO_PEER}/*" to ["../agent-core/src/*"]; it is ${JSON.stringify(parsed.options.paths)}. It exists so the one in-repo peer resolves standalone, not as a general escape hatch.`,
  );
}

// The roots the closure is computed from. Everything else in `files` must be
// reachable from these, so an ambient .d.ts added to `files` cannot silently
// widen the program.
//
// Each root is a module a client imports directly and nothing inside the
// package imports. The icon barrel is one such root: it re-exports every icon,
// so all of them are reachable from it. The individual icons are deliberately
// NOT roots — a client may import one by its own subpath, but the barrel already
// imports it, and listing it here would only cost the orphan signal that catches
// it dropping out of the closure. The primitive barrel is the same shape: the
// primitives are imported by subpath in practice, and some import each other,
// so the barrel is what makes every one of them reachable on purpose rather
// than by way of a sibling that could stop importing it. The host barrel is a
// root because nothing else in the package imports the registry — a client and
// a shared component both reach it from outside.
const entryPaths = [
  "src/icons/index.tsx",
  "src/primitives/index.ts",
  "src/host/index.ts",
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
// agent-core is a declared peer whose files live in the repo rather than in
// node_modules, so for this gate's purposes they are dependency declarations.
// Its own gate (`npm run typecheck:core`) is what bounds them.
const isSiblingCore = (f) => f.startsWith(siblingCoreDir + path.sep);

const closureSet = new Set(closure);
// `files` describes the package's own surface, so the two-way match is scoped
// to in-package files; a dependency's .d.ts graph is never listed.
const unlisted = closure.filter((f) => isInPackage(f) && !listedSet.has(f));
const stale = listed.filter((f) => !closureSet.has(f));
// Even a listed-and-reachable file must live inside the package — a shared
// component must not reach back into either client's repo. Dependency
// declarations and the sibling agent-core are the only legitimate ways to be
// outside it.
const escapees = closure.filter(
  (f) => !isInPackage(f) && !isDependency(f) && !isSiblingCore(f),
);

// The ambient type packages that must never enter the program, by name. `types`
// and the specifier rule already close the routes in; this states the rule
// directly, so it still fails if either of those is ever relaxed.
const BANNED_TYPE_PACKAGES = ["zotero-types", "@types/office-js", "office-js"];
const bannedAmbientFiles = closure.filter((f) => {
  const segments = path.relative(repoRoot, f).split(path.sep);
  const at = segments.lastIndexOf("node_modules");
  if (at === -1) return false;
  const scoped = segments[at + 1]?.startsWith("@")
    ? `${segments[at + 1]}/${segments[at + 2]}`
    : segments[at + 1];
  return BANNED_TYPE_PACKAGES.includes(scoped);
});

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

// Every `_ZoteroTypes` reference a file makes, in value or type position — the
// namespace is an identifier in both, including inside a qualified name like
// `_ZoteroTypes.Item`. Walking identifiers rather than matching text keeps a
// comment or a string that merely mentions the name from failing the gate.
function collectAmbientZoteroTypeUses(sourceFile) {
  const lines = [];
  const visit = (node) => {
    if (ts.isIdentifier(node) && node.text === "_ZoteroTypes") {
      lines.push(
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
          .line + 1,
      );
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return lines;
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
const ambientZoteroTypes = [];
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
  for (const line of collectAmbientZoteroTypeUses(sourceFile)) {
    ambientZoteroTypes.push({ file, line });
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
// against this package's narrow lib, which also stops checking any declarations
// the package owns. Re-check just those with the flag off. Unlike agent-core,
// zero own declarations is the expected state and not an error: this package has
// no globals.d.ts because it declares no host globals — a component that needs
// host behavior takes it as a prop or through the host registry. The check
// exists for the day a shared .d.ts does appear. A package declaration may
// legitimately name a dependency's types, so the dependency's own files can
// still enter this program — keeping their errors out is the job of the
// in-package filter on the diagnostics below, not of the seeding.
const ownDeclarations = closure.filter(
  (f) => isInPackage(f) && f.endsWith(".d.ts"),
);
const declarationDiagnostics =
  ownDeclarations.length === 0
    ? []
    : ts
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

// And every TypeScript file on disk under src/ must be in the closure — an
// orphan would be typechecked (and lint-guarded) only loosely, never by this
// gate. Stylesheets are intentionally not matched: src/theme/*.css is shipped
// as an asset (copied into addon/content/styles/ for Zotero, imported through
// css-loader by Word) and is not part of any TypeScript program.
const onDisk = readdirSync(srcDir, {
  recursive: true,
  withFileTypes: true,
})
  .filter((d) => d.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(d.name))
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
  ambientZoteroTypes.length > 0 ||
  bannedAmbientFiles.length > 0 ||
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
      `${file} imports '${specifier}', but '${packageName}' is not a declared dependency of @beaver/agent-ui.`,
    );
  }
  for (const { file, specifier } of builtinImports) {
    console.error(
      `${file} imports the Node builtin '${specifier}' — the package runs in a Zotero chrome window and an Office task pane, neither of which is Node.`,
    );
  }
  for (const { file, kind, name } of ambientReferences) {
    console.error(
      `${file} has a /// <reference ${kind}="${name}" /> directive — the package must not pull in ambient types; a component takes host behavior as a prop or through the host registry.`,
    );
  }
  for (const { file, line } of ambientZoteroTypes) {
    console.error(
      `${file}:${line} names the ambient \`_ZoteroTypes\` namespace — the package has to typecheck without zotero-types.`,
    );
  }
  for (const f of bannedAmbientFiles) {
    console.error(
      `a banned ambient type package is in the program: ${path.relative(repoRoot, f)}`,
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
      "agent-ui's standalone typecheck is not set up the way the package claims — fix the manifest or tsconfig above.",
    ],
    [
      declarationDiagnostics,
      "agent-ui's own declarations do not typecheck — an unresolved type there silently becomes `any` wherever it is used.",
    ],
    [
      [...ambientZoteroTypes, ...bannedAmbientFiles],
      "agent-ui reaches a client's ambient types — it must typecheck with neither zotero-types nor @types/office-js present.",
    ],
    [
      [...undeclaredImports, ...builtinImports, ...ambientReferences],
      "agent-ui imports something it does not declare — drop the import or add the dependency to packages/agent-ui/package.json.",
    ],
    [
      escapees,
      "agent-ui reaches outside the package — remove the offending import.",
    ],
    [
      orphans,
      "agent-ui has files outside the entry closure — wire them into an entry point or remove them.",
    ],
  ];
  console.error(
    summaries.find(([items]) => items.length > 0)?.[1] ??
      "agent-ui `files` drifted from the real closure — update the list to match.",
  );
  process.exit(1);
}
console.log(`agent-ui closure verified: ${listedSet.size} files.`);
