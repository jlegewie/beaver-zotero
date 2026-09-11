import { readFileSync } from "node:fs";
import process from "node:process";
import { URL } from "node:url";
import dotenv from "dotenv";

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
    let file = {};
    try {
        file = dotenv.parse(
            readFileSync(new URL(`.env.${buildEnv}`, import.meta.url)),
        );
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
    const values = { ...env, ...file };
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
