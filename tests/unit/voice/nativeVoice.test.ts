import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NativeVoice } from "../../../src/services/voice/nativeVoice";
import { DevelopmentVoiceHarness } from "../../../src/services/voice/developmentHarness";

const packaged = vi.hoisted(() => ({
    enabled: false,
    create: vi.fn(),
    ensure: vi.fn(),
    dispose: vi.fn(),
}));
vi.mock("../../../src/services/voice/helperInstaller", () => ({
    createPackagedHelperInstaller: () => {
        packaged.create();
        return { ensure: packaged.ensure, dispose: packaged.dispose };
    },
}));

const socket = vi.hoisted(() => ({
    create: vi.fn(),
    dispose: vi.fn(),
    handle: undefined as any,
}));
vi.mock("../../../src/services/voice/voiceSocket", () => ({
    VoiceSocket: class {
        port = 12345;
        constructor(_clock: unknown, handle: unknown) {
            socket.create();
            socket.handle = handle;
        }
        dispose() {
            socket.dispose();
        }
    },
}));
vi.mock("../../../src/utils/prefs", () => ({
    getPref: (key: string) =>
        key === "voice.nativeEnabled" ? packaged.enabled : true,
    setPref: vi.fn(),
}));

const clock = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: any) => clearTimeout(id),
};
const path = "/test/Beaver Voice Input.app";
let native: NativeVoice;
let harness: DevelopmentVoiceHarness;
let launch: string[];
let launchFails: boolean;
let verifyFails: boolean;
let owner: Window;
const settle = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

