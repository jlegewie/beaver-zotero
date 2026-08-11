// @ts-check Let TS check this config file

import path from "node:path";
import { fileURLToPath } from "node:url";

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/** Resolves ambiguous project roots when nested copies (e.g. .claude/worktrees) exist. */
const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

/** Globals banned everywhere — use the Zotero-aware accessors instead. */
const restrictedGlobals = [
    { message: "Use `Zotero.getMainWindow()` instead.", name: "window" },
    { message: "Use `Zotero.getMainWindow().document` instead.", name: "document" },
    { message: "Use `Zotero.getActiveZoteroPane()` instead.", name: "ZoteroPane" },
    "Zotero_Tabs",
];

const l1CoreGlobals = [
    ...restrictedGlobals,
    {
        name: "Zotero",
        message:
            "L1 core must stay client-agnostic — Zotero specifics belong behind an adapter module, not here.",
    },
    {
        name: "process",
        message:
            "L1 core must not read build-time config — not every host has a bundler that substitutes it. Register it with setTransportConfig() (transport/config) and read it there.",
    },
];

/**
 * Import bans for the L1 core. The `react/` specifiers are matched with a
 * `**` prefix because the package always reaches the app graph through a
 * path that carries a `react/` segment.
 */
/**
 * Packages the L1 core must never import by bare name. `jotai` is allowed only
 * through `jotai/vanilla`: its default entry re-exports the React bindings, and
 * the core has to run in clients that have no React.
 */
const l1CorePackageBans = [
    {
        name: "jotai",
        message: "L1 core must import from 'jotai/vanilla', not the React-bearing default entry.",
    },
    {
        name: "react",
        message: "L1 core must not import React — it has to run in clients that have no React.",
    },
    {
        name: "react-dom",
        message: "L1 core must not import React — it has to run in clients that have no React.",
    },
];

const l1CoreImportBans = [
    {
        group: ["**/agentDataProvider*", "**/agentDataProvider/**"],
        message: "L1 core must not import the Zotero data-provider handlers (agentDataProvider).",
    },
    {
        group: [
            "**/zoteroDataProvider",
            "**/zoteroClientIdentity",
            "**/zoteroSupabaseStorage",
            "**/zoteroRuntime",
            "**/EncryptedStorage",
            "**/zoteroUtils",
            "**/zoteroInstanceWire",
            "**/busyContext",
            "**/syncPause",
            "**/libraryIdentity",
            "**/utils/prefs",
            "**/host/zotero",
            "**/host/zotero/**",
        ],
        message:
            "L1 core must not import Zotero adapter modules directly — these exist to keep this layer client-agnostic.",
    },
    {
        group: ["**/react/atoms/*", "**/react/atoms/**"],
        message: "L1 core must not import Jotai atoms (react/atoms).",
    },
    {
        group: ["jotai/react", "jotai/react/**"],
        message:
            "L1 core must import from 'jotai/vanilla' — jotai's React entries pull in React, which the core must not require.",
    },
    {
        group: ["**/react/store"],
        message: "L1 core must not import the Jotai store (react/store).",
    },
    {
        group: ["**/react/utils/*", "**/react/utils/**"],
        message: "L1 core must not import react/utils — that pulls in the app graph.",
    },
    {
        group: ["**/react/hooks/*", "**/react/hooks/**"],
        message: "L1 core must not import React hooks (react/hooks).",
    },
    {
        group: ["**/react/components/*", "**/react/components/**"],
        message: "L1 core must not import React components (react/components).",
    },
];

/**
 * The `Zotero` global ban covers value references but not `zotero-types`
 * ambient TYPE namespaces, which are equally unavailable once the L1 core is
 * typechecked outside the Zotero plugin host.
 */
const l1CoreAmbientTypeBan = [
    {
        selector: 'Identifier[name="_ZoteroTypes"]',
        message:
            "L1 core must not use ambient Zotero types — it has to typecheck without zotero-types.",
    },
];

