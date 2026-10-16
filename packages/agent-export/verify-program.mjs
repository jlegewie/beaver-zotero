/* global process, console */
// Gate for the @beaver/agent-export package — the client-agnostic export
// pipeline (source building, markdown parsing, citation data, file writers).
// Same shape as agent-core's and agent-ui's gates. Asserted properties:
//
// 0. The manifest is resolvable: every dependency is declared by the repo root
//    at the same range (the package is never installed on its own, so the
//    typecheck must see the version the plugin ships), the in-repo peer
//    @beaver/agent-core is a sibling package, the subpath export map is the
//    one consumers rely on, and no stray install sits beside the package.
// 1. The tsconfig `files` list matches the real import closure of the entry
//    points, in both directions, for files inside the package.
// 2. No file in the closure lives outside the package, other than dependency
//    declarations under node_modules and the sibling agent-core sources. This
//    is what catches the package reaching back into the plugin (`src/`,
//    `react/`) or into agent-ui.
// 3. Every bare import specifier names a declared dependency and never a Node
//    builtin — the writers run inside Zotero's plugin realm, not Node.
// 4. The compiler options that make the isolation meaningful hold their exact
//    values: `types` empty, `lib` exactly ES2020, `paths` mapping only the
//    sibling agent-core. A writer that needs a DOM or host global fails the
//    typecheck instead of failing at runtime in a realm that lacks it.
// 5. The only file listed from outside the package is agent-core's
//    globals.d.ts, which the agent-core sources compiled here rely on.
// 6. No zotero-types / office-js in the program, no `_ZoteroTypes`, no
//    `declare global`, no `globalThis`: host behavior reaches the pipeline as
//    data and callbacks from the host, never as a global.
// 7. Every TypeScript file on disk under src/ is part of the closure.
import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const pkgDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(pkgDir, "src");
const repoRoot = path.resolve(pkgDir, "..", "..");
const siblingCoreDir = path.join(repoRoot, "packages", "agent-core");
const siblingCoreSrc = path.join(siblingCoreDir, "src");
const coreGlobals = path.join(siblingCoreSrc, "globals.d.ts");
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

const manifest = JSON.parse(
  readFileSync(path.join(pkgDir, "package.json"), "utf8"),
);
const declaredDeps = new Set([
  ...Object.keys(manifest.dependencies ?? {}),
  ...Object.keys(manifest.peerDependencies ?? {}),
]);
const nodeBuiltins = new Set(builtinModules);
const setupErrors = [];

// Dependencies resolve from the repo root, so the root must pin each one at
// the range declared here.
const rootManifest = JSON.parse(
  readFileSync(path.join(repoRoot, "package.json"), "utf8"),
);
const rootDeps = rootManifest.dependencies ?? {};
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
const IN_REPO_PEER = "@beaver/agent-core";
for (const name of Object.keys(manifest.peerDependencies ?? {})) {
  if (name !== IN_REPO_PEER) {
    setupErrors.push(
      `peer dependency '${name}' is not allowed — the package's only peer is the sibling ${IN_REPO_PEER}; declare everything else as a dependency pinned by the root.`,
    );
  }
}
if (!declaredDeps.has(IN_REPO_PEER)) {
  setupErrors.push(`${IN_REPO_PEER} must stay a declared peer dependency.`);
} else if (!ts.sys.fileExists(path.join(siblingCoreDir, "package.json"))) {
  setupErrors.push(
    `${IN_REPO_PEER} is declared as a peer but packages/agent-core is not present.`,
  );
}
if (ts.sys.directoryExists(path.join(pkgDir, "node_modules"))) {
  setupErrors.push(
    "packages/agent-export/node_modules exists — the package must resolve its dependencies from the repo root.",
  );
}
if (manifest.type !== "module") {
  setupErrors.push('package.json must keep "type": "module".');
}
if (manifest.exports?.["./*"] !== "./src/*.ts") {
  setupErrors.push(
    `package.json \`exports\` must be {"./*": "./src/*.ts"}; it is ${JSON.stringify(manifest.exports)}.`,
  );
}

