import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import dotenv from "dotenv";

function readEnvironmentFile(name) {
    try {
        return dotenv.parse(readFileSync(new URL(name, import.meta.url)));
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
        return {};
    }
}

function localBackendUrl(value) {
    const message =
        "BEAVER_DEV_BACKEND_URL must be an HTTP(S) loopback origin (e.g. http://127.0.0.1:8001)";
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error(message);
    }
    if (
        !["http:", "https:"].includes(url.protocol) ||
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
    ) {
        throw new Error(message);
    }
    return url.origin;
}

/** Resolve identical backend configuration for both bundles and the graph gate. */
export function loadBuildEnvironment({
    mode,
    env = process.env,
    argv = process.argv,
} = {}) {
    if (mode && env.NODE_ENV && mode !== env.NODE_ENV) {
        throw new Error("Build mode and NODE_ENV disagree");
    }
    const development = argv.includes("serve") || argv.includes("--dev");
    const runtimeMode =
        env.NODE_ENV || mode || (development ? "development" : "production");
    const buildEnv = env.BUILD_ENV || runtimeMode;
    const file = readEnvironmentFile(`.env.${buildEnv}`);
    const values = { ...env, ...file };
    // Both bundlers resolve this from their checkout, never from the caller's cwd.
    if (runtimeMode === "development" && buildEnv === "development") {
        const local = readEnvironmentFile(".env.development.local");
        const override =
            env.BEAVER_DEV_BACKEND_URL ?? local.BEAVER_DEV_BACKEND_URL;
        if (override) values.API_BASE_URL = localBackendUrl(override);
    }
    const definitions = Object.fromEntries(
        [
            "API_BASE_URL",
            "SUPABASE_URL",
            "SUPABASE_ANON_KEY",
            "WEBAPP_BASE_URL",
        ].map((key) => [
            `process.env.${key}`,
            JSON.stringify(values[key] ?? ""),
        ]),
    );
    return { mode: runtimeMode, buildEnv, definitions };
}