/**
 * Globals banned in the shared React layer (`packages/agent-ui`).
 *
 * Derived from `restrictedGlobals`, minus its `window` / `document` entries.
 * Those are banned repo-wide because Zotero plugin code runs across several
 * windows and must ask `Zotero.getMainWindow()` which one it is in — reasoning
 * that does not transfer here, since a shared component has no Zotero to ask.
 * The rule this package follows instead, which lint cannot express: derive the
 * window and document from an element (`ownerDocument` /
 * `ownerDocument.defaultView`) or from a prop, never from a global. A bare
 * `window` reference inside a component is a bug in a client that renders into
 * a second window — review for it.
 */
const l2UiGlobals = [
    { message: "Use `Zotero.getActiveZoteroPane()` instead.", name: "ZoteroPane" },
    "Zotero_Tabs",
    {
        name: "Zotero",
        message:
            "The shared React layer must stay client-agnostic — Zotero specifics belong behind the host registry, not here.",
    },
    {
        name: "Office",
        message:
            "The shared React layer must stay client-agnostic — Office specifics belong in the Word add-in, behind the host registry.",
    },
    {
        name: "Word",
        message:
            "The shared React layer must stay client-agnostic — Word specifics belong in the Word add-in, behind the host registry.",
    },
];

/**
 * The `Zotero` global ban above covers value references but not `zotero-types`
 * ambient TYPE namespaces, which are equally unavailable once the shared React
 * layer is typechecked outside the Zotero plugin host.
 */
const l2UiAmbientTypeBan = [
    {
        selector: 'Identifier[name="_ZoteroTypes"]',
        message:
            "The shared React layer must not use ambient Zotero types — it has to typecheck without zotero-types.",
    },
    // `no-restricted-globals` only sees a bare identifier reference, so
    // `(globalThis as unknown as { Zotero: … }).Zotero` slips past it while
    // reaching the same host surface. Screening the property name does not help —
    // a cast, a temporary or a computed key defeats any access-shape match — so
    // the identifier itself is banned. A shared component has no use for it.
    // `verify-program.mjs` rejects this too; this block is the fast local signal.
    {
        selector: 'Identifier[name="globalThis"]',
        message:
            "The shared React layer must not name `globalThis` — derive window/document from an element's ownerDocument, and reach host behavior through the host registry.",
    },
    // A `declare global` block inside the package hands it a host global while
    // every other check stays green.
    {
        selector: 'TSModuleDeclaration[global=true]',
        message:
            "The shared React layer must not declare a global — a global it declares is one the other client does not have.",
    },
];

/**
 * Import bans for the shared React layer. The `react` / `react-dom` / `jotai`
 * bans that apply to the L1 core are deliberately absent: this package is React
 * by definition. What it must not reach is either client's own graph — the
 * matched specifiers are all relative escapes out of `packages/agent-ui`, which
 * `verify-program.mjs` also rejects; this block is the fast local signal.
 */
const l2UiImportBans = [
    {
        // The registry itself lives in this package (`src/host/`), so any
        // specifier naming a `host/zotero` path from here is necessarily a
        // relative escape into the plugin's implementation of it.
        group: ["**/host/zotero", "**/host/zotero/**"],
        message:
            "The shared React layer defines the host registry; it must not import a client's implementation of it (react/host/zotero).",
    },
    {
        group: ["**/utils/prefs"],
        message:
            "The shared React layer must read config through the host registry, not Zotero prefs.",
    },
    {
        group: ["**/react/atoms/*", "**/react/atoms/**"],
        message:
            "The shared React layer must not import the Zotero plugin's Jotai atoms (react/atoms) — client-agnostic state belongs in @beaver/agent-core.",
    },
    {
        group: ["**/react/utils/*", "**/react/utils/**"],
        message:
            "The shared React layer must not import the Zotero plugin's react/utils — that pulls in the app graph.",
    },
    {
        group: ["**/src/services/*", "**/src/services/**"],
        message:
            "The shared React layer must not import the Zotero plugin's services (src/services).",
    },
];