const sameSet = (actual, allowed) =>
  Array.isArray(actual) &&
  actual.length === allowed.length &&
  allowed.every((value) => actual.includes(value));
if (!Array.isArray(parsed.options.types) || parsed.options.types.length > 0) {
  setupErrors.push(
    `tsconfig \`types\` must be present and empty; it is ${JSON.stringify(parsed.options.types)}.`,
  );
}
if (!sameSet(parsed.options.lib, ["lib.es2020.d.ts"])) {
  setupErrors.push(
    `tsconfig \`lib\` must be exactly ["ES2020"]; it is ${JSON.stringify(parsed.options.lib)}. The writers run in realms without a DOM.`,
  );
}
for (const [flag, expected] of [
  ["strict", true],
  ["isolatedModules", true],
  ["forceConsistentCasingInFileNames", true],
  ["noEmit", true],
]) {
  if (parsed.options[flag] !== expected) {
    setupErrors.push(
      `tsconfig \`${flag}\` must be ${expected}; it is ${JSON.stringify(parsed.options[flag])}.`,
    );
  }
}
const pathKeys = Object.keys(parsed.options.paths ?? {});
if (
  pathKeys.length !== 1 ||
  pathKeys[0] !== `${IN_REPO_PEER}/*` ||
  !sameSet(parsed.options.paths?.[pathKeys[0]], ["../agent-core/src/*"])
) {
  setupErrors.push(
    `tsconfig \`paths\` must map only "${IN_REPO_PEER}/*" to ["../agent-core/src/*"]; it is ${JSON.stringify(parsed.options.paths)}.`,
  );
}

// The roots: modules a host imports directly and nothing in the package
// imports. `runtime.ts` is the lazily loaded bundle (parser + writers); the
// source and citation modules are imported by the host's main bundle and by
// the client that builds a source.
const entryPaths = [
  "src/runtime.ts",
  "src/source/buildSource.ts",
  "src/source/citationSnapshot.ts",
  "src/citations/citationTargets.ts",
  "src/citations/externalCsl.ts",
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
if (!listedSet.has(coreGlobals)) {
  setupErrors.push(
    "tsconfig `files` must list ../agent-core/src/globals.d.ts — the agent-core sources compiled here rely on its host globals.",
  );
}

const program = ts.createProgram({
  rootNames: [...entryPaths, coreGlobals],
  options: parsed.options,
});
const sourceFiles = program
  .getSourceFiles()
  .filter((sf) => !program.isSourceFileDefaultLibrary(sf));
const closure = sourceFiles.map((sf) => path.resolve(sf.fileName));
const closureSet = new Set(closure);

const isInPackage = (f) => f.startsWith(pkgDir + path.sep);
const isDependency = (f) =>
  path.relative(repoRoot, f).split(path.sep).includes("node_modules");
const isSiblingCore = (f) => f.startsWith(siblingCoreSrc + path.sep);

const unlisted = closure.filter((f) => isInPackage(f) && !listedSet.has(f));
const stale = listed.filter((f) => !closureSet.has(f));
const foreignListed = listed.filter((f) => !isInPackage(f) && f !== coreGlobals);
const escapees = closure.filter(
  (f) => !isInPackage(f) && !isDependency(f) && !isSiblingCore(f),
);

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
    if (specifier !== undefined) specifiers.add(specifier);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return specifiers;
}

