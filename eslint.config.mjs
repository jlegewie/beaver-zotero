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
];

/**
 * Import bans for the L1 core. The `react/` specifiers are matched with a
 * `**` prefix because the package always reaches the app graph through a
 * path that carries a `react/` segment.
 */
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
    // across clients. It may use the host registry (`react/host`) but must NOT
    // touch the `Zotero` global or import the Zotero host implementation / prefs
    // directly — those couplings go through `getHost()`.
    // See docs-zotero/client-host-architecture.md.
    {
        files: [
            "react/components/citations/**/*.{ts,tsx}",
            "react/components/sources/CitedSourcesList.tsx",
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
            // The tool-call header label is now pure (Zotero data arrives via the
            // view model / itemData host slice); ToolCallPartView resolves request-
            // side display names through getHost(), not the Zotero global.
            "react/components/agentRuns/ToolCallPartView.tsx",
            "react/agents/toolLabels.ts",
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
                        "The citation render layer must stay client-agnostic — use getHost() (react/host) for Zotero-specific behavior.",
                },
            ],
            "no-restricted-imports": [
                "error",
                {
                    patterns: [
                        {
                            group: ["**/host/zotero/*", "**/host/zotero"],
                            message:
                                "Render layer must use the host registry (react/host), not the Zotero implementation (react/host/zotero).",
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
            "no-restricted-imports": ["error", { patterns: l1CoreImportBans }],
            "no-restricted-syntax": ["error", ...l1CoreAmbientTypeBan],
        },
    },
);
