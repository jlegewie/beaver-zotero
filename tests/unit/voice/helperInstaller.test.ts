import { beforeEach, expect, it, vi } from "vitest";
import {
    HelperInstaller,
    validateHelperManifest,
    type HelperInstallerHost,
} from "../../../src/services/voice/helperInstaller";

const manifest = () => ({
    schema: 1,
    protocolVersion: 1,
    helperVersion: 2,
    bundleId: "ai.beaverapp.voice",
    version: "0.1.0",
    signing: "development",
    teamId: null,
    archiveSha256: "a".repeat(64),
    archiveBytes: 4096,
    executableSha256: "b".repeat(64),
    plistSha256: "c".repeat(64),
});
let host: HelperInstallerHost;
let installer: HelperInstaller;
beforeEach(() => {
    host = {
        manifest: vi.fn(async () => manifest()),
        checkPlatform: vi.fn(async () => {}),
        exists: vi.fn(async () => false),
        stage: vi.fn(async () => {}),
        verify: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        touch: vi.fn(async () => {}),
        cleanup: vi.fn(async () => {}),
        unique: () => "unique",
    };
    installer = new HelperInstaller(host, "/voice", true);
});
it("publishes only after verification and coalesces simultaneous requests", async () => {
    const first = installer.ensure();
    expect(installer.ensure()).toBe(first);
    expect(await first).toBe(`/voice/${"a".repeat(64)}/Beaver Voice Input.app`);
    expect(host.verify).toHaveBeenCalledWith(
        "/voice/staging-unique",
        manifest(),
    );
    expect(vi.mocked(host.verify).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(host.move).mock.invocationCallOrder[0],
    );
    expect(host.remove).toHaveBeenCalledWith("/voice/staging-unique");
});
it("revalidates cached installs without overwriting them", async () => {
    vi.mocked(host.exists).mockResolvedValue(true);
    await installer.ensure();
    await installer.ensure();
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.stage).not.toHaveBeenCalled();
    expect(host.move).not.toHaveBeenCalled();
});
it.each(["stage", "verify", "move"] as const)(
    "cleans staging and permits retry after %s fails",
    async (method) => {
        vi.mocked(host[method]).mockRejectedValueOnce(new Error("invalid"));
        await expect(installer.ensure()).rejects.toThrow("invalid");
        expect(host.remove).toHaveBeenCalledExactlyOnceWith(
            "/voice/staging-unique",
        );
        expect(host.touch).not.toHaveBeenCalled();
        await expect(installer.ensure()).resolves.toContain(
            "Beaver Voice Input.app",
        );
    },
);
it("rejects a corrupt cached helper without deleting previous versions", async () => {
    vi.mocked(host.exists).mockResolvedValue(true);
    vi.mocked(host.verify).mockRejectedValue(new Error("corrupt"));
    await expect(installer.ensure()).rejects.toThrow("corrupt");
    expect(host.remove).toHaveBeenCalledExactlyOnceWith(
        "/voice/staging-unique",
    );
    expect(host.cleanup).not.toHaveBeenCalled();
});
it("does not publish or activate after disposal during extraction", async () => {
    vi.mocked(host.stage).mockImplementation(async () => {
        installer.dispose();
    });
    await expect(installer.ensure()).rejects.toThrow("disposed");
    expect(host.move).not.toHaveBeenCalled();
    expect(host.touch).not.toHaveBeenCalled();
    expect(host.remove).toHaveBeenCalled();
    await expect(installer.ensure()).rejects.toThrow("disposed");
});
it("keeps a valid install usable when obsolete-version cleanup fails", async () => {
    vi.mocked(host.cleanup).mockRejectedValue(new Error("locked"));
    await expect(installer.ensure()).resolves.toContain(
        "Beaver Voice Input.app",
    );
});
it("fails closed on ad-hoc signing in production", () => {
    expect(() => validateHelperManifest(manifest(), false)).toThrow();
    expect(
        validateHelperManifest(
            { ...manifest(), signing: "developer-id", teamId: "ABCDE12345" },
            false,
        ),
    ).toHaveProperty("signing", "developer-id");
});
it.each([
    { protocolVersion: 2 },
    { helperVersion: 1 },
    { schema: 2 },
    { archiveSha256: "../escape" },
    { archiveBytes: 33 * 1024 * 1024 },
    { archiveBytes: -1 },
    { bundleId: "ai.beaverapp.voice.tests" },
    { signing: "unsigned" },
    { version: "../1" },
    { signing: "developer-id", teamId: '" or true' },
    { plistSha256: "" },
])("rejects incompatible metadata %j before extraction", async (patch) => {
    vi.mocked(host.manifest).mockResolvedValue({ ...manifest(), ...patch });
    await expect(installer.ensure()).rejects.toThrow();
    expect(host.stage).not.toHaveBeenCalled();
});

it("rejects an unsupported platform before extracting or checking an installation", async () => {
    vi.mocked(host.checkPlatform).mockRejectedValue(new Error("unsupported"));
    await expect(installer.ensure()).rejects.toThrow("unsupported");
    expect(host.stage).not.toHaveBeenCalled();
    expect(host.exists).not.toHaveBeenCalled();
});

it("repairs a damaged install only after verifying one fresh extraction", async () => {
    vi.mocked(host.exists).mockResolvedValue(true);
    vi.mocked(host.verify).mockRejectedValueOnce(new Error("corrupt"));
    await expect(installer.ensure()).resolves.toContain(
        "Beaver Voice Input.app",
    );
    expect(host.verify).toHaveBeenCalledTimes(2);
    expect(host.stage).toHaveBeenCalledOnce();
    expect(host.remove).toHaveBeenCalledWith(`/voice/${"a".repeat(64)}`);
    expect(vi.mocked(host.verify).mock.invocationCallOrder[1]).toBeLessThan(
        vi.mocked(host.remove).mock.invocationCallOrder[0],
    );
});