function collectHostEscapes(sourceFile) {
  const found = [];
  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node) => {
    if (ts.isModuleDeclaration(node) && node.flags & ts.NodeFlags.GlobalAugmentation) {
      found.push({ kind: "declare global", line: lineOf(node) });
    }
    if (ts.isIdentifier(node) && (node.text === "globalThis" || node.text === "_ZoteroTypes")) {
      found.push({ kind: node.text, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function packageNameOf(specifier) {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
}

const undeclaredImports = [];
const builtinImports = [];
const ambientReferences = [];
const relativeEscapes = [];
const hostEscapes = [];
for (const sourceFile of sourceFiles) {
  const filePath = path.resolve(sourceFile.fileName);
  if (!isInPackage(filePath)) continue;
  const file = path.relative(pkgDir, filePath);
  for (const { fileName } of [
    ...sourceFile.typeReferenceDirectives,
    ...sourceFile.libReferenceDirectives,
    ...sourceFile.referencedFiles,
  ]) {
    ambientReferences.push({ file, name: fileName });
  }
  for (const escape of collectHostEscapes(sourceFile)) {
    hostEscapes.push({ file, ...escape });
  }
  for (const specifier of collectSpecifiers(sourceFile)) {
    const where = { file, specifier };
    if (specifier.split("/").includes("node_modules")) {
      undeclaredImports.push({ ...where, packageName: "node_modules" });
      continue;
    }
    if (specifier.startsWith(".") || path.isAbsolute(specifier)) {
      if (!isInPackage(path.resolve(path.dirname(filePath), specifier))) {
        relativeEscapes.push(where);
      }
      continue;
    }
    const packageName = packageNameOf(specifier);
    if (specifier.startsWith("node:") || nodeBuiltins.has(packageName)) {
      builtinImports.push(where);
    } else if (!declaredDeps.has(packageName)) {
      undeclaredImports.push({ ...where, packageName });
    }
  }
}

const ownDeclarations = closure.filter((f) => isInPackage(f) && f.endsWith(".d.ts"));
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

const onDisk = readdirSync(srcDir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile() && /\.(ts|tsx|mts|cts|js|jsx|mjs)$/.test(d.name))
  .map((d) => path.resolve(d.parentPath ?? d.path, d.name));
const orphans = onDisk.filter((f) => !closureSet.has(f));

const failures = [
  ...setupErrors,
  ...declarationDiagnostics.map((m) => `${m} (in a package declaration file)`),
  ...unlisted.map((f) => `reachable from the entry but not in tsconfig files: ${path.relative(pkgDir, f)}`),
  ...stale.map((f) => `listed in tsconfig files but not reachable from the entry: ${path.relative(pkgDir, f)}`),
  ...foreignListed.map((f) => `listed in tsconfig files but outside the package: ${f}`),
  ...escapees.map((f) => `in the closure but outside the package: ${f}`),
  ...bannedAmbientFiles.map((f) => `a banned ambient type package is in the program: ${path.relative(repoRoot, f)}`),
  ...undeclaredImports.map(
    ({ file, specifier, packageName }) =>
      `${file} imports '${specifier}', but '${packageName}' is not a declared dependency of @beaver/agent-export.`,
  ),
  ...builtinImports.map(
    ({ file, specifier }) => `${file} imports the Node builtin '${specifier}' — the pipeline runs in Zotero's plugin realm, not Node.`,
  ),
  ...ambientReferences.map(({ file, name }) => `${file} has a /// <reference> directive (${name}) — the package must not pull in ambient types.`),
  ...relativeEscapes.map(
    ({ file, specifier }) => `${file} imports '${specifier}', which resolves outside the package — use the sibling's package specifier.`,
  ),
  ...hostEscapes.map(
    ({ file, kind, line }) => `${file}:${line} uses \`${kind}\` — host behavior reaches the pipeline as data from the host, never as a global.`,
  ),
  ...orphans.map((f) => `on disk under src/ but not in the closure: ${path.relative(pkgDir, f)}`),
];

if (failures.length > 0) {
  for (const message of failures) console.error(message);
  console.error("agent-export's standalone gate failed — fix the problems above.");
  process.exit(1);
}
console.log(`agent-export closure verified: ${listedSet.size} files.`);
