#!/usr/bin/env node
/**
 * Guards what the esbuild bundle is allowed to pull out of `react/`.
 *
 * `src/index.ts` is bundled by esbuild into `content/scripts/beaver.js` and
 * loaded into a plain Zotero subscript scope: no `process`, no React, no Jotai
 * store. A `src/` module that imports — directly or, far more easily, through
 * three hops of "shared" helper — anything that reaches `react/store`,
 * `react/atoms/*`, `supabaseClient` or `process.env` makes that file throw
 * while it is being evaluated. The plugin then does not load *at all*:
 * `Zotero.Beaver` stays undefined, no panes mount, no `/beaver/test/*` endpoint
 * is registered.
 *
 * Nothing else catches it. `tsc --noEmit`, both package gates, every unit test
 * and `zotero-plugin build` all pass, because the import is perfectly valid
 * TypeScript and perfectly valid for the *webpack* bundle. The only signal is a
 * dead plugin at runtime. So the graph itself is asserted here, against a
 * checked-in allowlist, and any change to it has to be a deliberate edit to
 * this file.
 *
 * Run: `npm run check:bundle`.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every `react/` module the esbuild bundle is allowed to contain.
 *
 * These are the deliberate, esbuild-safe exceptions `src/hooks.ts` imports —
 * the event bus, the UI manager and the plain data/constant modules they reach.
 * Adding a line here is a claim that the module and its whole import closure
 * are free of React, the Jotai store and `process`. Verify that before you
 * add one; a wrong entry here is exactly the failure this script exists for.
 */
const ALLOWED_REACT_INPUTS = [
    'react/constants/versionUpdateMessages.ts',
    'react/eventBus.ts',
    'react/events/eventManager.ts',
    'react/types/archivedActions.ts',
    'react/types/builtinActions.ts',
    'react/ui/UIManager.ts',
    'react/ui/initialization.ts',
    'react/utils/zoteroLayout.ts',
];

/**
 * Modules whose presence proves the React graph got in, named individually so
 * the failure message can point at the actual problem rather than at a diff of
 * a hundred file names. Kept alongside the allowlist because a future
 * allowlist edit could hide the general check while these stay damning.
 */
const FORBIDDEN_INPUTS = [
    'react/store.ts',
    'react/atoms/agentRunAtoms.ts',
    'react/atoms/profile.ts',
];

/**
 * Modules that must stay **out** of the esbuild bundle for a reason other than
 * `process`: they keep module-level state whose correctness depends on there
 * being one copy.
 *
 * `tableStore.ts` owns the single-flight lock that serialises every write to a
 * stored table. It is single only because the store imports the
 * library-exclusion check and through it the React graph, which keeps it
 * webpack-only. Pulled into esbuild there would be two lock maps and no
 * serialisation between a user edit and an agent write — silently, with every
 * test still green.
 */
const WEBPACK_ONLY_INPUTS = [
    'src/services/artifacts/tableStore.ts',
    'src/services/artifacts/tableItem.ts',
];

const HELP = `
What this means in practice:

  The plugin does not load. \`beaver.js\` throws while being evaluated
  (typically \`process is not defined\` or a missing React/Jotai global),
  so \`Zotero.Beaver\` is undefined, the React panes never mount and no
  /beaver/test/* endpoint is registered. Nothing else in CI catches this:
  tsc, typecheck:core, typecheck:ui, the unit tests and the build all pass.

How to fix it:

  1. Find the import chain:
       npx esbuild src/index.ts --bundle --metafile=/tmp/meta.json \\
         --outfile=/dev/null --target=firefox115
     then look up the offending file's \`imports\` in /tmp/meta.json to see
     which \`src/\` module pulled it in.
  2. Break the chain. Usually the fix is to split the react-reaching part
     out of the shared module (as \`tableItem.ts\` /
     \`tableItemIdentity.ts\` do) and have the esbuild-side caller import
     the react-free half.
  3. Only if the new module is genuinely react-free — no React, no Jotai
     store, no \`process\`, nothing transitively reaching them — add it to
     ALLOWED_REACT_INPUTS in scripts/check-esbuild-graph.mjs.
`;