export default tseslint.config(
    {
        ignores: [
            "build/**",
            ".scaffold/**",
            "node_modules/**",
            "scripts/",
            // Generated third-party WASM glue, checked in as-is.
            "addon/content/lib/mupdf-wasm.mjs",
            "addon/content/lib/sentencex/sentencex_wasm.js",
            // Generated webpack output (entry + chunks), present only after a build.
            "addon/content/*reactBundle.js",
            // Nested worktree checkouts (local dev only).
            ".claude/",
        ],
    },
    {
        extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
        languageOptions: {
            parserOptions: {
                tsconfigRootDir,
            },
        },
        rules: {
            "no-restricted-globals": ["error", ...restrictedGlobals],

            "@typescript-eslint/ban-ts-comment": [
                "warn",
                {
                    "ts-expect-error": "allow-with-description",
                    "ts-ignore": "allow-with-description",
                    "ts-nocheck": "allow-with-description",
                    "ts-check": "allow-with-description",
                },
            ],
            "@typescript-eslint/no-unused-vars": "off",
            "@typescript-eslint/no-explicit-any": [
                "off",
                {
                    ignoreRestArgs: true,
                },
            ],
            "@typescript-eslint/no-non-null-assertion": "off",
        },
    },
    // Tests run under node with stubbed globals, so the Zotero-window bans on
    // `window`/`document` do not apply, and bare property access is a
    // legitimate way to trigger the lazy getters under test.
    {
        files: ["tests/**/*.ts"],
        rules: {
            "no-restricted-globals": "off",
            "@typescript-eslint/no-unused-expressions": "off",
        },
    },
    // Manual-test scripts execute inside Zotero's chrome context, where these
    // are real globals and running in the window is the point.
    {
        files: ["tests/manual/scripts/**/*.js"],
        languageOptions: {
            globals: {
                Zotero: "readonly",
                IOUtils: "readonly",
                window: "readonly",
                setTimeout: "readonly",
                fetch: "readonly",
            },
        },
        rules: {
            "no-restricted-globals": "off",
        },
    },
    // The MuPDF worker bundle is a separate execution context: no DOM, no
    // window, no Zotero. It must not import the BeaverExtract index barrel (re-exports
    // BeaverExtractor, MuPDFService, the logger — none of which are
    // worker-safe) or any Beaver app utilities. Worker-safe internals
    // (analyzers, mappers) are still allowed via direct subpath imports like
    // `../StyleAnalyzer`, and the extract types via
    // `@beaver/agent-core/extract/*`.
    //
    // Path math reminder — relative specifiers from a file at
    // `src/beaver-extract/worker/<file>.ts`:
    //   ../X            → src/beaver-extract/X    (package internals — OK)
    //   ../../X         → src/X                   (Beaver app dirs)
    //   ../../../X      → repo-root/X             (e.g. `react/`)
    //   ../../../../X   → one level above repo root
    // Bare `@beaver/agent-core/...` specifiers also leave the directory; only
    // its extract/* subpaths are worker-safe (enforced below).
    {
        files: ["src/beaver-extract/worker/**/*.ts"],
        rules: {
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "../index",
                            message:
                                "Worker code must not import the PDF barrel.",
                        },
                        {
                            name: "../index.ts",
                            message:
                                "Worker code must not import the PDF barrel.",
                        },
                    ],
                    patterns: [
                        {
                            // src/utils/* — Beaver app utilities (logger, prefs, …).
                            group: ["../../utils/*"],
                            message:
                                "Worker code must not import Beaver app utilities (src/utils).",
                        },
                        {
                            // Anything reachable via `../..` leaves the
                            // package. Package internals are still allowed
                            // via `./X` and `../X`.
                            group: ["../../*", "../../**"],
                            message:
                                "Worker code must not leave src/beaver-extract. Use `./X` or `../X` for PDF-package internals only.",
                        },
                        {
                            // react/* — webpack-only bundle (DOM/Zotero APIs).
                            group: ["../../../react/*"],
                            message:
                                "Worker code must not import the webpack-only React bundle.",
                        },
                        {
                            // From agent-core, only the extract types are
                            // worker-safe; the protocol/transport layers are
                            // backend-facing app code.
                            group: [
                                "@beaver/agent-core/*",
                                "@beaver/agent-core/**",
                                "!@beaver/agent-core/extract",
                                "!@beaver/agent-core/extract/**",
                            ],
                            message:
                                "Worker code may import only @beaver/agent-core/extract/* from agent-core.",
                        },
                    ],
                },
            ],
        },
    },
    // The shared render layer must stay client-agnostic so it can be reused
    // across clients. It may use the host registry (`@beaver/agent-ui/host`) but
    // must NOT touch the `Zotero` global or import the Zotero host implementation
    // / prefs directly — those couplings go through `getHost()`.
    // See docs-zotero/client-host-architecture.md.
    {
        files: [
            // The citation stack (Citation, useCitationViewModel, CitedSourcesList)
            // graduated into packages/agent-ui and is covered by that package's own
            // block below, which is stricter.
            "react/components/agentRuns/toolResultViews/**/*.{ts,tsx}",
            // The tool-result dispatcher: renders only from hydrated view models and
            // a generic fallback (dev-mode check via getHost().config), no Zotero global.
            "react/components/agentRuns/ToolResultView.tsx",
            // Shared agent-run dispatchers + the request-side action fallback.
            "react/components/agentRuns/ModelResponseView.tsx",
            "react/components/agentRuns/AgentRunView.tsx",
            "react/components/agentRuns/GenericAgentActionView.tsx",
            "react/components/agentRuns/AgentRunFooter.tsx",
            "react/components/agentRuns/UserRequestView.tsx",
            "react/components/agentRuns/slashCommandRendering.tsx",
            "react/components/agentRuns/requestChips/**/*.{ts,tsx}",
            "react/components/messages/NoteDisplay.tsx",
            // ToolCallPartView resolves request-side display names through
            // getHost(), not the Zotero global. The label layer it calls lives in
            // the core and is covered by the stricter block below.
            "react/components/agentRuns/ToolCallPartView.tsx",
            // Pure thread-list helpers incl. the instance-mismatch check —
            // identities are passed in, never read from the Zotero global.
            "react/utils/threadMatches.ts",
        ],
        rules: {
            "no-restricted-globals": [
                "error",
                ...restrictedGlobals,
                {
                    name: "Zotero",
                    message:
                        "The citation render layer must stay client-agnostic — use getHost() (@beaver/agent-ui/host) for Zotero-specific behavior.",
                },
            ],
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["**/host/zotero/*", "**/host/zotero"],
                            message:
                                "Render layer must use the host registry (@beaver/agent-ui/host), not the Zotero implementation (react/host/zotero).",
                        },
                        {
                            group: ["**/utils/prefs"],
                            message:
                                "Render layer must read config via getHost().config, not Zotero prefs.",
                        },
                    ],
                },
            ],
        },
    },
    // The L1 core (wire protocol, transport, backend clients) stays free of the
    // Zotero global and the React/Jotai app graph, so it can be consumed by a
    // non-Zotero client. Zotero behavior reaches it through the injectable
    // adapter modules rather than a direct import. See
    // docs-zotero/client-decoupling-plan.md.
    //
    // The core lives in packages/agent-core/src, so one path covers it.
    {
        files: ["packages/agent-core/src/**/*.ts"],
        rules: {
            "no-restricted-globals": ["error", ...l1CoreGlobals],
            "no-restricted-imports": [
                "error",
                { paths: l1CorePackageBans, patterns: l1CoreImportBans },
            ],
            "no-restricted-syntax": ["error", ...l1CoreAmbientTypeBan],
        },
    },
    // The shared React layer (theme, icons, primitives, render components) is
    // consumed by the Zotero plugin and the Word add-in from the same source, so
    // it must not name either host. Client behavior reaches it through the host
    // registry or a prop. `npm run typecheck:ui` is the stronger gate — it
    // typechecks the package standalone with no Zotero and no Office types and
    // verifies its whole import closure stays inside the package — but it only
    // sees files in the tsconfig `files` list; this block covers every file in
    // the package as you write it. See docs-zotero/client-host-architecture.md.
    {
        files: ["packages/agent-ui/src/**/*.{ts,tsx}"],
        rules: {
            "no-restricted-globals": ["error", ...l2UiGlobals],
            "no-restricted-imports": ["error", { patterns: l2UiImportBans }],
            "no-restricted-syntax": ["error", ...l2UiAmbientTypeBan],
        },
    },
);
