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

/**
 * Modules that must not reach for Zotero or the app graph themselves. Adding a
 * file here asserts that of the file, not of everything it imports: a listed
 * module may still call a helper that reads `Zotero` internally
 * (`libraryIdentity.ts` does today). Those belong behind an adapter, and until
 * they are, the guard catches the direct regression rather than the
 * transitive one.
 *
 * `busyContext.ts` and `syncPause.ts` are absent because they read Zotero's
 * live sync, DB transaction, lock, and full-text-index state directly — guarded
 * files reach their snapshots/hooks through the `busyContextProvider.ts` /
 * `agentDataDispatch.ts` seams instead, enforced by the import ban below.
 */
const l1CoreSrcFiles = [
    "src/services/agentProtocol.ts",
    "src/services/agentService.ts",
    "src/services/providerConnection.ts",
    "src/services/apiService.ts",
    "src/services/supabaseClient.ts",
    "src/services/agentDataDispatch.ts",
    "src/services/clientIdentity.ts",
    "src/services/busyContextProvider.ts",
    "src/services/threadService.ts",
    "src/services/accountService.ts",
    "src/services/chatService.ts",
    "src/services/agentActionsService.ts",
    "src/services/embeddingsService.ts",
    "src/services/searchService.ts",
    "src/services/diagnosticsService.ts",
    "src/services/connectionFailure.ts",
    "src/services/preparedJsonMessage.ts",
    "src/services/backendReachability.ts",
    "src/services/attachmentLimits.ts",
    "src/services/agentActionQueue.ts",
    "src/utils/libraryRef.ts",
    "src/utils/logger.ts",
    "src/utils/getAPIBaseURL.ts",
];

const l1CoreReactTypeFiles = ["react/types/customChatModel.ts", "react/types/models.ts"];

const l1CoreGlobals = [
    ...restrictedGlobals,
    {
        name: "Zotero",
        message:
            "L1 core must stay client-agnostic — Zotero specifics belong behind an adapter module, not here.",
    },
];

/** Import bans for the L1 core. `reactPrefix` is how the guarded file reaches `react/`. */
const l1CoreImportBans = (reactPrefix) => [
    {
        group: ["**/agentDataProvider*", "**/agentDataProvider/**"],
        message: "L1 core must not import the Zotero data-provider handlers (agentDataProvider).",
    },
    {
        group: [
            "**/zoteroDataProvider",
            "**/zoteroClientIdentity",
            "**/zoteroSupabaseStorage",
            "**/EncryptedStorage",
            "**/zoteroUtils",
            "**/zoteroInstanceWire",
            "**/busyContext",
            "**/syncPause",
        ],
        message:
            "L1 core must not import Zotero adapter modules directly — these exist to keep this layer client-agnostic.",
    },
    {
        group: [`${reactPrefix}/atoms/*`, `${reactPrefix}/atoms/**`],
        message: "L1 core must not import Jotai atoms (react/atoms).",
    },
    {
        group: [`${reactPrefix}/store`],
        message: "L1 core must not import the Jotai store (react/store).",
    },
    {
        group: [`${reactPrefix}/utils/*`, `${reactPrefix}/utils/**`],
        message: "L1 core must not import react/utils — that pulls in the app graph.",
    },
    {
        group: [`${reactPrefix}/hooks/*`, `${reactPrefix}/hooks/**`],
        message: "L1 core must not import React hooks (react/hooks).",
    },
    {
        group: [`${reactPrefix}/components/*`, `${reactPrefix}/components/**`],
        message: "L1 core must not import React components (react/components).",
    },
];

export default tseslint.config(
    {
        ignores: ["build/**", ".scaffold/**", "node_modules/**", "scripts/"],
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
    // The MuPDF worker bundle is a separate execution context: no DOM, no
    // window, no Zotero. It must not import the BeaverExtract index barrel (re-exports
    // BeaverExtractor, MuPDFService, the logger — none of which are
    // worker-safe) or any Beaver app utilities. Worker-safe internals
    // (analyzers, types, mappers) are still allowed via direct subpath
    // imports like `../types`, `../StyleAnalyzer`.
    //
    // Path math reminder — relative specifiers from a file at
    // `src/beaver-extract/worker/<file>.ts`:
    //   ../X            → src/beaver-extract/X    (package internals — OK)
    //   ../../X         → src/X                   (Beaver app dirs)
    //   ../../../X      → repo-root/X             (e.g. `react/`)
    //   ../../../../X   → one level above repo root
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
    // Zotero global and the React/Jotai app graph, so it can be extracted into a
    // package a non-Zotero client also consumes. Zotero behavior reaches it
    // through the injectable adapter modules rather than a direct import. See
    // docs-zotero/client-decoupling-plan.md.
    //
    // Two blocks, because the react/* bans depend on how deep the guarded file
    // sits: from src/** the specifier carries a `react/` segment, while from
    // react/types a sibling is just `../utils/*` — and that shorter form would
    // otherwise also match the src/utils helpers src/services legitimately uses.
    {
        files: l1CoreSrcFiles,
        rules: {
            "no-restricted-globals": ["error", ...l1CoreGlobals],
            "no-restricted-imports": [
                "error",
                { patterns: l1CoreImportBans("**/react") },
            ],
        },
    },
    {
        files: l1CoreReactTypeFiles,
        rules: {
            "no-restricted-globals": ["error", ...l1CoreGlobals],
            "no-restricted-imports": [
                "error",
                { patterns: l1CoreImportBans("..") },
            ],
        },
    },
);
