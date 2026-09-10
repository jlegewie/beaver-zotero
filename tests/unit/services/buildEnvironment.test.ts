import { afterEach, describe, expect, it, vi } from "vitest";
import pkg from "../../../package.json";
import webpackConfig from "../../../webpack.config.js";
import { loadBuildEnvironment } from "../../../build-env.mjs";

describe("shared build environment", () => {
    const env = {
        BUILD_ENV: "unit-test-missing-env-file",
        API_BASE_URL: "https://api.example.test",
        SUPABASE_URL: "https://auth.example.test",
    };
    it("produces identical service definitions for explicit webpack mode and scaffold dev mode", () => {
        const webpack = loadBuildEnvironment({
            mode: "development",
            env,
            argv: [],
        });
        const scaffold = loadBuildEnvironment({
            env,
            argv: ["build", "--dev"],
        });
        const graph = loadBuildEnvironment({
            env: { ...env, NODE_ENV: "development" },
            argv: [],
        });
        expect(webpack).toEqual(scaffold);
        expect(graph).toEqual(scaffold);
        expect(webpack.definitions["process.env.API_BASE_URL"]).toBe(
            JSON.stringify(env.API_BASE_URL),
        );
    });
    it("rejects contradictory modes instead of building two different backends", () => {
        expect(() =>
            loadBuildEnvironment({
                mode: "development",
                env: { ...env, NODE_ENV: "production" },
            }),
        ).toThrow("disagree");
    });
    it("selects production for build and development for serve with the same BUILD_ENV override", () => {
        expect(loadBuildEnvironment({ env, argv: ["build"] }).mode).toBe(
            "production",
        );
        expect(loadBuildEnvironment({ env, argv: ["serve"] }).mode).toBe(
            "development",
        );
        expect(loadBuildEnvironment({ env, argv: ["serve"] }).buildEnv).toBe(
            env.BUILD_ENV,
        );
    });
});


describe("development npm entry points", () => {
    afterEach(() => vi.unstubAllEnvs());
    it.each(["watch-react", "build-react"])("%s selects development in the real webpack config without NODE_ENV", (script) => {
        vi.stubEnv("NODE_ENV", undefined);
        vi.stubEnv("BUILD_ENV", undefined);
        const command = pkg.scripts[script as keyof typeof pkg.scripts];
        const mode = command.match(/--mode=(\w+)/)?.[1];
        expect(mode).toBe("development");
        const config = webpackConfig({}, {mode, watch: command.includes("--watch")});
        expect(config.mode).toBe("development");
        expect(config.devtool).toBe("inline-source-map");
        const definitions = config.plugins[0].definitions;
        expect(definitions["process.env.NODE_ENV"]).toBe('"development"');
        expect(definitions["process.env.BUILD_ENV"]).toBe('"development"');
        const scaffold = loadBuildEnvironment({argv: ["zotero-plugin", "serve"]});
        expect(scaffold.mode).toBe(config.mode);
        expect(definitions["process.env.API_BASE_URL"]).toBe(scaffold.definitions["process.env.API_BASE_URL"]);
    });
});
