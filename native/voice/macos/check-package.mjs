import contract from "./contract.json" with { type: "json" };
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Check the opaque archive at the final asset boundary, before XPI assembly. */
export function checkVoicePackage(addon, development, required = false) {
    const dir = join(addon, "content/voice");
    if (!existsSync(dir)) {
        if (required) throw new Error("Required voice package missing");
        return;
    }
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    const bytes = readFileSync(join(dir, "macos.zip"));
    if (
        !m ||
        typeof m.version !== "string" ||
        !/^\d+\.\d+\.\d+$/.test(m.version) ||
        !Number.isInteger(m.archiveBytes) ||
        m.archiveBytes < 1 ||
        m.archiveBytes > 32 * 1024 * 1024 ||
        ![m.executableSha256, m.plistSha256].every(
            (value) =>
                typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
        ) ||
        m.schema !== contract.schema ||
        m.protocolVersion !== contract.protocolVersion ||
        m.helperVersion !== contract.helperVersion ||
        m.bundleId !== contract.bundleId ||
        m.archiveBytes !== bytes.length ||
        m.archiveSha256 !== createHash("sha256").update(bytes).digest("hex") ||
        !(
            (m.signing === "developer-id" &&
                /^[A-Z0-9]{10}$/.test(m.teamId || "")) ||
            (development && m.signing === "development" && m.teamId === null)
        )
    )
        throw new Error(
            "Invalid voice package or development helper in production build",
        );
}
