import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import webpack from "webpack";
import makeWebpackConfig from "../../../webpack.config.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** Packages in the Markdown pipeline that decode named character references. */
const importers = [
    "micromark",
    "micromark-core-commonmark",
    "micromark-util-decode-string",
    "mdast-util-from-markdown",
];

type Resolver = ReturnType<webpack.Compiler["resolverFactory"]["get"]>;
let resolver: Resolver;

beforeAll(() => {
    // Vitest sets NODE_ENV=test, which the build refuses to pair with a mode.
    vi.stubEnv("NODE_ENV", undefined);
    vi.stubEnv("BUILD_ENV", undefined);
    try {
        const compiler = webpack(makeWebpackConfig({}, { mode: "development" }));
        resolver = compiler.resolverFactory.get("normal", { dependencyType: "esm" });
    } finally {
        vi.unstubAllEnvs();
    }
});

/** Resolves the decoder the way the React bundle does, from `importer`. */
function resolveFrom(importer: string): Promise<string> {
    return new Promise((resolve, reject) => {
        resolver.resolve(
            {},
            path.join(root, "node_modules", importer),
            "decode-named-character-reference",
            {},
            (error: Error | null, result?: string | false) =>
                error || !result ? reject(error ?? new Error("unresolved")) : resolve(result),
        );
    });
}

describe("webpack entity decoder", () => {
    // The browser build assigns `&name;` to `innerHTML`, which throws in
    // Zotero's XHTML windows for any entity but the five XML built-ins.
    it.each(importers)("bundles the table-based decoder for %s", async (importer) => {
        const resolved = await resolveFrom(importer);
        expect(path.basename(resolved)).toBe("index.js");
    });

    it("decodes named entities without a DOM", async () => {
        const resolved = await resolveFrom("micromark");
        const { decodeNamedCharacterReference } = await import(resolved);
        expect(decodeNamedCharacterReference("rsquo")).toBe("’");
        expect(decodeNamedCharacterReference("nbsp")).toBe(" ");
        expect(decodeNamedCharacterReference("notarealentity")).toBe(false);
    });
});
