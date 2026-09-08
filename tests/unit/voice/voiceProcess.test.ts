import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runVoiceProcess } from "../../../src/services/voice/voiceProcess";

let child: {
    stdout: { readString: ReturnType<typeof vi.fn> };
    stderr: { readString: ReturnType<typeof vi.fn> };
    wait: ReturnType<typeof vi.fn>;
    kill: ReturnType<typeof vi.fn>;
};
let exit: (result: { exitCode: number }) => void;
beforeEach(() => {
    vi.useFakeTimers();
    const result = new Promise((resolve) => {
        exit = resolve;
    });
    child = {
        stdout: {
            readString: vi
                .fn()
                .mockResolvedValueOnce(" out")
                .mockResolvedValueOnce("put \n")
                .mockResolvedValue(""),
        },
        stderr: {
            readString: vi
                .fn()
                .mockResolvedValueOnce("diagnostic")
                .mockResolvedValueOnce(" more")
                .mockResolvedValue(""),
        },
        wait: vi.fn(() => result),
        kill: vi.fn(() => exit({ exitCode: -9 })),
    };
    vi.stubGlobal("ChromeUtils", {
        importESModule: (name: string) =>
            name.includes("Timer.sys")
                ? { setTimeout, clearTimeout }
                : { Subprocess: { call: async () => child } },
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it("drains both streams before waiting for exit and clears its deadline", async () => {
    const promise = runVoiceProcess("/usr/bin/open", []);
    await Promise.resolve();
    expect(child.stdout.readString).toHaveBeenCalledOnce();
    expect(child.stderr.readString).toHaveBeenCalledOnce();
    exit({ exitCode: 0 });
    await expect(promise).resolves.toBe("output");
    expect(child.stdout.readString).toHaveBeenCalledTimes(3);
    expect(child.stderr.readString).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
});
it("kills a stuck utility at the deadline", async () => {
    const promise = expect(
        runVoiceProcess("/usr/bin/codesign", []),
    ).rejects.toThrow("process failed");
    await vi.advanceTimersByTimeAsync(15000);
    await promise;
    expect(child.kill).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
});
it("releases the process after a pipe read fails", async () => {
    child.stderr.readString.mockRejectedValue(new Error("read failed"));
    await expect(runVoiceProcess("/usr/bin/open", [])).rejects.toThrow(
        "read failed",
    );
    expect(child.kill).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
});
it("does not include utility output or command arguments in failure messages", async () => {
    const promise = runVoiceProcess("/usr/bin/open", ["private-token"]);
    exit({ exitCode: 1 });
    await expect(promise).rejects.toThrow(/^Voice helper process failed$/);
});

it("bounds retained output and tolerates a rejected kill after exit", async () => {
    child.stdout.readString
        .mockReset()
        .mockResolvedValueOnce("x".repeat(1024 * 1024 + 1))
        .mockResolvedValue("");
    child.kill.mockRejectedValue(new Error("already exited"));
    exit({ exitCode: 0 });
    await expect(runVoiceProcess("/test", [])).rejects.toThrow(
        "output exceeded limit",
    );
    expect(vi.getTimerCount()).toBe(0);
});
