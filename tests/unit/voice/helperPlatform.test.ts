import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPackagedHelperInstaller } from "../../../src/services/voice/helperInstaller";
import { VOICE_VERSION } from "@beaver/agent-core/voice/contracts";
import contract from "../../../native/voice/macos/contract.json";

const run = vi.hoisted(() => vi.fn());
vi.mock("../../../src/services/voice/voiceProcess", () => ({
    runVoiceProcess: run,
}));
beforeEach(() => {
    run.mockReset().mockImplementation(async (command: string) => {
        if (command.endsWith("sw_vers")) return "14.7";
        if (command.endsWith("uname")) return "arm64";
        if (command.endsWith("BeaverVoice"))
            return JSON.stringify({ ...contract, testing: false });
        return "";
    });
    vi.stubGlobal("__env__", "development");
    vi.stubGlobal("Zotero", {
        ...Zotero,
        Profile: { dir: "/profile" },
        version: "10.0",
        isMac: true,
    });
    vi.stubGlobal("PathUtils", {
        join: (...paths: string[]) => paths.join("/"),
    });
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
            ok: true,
            json: async () => ({
                schema: contract.schema,
                protocolVersion: contract.protocolVersion,
                helperVersion: contract.helperVersion,
                bundleId: contract.bundleId,
                version: "0.1.0",
                signing: "development",
                teamId: null,
                archiveBytes: 100,
                archiveSha256: "a".repeat(64),
                executableSha256: "b".repeat(64),
                plistSha256: "b".repeat(64),
            }),
        })),
    );
    vi.stubGlobal("IOUtils", {
        exists: async () => true,
        computeHexDigest: async () => "b".repeat(64),
        writeUTF8: async () => {},
        getChildren: async () => [],
    });
});
afterEach(() => vi.unstubAllGlobals());
it("memoizes platform discovery while revalidating the installed bundle on every launch", async () => {
    const installer = createPackagedHelperInstaller();
    await installer.ensure();
    await installer.ensure();
    const calls = (suffix: string) =>
        run.mock.calls.filter(([command]) => command.endsWith(suffix));
    expect(calls("sw_vers")).toHaveLength(1);
    expect(calls("uname")).toHaveLength(1);
    expect(calls("codesign")).toHaveLength(2);
    expect(calls("BeaverVoice")).toHaveLength(1);
});
it("retries failed platform discovery", async () => {
    run.mockRejectedValueOnce(new Error("process failed"));
    const installer = createPackagedHelperInstaller();
    await expect(installer.ensure()).rejects.toThrow("process failed");
    await expect(installer.ensure()).resolves.toContain(
        "Beaver Voice Input.app",
    );
});
it("keeps native protocol generation aligned with the portable wire protocol", () => {
    expect(contract.protocolVersion).toBe(VOICE_VERSION);
});

it("caches Gatekeeper only after full assessment and still verifies signatures", async () => {
    const response = await fetch("manifest");
    const manifest = await response.json();
    manifest.signing = "developer-id";
    manifest.teamId = "ABCDE12345";
    vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => manifest,
    } as Response);
    const installer = createPackagedHelperInstaller();
    await installer.ensure();
    await installer.ensure();
    expect(
        run.mock.calls.filter(([command]) => command.endsWith("spctl")),
    ).toHaveLength(1);
    expect(
        run.mock.calls.filter(([command]) => command.endsWith("codesign")),
    ).toHaveLength(2);
});
