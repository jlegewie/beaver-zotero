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
            "react/components/agentRuns/refChipRendering.tsx",
            "react/components/agentRuns/requestChips/**/*.{ts,tsx}",
            "react/components/input/AskUserQuestionPanel.tsx",
            "react/components/messages/NoteDisplay.tsx",
            // The tool-call header label is now pure (Zotero data arrives via the
            // view model / itemData host slice); ToolCallPartView resolves request-
            // side display names through getHost(), not the Zotero global.
            "react/components/agentRuns/ToolCallPartView.tsx",
            "react/agents/toolLabels.ts",
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
);
