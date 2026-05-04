// @ts-check Let TS check this config file

import path from "node:path";
import { fileURLToPath } from "node:url";

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

/** Resolves ambiguous project roots when nested copies (e.g. .claude/worktrees) exist. */
const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

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
            "no-restricted-globals": [
                "error",
                { message: "Use `Zotero.getMainWindow()` instead.", name: "window" },
                {
                    message: "Use `Zotero.getMainWindow().document` instead.",
                    name: "document",
                },
                {
                    message: "Use `Zotero.getActiveZoteroPane()` instead.",
                    name: "ZoteroPane",
                },
                "Zotero_Tabs",
            ],
            
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
);