function fail(lines) {
    console.error(`\n\u2716 check:bundle — the esbuild bundle's react/ graph changed.\n`);
    for (const line of lines) console.error(`  ${line}`);
    console.error(HELP);
    process.exit(1);
}

const result = await build({
    entryPoints: [resolve(root, 'src/index.ts')],
    absWorkingDir: root,
    bundle: true,
    write: false,
    metafile: true,
    // Mirrors the main esbuild entry in zotero-plugin.config.ts. `NODE_ENV`
    // matters: a `process.env.NODE_ENV` branch that survives undefined is the
    // very thing this checks for.
    target: 'firefox115',
    define: {
        __env__: `"${process.env.NODE_ENV ?? 'production'}"`,
        'process.env.NODE_ENV': `"${process.env.NODE_ENV ?? 'production'}"`,
    },
    outfile: resolve(root, '.scaffold/check-bundle/beaver.js'),
    logLevel: 'error',
});

const inputs = Object.keys(result.metafile.inputs).map((p) => p.split('\\').join('/'));
const reactInputs = inputs.filter((p) => p.startsWith('react/')).sort();

const allowed = new Set(ALLOWED_REACT_INPUTS);
const added = reactInputs.filter((p) => !allowed.has(p));
const removed = ALLOWED_REACT_INPUTS.filter((p) => !reactInputs.includes(p));
const forbidden = FORBIDDEN_INPUTS.filter((p) => inputs.includes(p));

// A surviving `process.env` in the emitted bundle is the failure itself, not a
// proxy for it: `process` does not exist in the subscript scope, so evaluating
// that line throws and the plugin never starts. The `NODE_ENV` reads are
// substituted by `define` above, so anything left is a genuine escape. This is
// a raw text scan; a source string that merely *mentions* `process.env` would
// trip it, which is a fine trade for a check nothing else performs.
const bundleText = result.outputFiles?.[0]?.text ?? '';
const processEnvHits = [...bundleText.matchAll(/process\.env/g)].map((match) =>
    bundleText.slice(Math.max(0, match.index - 80), match.index + 40).replace(/\s+/g, ' ')
);

const webpackOnly = WEBPACK_ONLY_INPUTS.filter((p) => inputs.includes(p));

const problems = [];
if (webpackOnly.length) {
    problems.push('Webpack-only module(s) reached the esbuild bundle:');
    for (const p of webpackOnly) problems.push(`  - ${p}`);
    problems.push(
        '  These keep state that is only correct in one copy — tableStore.ts holds the'
    );
    problems.push(
        '  single-flight write lock. Two bundles means two locks and no serialisation.'
    );
    problems.push('');
}
if (processEnvHits.length) {
    problems.push(
        `${processEnvHits.length} \`process.env\` reference(s) survived into beaver.js:`
    );
    for (const hit of processEnvHits.slice(0, 5)) problems.push(`  … ${hit}`);
    problems.push('');
}
if (forbidden.length) {
    problems.push('The React app graph is in the esbuild bundle. Marker modules found:');
    for (const p of forbidden) problems.push(`  - ${p}`);
    problems.push('');
}
if (added.length) {
    problems.push(`${added.length} react/ module(s) entered the bundle:`);
    for (const p of added) problems.push(`  + ${p}`);
    problems.push('');
}
if (removed.length) {
    problems.push(
        `${removed.length} allowlisted react/ module(s) are no longer in the bundle ` +
            '(good news — remove them from ALLOWED_REACT_INPUTS):'
    );
    for (const p of removed) problems.push(`  - ${p}`);
}

if (problems.length) fail(problems);

console.log(
    `\u2713 check:bundle — esbuild bundle contains exactly the ${reactInputs.length} allowlisted ` +
        'react/ modules, no surviving `process.env`, and no webpack-only module.'
);