beforeEach(() => {
    vi.useFakeTimers();
    packaged.enabled = false;
    packaged.create.mockReset();
    packaged.ensure.mockReset().mockResolvedValue(path);
    packaged.dispose.mockReset();
    socket.create.mockReset();
    socket.dispose.mockReset();
    launchFails = verifyFails = false;
    launch = [];
    let id = 0;
    vi.stubGlobal("__env__", "development");
    vi.stubGlobal("Zotero", {
        ...Zotero,
        isMac: true,
        Utilities: { randomString: () => `native-test-${++id}` },
    });
    vi.stubGlobal("Cu", { now: Date.now });
    vi.stubGlobal("Cc", {
        "@mozilla.org/security/random-generator;1": {
            createInstance: () => ({
                generateRandomBytes: () => new Uint8Array(32),
            }),
        },
    });
    vi.stubGlobal("Ci", { nsIRandomGenerator: {} });
    vi.stubGlobal("ChromeUtils", {
        importESModule: (name: string) =>
            name.includes("Timer.sys")
                ? clock
                : {
                      Subprocess: {
                          call: async (options: {
                              command: string;
                              arguments: string[];
                          }) => {
                              const opening =
                                  options.command === "/usr/bin/open";
                              if (opening) launch = options.arguments;
                              return {
                                  stdout: { readString: async () => "" },
                                  stderr: { readString: async () => "" },
                                  kill: vi.fn(),
                                  wait: async () => ({
                                      exitCode: (
                                          opening ? launchFails : verifyFails
                                      )
                                          ? 1
                                          : 0,
                                  }),
                              };
                          },
                      },
                  },
    });
    const target = new EventTarget();
    owner = Object.assign(target, {
        closed: false,
        document: { hasFocus: () => true },
    }) as unknown as Window;
    native = new NativeVoice();
    harness = new DevelopmentVoiceHarness(clock, native);
});
afterEach(() => {
    harness.service.dispose();
    native.dispose();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

it("opens no socket at startup or for an unverified helper", async () => {
    expect(native.available).toBe(false);
    expect(socket.create).not.toHaveBeenCalled();
    verifyFails = true;
    await expect(native.setDevelopmentHelper(path)).rejects.toThrow(
        "process failed",
    );
    expect(socket.create).not.toHaveBeenCalled();
});

it("keeps synthetic capture usable after socket creation fails and allows registration retry", async () => {
    socket.create.mockImplementationOnce(() => {
        throw new Error("socket unavailable");
    });
    await expect(native.setDevelopmentHelper(path)).rejects.toThrow(
        "socket unavailable",
    );
    expect(native.available).toBe(false);
    harness.run({ command: "enable", enabled: true });
    harness.start("fake", async () => ({
        userId: "fake",
        credential: "fake-only",
    }));
    await settle();
    expect(harness.run({ command: "frame" }).state.frameCount).toBe(1);
    await native.setDevelopmentHelper(path);
    expect(native.available).toBe(true);
});

it("invalidates granted permission on same-path registration without opening another socket", async () => {
    await native.setDevelopmentHelper(path);
    const setup = native.prepareMicrophone(owner);
    await settle();
    const sessionId = launch[launch.indexOf("--session") + 1];
    const token = launch[launch.indexOf("--token") + 1];
    expect(launch).toContain("--permission-only");
    for (const [eventSequence, event] of [
        { type: "hello", helperVersion: 2 },
        { type: "permission", status: "granted" },
        { type: "permission_done", status: "granted" },
    ].entries()) {
        expect(
            socket.handle({
                headers: { authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    version: 1,
                    sessionId,
                    eventSequence,
                    ...event,
                }),
            }).status,
        ).toBe(200);
    }
    expect(await setup).toBe("granted");
    await native.setDevelopmentHelper(path);
    expect(native.permission).toBe("unknown");
    expect(socket.create).toHaveBeenCalledTimes(1);
});

it.each(["launch failure", "startup timeout", "owner unload"])(
    "returns actionable setup failure on %s and releases the lease",
    async (reason) => {
        await native.setDevelopmentHelper(path);
        launchFails = reason === "launch failure";
        const setup = harness.startNative(owner);
        await settle();
        if (reason === "startup timeout")
            await vi.advanceTimersByTimeAsync(30000);
        if (reason === "owner unload") owner.dispatchEvent(new Event("unload"));
        expect(await setup).toMatchObject({
            error: { code: "unavailable" },
            help: expect.stringContaining("helper is installed"),
        });
        expect(harness.service.controller.getSnapshot().phase).toBe("idle");
        expect(vi.getTimerCount()).toBe(0);
        launchFails = false;
        const retry = harness.startNative(owner);
        await settle();
        owner.dispatchEvent(new Event("unload"));
        expect(await retry).toHaveProperty("error.code", "unavailable");
    },
);

it("refuses helper replacement while a native lease is active", async () => {
    await native.setDevelopmentHelper(path);
    const capture = native.createCapture(
        { version: 1, sessionId: "active" },
        () => {},
    );
    await expect(native.setDevelopmentHelper(path)).rejects.toThrow(
        "unavailable",
    );
    capture.dispose();
    await expect(native.setDevelopmentHelper(path)).resolves.toBeUndefined();
});

it("keeps packaged installation lazy and gated, then initializes it once", async () => {
    expect(packaged.create).not.toHaveBeenCalled();
    await expect(native.ensurePackagedHelper()).rejects.toThrow("disabled");
    expect(packaged.create).not.toHaveBeenCalled();
    expect(socket.create).not.toHaveBeenCalled();
    packaged.enabled = true;
    await Promise.all([
        native.ensurePackagedHelper(),
        native.ensurePackagedHelper(),
    ]);
    expect(packaged.create).toHaveBeenCalledTimes(1);
    expect(packaged.ensure).toHaveBeenCalledTimes(1);
    expect(socket.create).toHaveBeenCalledTimes(1);
    expect(native.permission).toBe("unknown");
});

it("does not open a socket after disposal during packaged extraction", async () => {
    packaged.enabled = true;
    let complete!: (path: string) => void;
    packaged.ensure.mockImplementation(
        () =>
            new Promise((resolve) => {
                complete = resolve;
            }),
    );
    const pending = native.ensurePackagedHelper();
    native.dispose();
    complete(path);
    await expect(pending).rejects.toThrow("unavailable");
    expect(socket.create).not.toHaveBeenCalled();
    expect(packaged.dispose).toHaveBeenCalledOnce();
});

it("retries failed packaged extraction without native resources leaking", async () => {
    packaged.enabled = true;
    packaged.ensure.mockRejectedValueOnce(new Error("corrupt"));
    await expect(native.ensurePackagedHelper()).rejects.toThrow("corrupt");
    expect(socket.create).not.toHaveBeenCalled();
    await native.ensurePackagedHelper();
    expect(native.available).toBe(true);
});

it("rechecks the package and feature gate before each native launch", async () => {
    packaged.enabled = true;
    await native.ensurePackagedHelper();
    packaged.enabled = false;
    const setup = harness.startNative(owner);
    await settle();
    expect(await setup).toHaveProperty("error.code", "unavailable");
    expect(launch).toEqual([]);
    packaged.enabled = true;
    packaged.ensure.mockRejectedValueOnce(new Error("corrupt cache"));
    const second = harness.startNative(owner);
    await settle();
    expect(await second).toHaveProperty("error.code", "unavailable");
    expect(launch).toEqual([]);
});

it("does not initialize after the feature is disabled during extraction", async () => {
    packaged.enabled = true;
    packaged.ensure.mockImplementation(async () => {
        packaged.enabled = false;
        return path;
    });
    await expect(native.ensurePackagedHelper()).rejects.toThrow("unavailable");
    expect(socket.create).not.toHaveBeenCalled();
});

it("does not launch after the feature is disabled during cached verification", async () => {
    packaged.enabled = true;
    await native.ensurePackagedHelper();
    packaged.ensure.mockImplementation(async () => {
        packaged.enabled = false;
        return path;
    });
    const setup = harness.startNative(owner);
    await settle();
    expect(await setup).toHaveProperty("error.code", "unavailable");
    expect(launch).toEqual([]);
});

it("refreshes a packaged path between sessions without creating another listener", async () => {
    packaged.enabled = true;
    await native.ensurePackagedHelper();
    packaged.ensure.mockResolvedValue("/updated/Beaver Voice Input.app");
    await native.ensurePackagedHelper();
    expect((native as any).helperPath).toBe("/updated/Beaver Voice Input.app");
    expect(socket.create).toHaveBeenCalledOnce();
    const lease = native.createCapture(
        { version: 1, sessionId: "busy" },
        () => {},
    );
    await expect(native.ensurePackagedHelper()).rejects.toThrow("busy");
    lease.dispose();
});

it("recovers on the next start when the artifact changes during launch", async () => {
    packaged.enabled = true;
    await native.ensurePackagedHelper();
    packaged.ensure.mockResolvedValue("/updated/Beaver Voice Input.app");
    await expect(harness.startNative(owner)).resolves.toHaveProperty(
        "error.code",
        "unavailable",
    );
    const retry = harness.startNative(owner);
    await settle();
    expect(launch).toContain("/updated/Beaver Voice Input.app");
    owner.dispatchEvent(new Event("unload"));
    await retry;
});
