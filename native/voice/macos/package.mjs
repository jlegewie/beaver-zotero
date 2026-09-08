import contract from "./contract.json" with { type: "json" };
import process from "node:process";
import console from "node:console";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const development = process.argv.includes("--development");
const app = resolve(
    process.env.VOICE_APP ||
        `${root}/native/voice/macos/build/Beaver Voice Input.app`,
);
const output = resolve(
    process.env.VOICE_PACKAGE_DIR || `${root}/addon/content/voice`,
);
const run = (command, args) =>
    execFileSync(command, args, { encoding: "utf8" }).trim();
const hash = (path) =>
    createHash("sha256").update(readFileSync(path)).digest("hex");
const binary = `${app}/Contents/MacOS/BeaverVoice`;
const architectures = run("/usr/bin/lipo", ["-archs", binary])
    .split(/\s+/)
    .sort();
if (architectures.join(",") !== contract.architectures.join(","))
    throw new Error("Universal helper required");
const bundleId = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleIdentifier",
    `${app}/Contents/Info.plist`,
]);
if (bundleId !== contract.bundleId)
    throw new Error("Unexpected helper identity");
const version = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleShortVersionString",
    `${app}/Contents/Info.plist`,
]);
if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Expected a three-part helper version");
const teamId = development ? null : process.env.VOICE_TEAM_ID;
if (!development && !/^[A-Z0-9]{10}$/.test(teamId || ""))
    throw new Error("VOICE_TEAM_ID required");
const requirement =
    contract.identityRequirement +
    (development
        ? ""
        : contract.developerIdRequirement.replace("{teamId}", teamId));
run("/usr/bin/codesign", [
    "--verify",
    "--strict",
    "--all-architectures",
    "-R",
    requirement,
    app,
]);
if (!development) {
    run("/usr/bin/xcrun", ["stapler", "validate", app]);
    run("/usr/sbin/spctl", ["--assess", "--type", "execute", app]);
}
const info = JSON.parse(run(binary, ["--voice-info"]));
if (
    info.protocolVersion !== contract.protocolVersion ||
    info.helperVersion !== contract.helperVersion ||
    info.testing !== false
)
    throw new Error("Only the compatible production helper can be packaged");
mkdirSync(output, { recursive: true });
const archive = `${output}/macos.zip`;
rmSync(archive, { force: true });
// The inner archive is opaque to the XPI packer: ditto preserves modes and symlinks.
run("/usr/bin/ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    app,
    archive,
]);
const manifest = {
    schema: contract.schema,
    protocolVersion: contract.protocolVersion,
    helperVersion: contract.helperVersion,
    bundleId,
    version,
    signing: development ? "development" : "developer-id",
    teamId,
    archiveSha256: hash(archive),
    archiveBytes: readFileSync(archive).length,
    executableSha256: hash(binary),
    plistSha256: hash(`${app}/Contents/Info.plist`),
};
writeFileSync(
    `${output}/manifest.json`,
    JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
    `Packaged ${manifest.signing} universal voice helper: ${manifest.archiveSha256}`,
);
