import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import pkg from "../../../package.json";
import webpackConfig from "../../../webpack.config.js";
import { loadBuildEnvironment } from "../../../build-env.mjs";

vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

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
    it.each(["watch-react", "build-react"])(
        "%s selects development in the real webpack config without NODE_ENV",
        (script) => {
            vi.stubEnv("NODE_ENV", undefined);
            vi.stubEnv("BUILD_ENV", undefined);
            const command = pkg.scripts[script as keyof typeof pkg.scripts];
            const mode = command.match(/--mode=(\w+)/)?.[1];
            expect(mode).toBe("development");
            const config = webpackConfig(
                {},
                { mode, watch: command.includes("--watch") },
            );
            expect(config.mode).toBe("development");
            expect(config.devtool).toBe("inline-source-map");
            const definitions = config.plugins[0].definitions;
            expect(definitions["process.env.NODE_ENV"]).toBe('"development"');
            expect(definitions["process.env.BUILD_ENV"]).toBe('"development"');
            const scaffold = loadBuildEnvironment({
                argv: ["zotero-plugin", "serve"],
            });
            expect(scaffold.mode).toBe(config.mode);
            expect(definitions["process.env.API_BASE_URL"]).toBe(
                scaffold.definitions["process.env.API_BASE_URL"],
            );
        },
    );
});

describe("worktree backend override", () => {
    afterEach(() => vi.restoreAllMocks());

    function files(local = "") {
        const read = vi.mocked(fs.readFileSync).mockImplementation((path) => {
            return Buffer.from(
                String(path).endsWith(".local")
                    ? local
                    : "API_BASE_URL=https://default.example.test\nSUPABASE_URL=https://auth.example.test",
            );
        });
        return read;
    }

    function load(env = {}, mode = "development", argv: string[] = []) {
        return loadBuildEnvironment({ mode, env, argv });
    }

    it("uses the checkout override in both bundles and preserves auth configuration", () => {
        files("BEAVER_DEV_BACKEND_URL=http://127.0.0.1:8001/");
        const webpack = load();
        const scaffold = loadBuildEnvironment({ env: {}, argv: ["serve"] });
        expect(webpack).toEqual(scaffold);
        expect(webpack.definitions["process.env.API_BASE_URL"]).toBe(
            '"http://127.0.0.1:8001"',
        );
        expect(webpack.definitions["process.env.SUPABASE_URL"]).toBe(
            '"https://auth.example.test"',
        );
    });

    it("lets a shell override win over the local file and an empty value disable it", () => {
        files("BEAVER_DEV_BACKEND_URL=http://127.0.0.1:8001");
        expect(
            load({ BEAVER_DEV_BACKEND_URL: "http://localhost:8002" })
                .definitions["process.env.API_BASE_URL"],
        ).toBe('"http://localhost:8002"');
        expect(
            load({ BEAVER_DEV_BACKEND_URL: "" }).definitions[
                "process.env.API_BASE_URL"
            ],
        ).toBe('"https://default.example.test"');
    });

    it.each([
        ["production", "production"],
        ["production", "staging"],
        ["development", "staging"],
        ["production", "development"],
    ])("ignores overrides for mode %s and environment %s", (mode, buildEnv) => {
        const read = files("BEAVER_DEV_BACKEND_URL=invalid");
        expect(
            load(
                { BUILD_ENV: buildEnv, BEAVER_DEV_BACKEND_URL: "invalid" },
                mode,
            ).definitions["process.env.API_BASE_URL"],
        ).toBe('"https://default.example.test"');
        expect(
            read.mock.calls.some(([path]) => String(path).endsWith(".local")),
        ).toBe(false);
    });

    it.each([
        "http://example.com:8001",
        "file:///tmp/backend",
        "not-a-url",
        "http://localhost:8001/api",
        "http://user:pass@localhost:8001",
        "http://localhost:8001?token=x",
        "http://localhost:8001/#fragment",
        "http://localhost:99999",
    ])("rejects an invalid local backend: %s", (value) => {
        files();
        expect(() => load({ BEAVER_DEV_BACKEND_URL: value })).toThrow(
            "loopback origin",
        );
    });

    it("accepts IPv6 loopback", () => {
        files();
        expect(
            load({ BEAVER_DEV_BACKEND_URL: "http://[::1]:8001" }).definitions[
                "process.env.API_BASE_URL"
            ],
        ).toBe('"http://[::1]:8001"');
    });
});
