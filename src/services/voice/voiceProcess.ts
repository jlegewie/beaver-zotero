/** Run a native voice utility with drained output and a bounded lifetime. */
export async function runVoiceProcess(
    command: string,
    args: string[],
): Promise<string> {
    const { Subprocess } = ChromeUtils.importESModule(
        "resource://gre/modules/Subprocess.sys.mjs",
    );
    const child = await Subprocess.call({
        command,
        arguments: args,
        stderr: "pipe",
    });
    const timer = ChromeUtils.importESModule(
        "resource://gre/modules/Timer.sys.mjs",
    );
    let expired = false;
    const deadline = timer.setTimeout(() => {
        expired = true;
        void Promise.resolve(child.kill()).catch(() => {});
    }, 15000);
    try {
        // Drain both pipes while the process runs to avoid a full-pipe deadlock.
        const [stdout, , result] = await Promise.all([
            drain(child.stdout, true),
            drain(child.stderr, false),
            child.wait(),
        ]);
        if (expired || result.exitCode !== 0)
            throw new Error("Voice helper process failed");
        return stdout.trim();
    } catch (error) {
        // A pipe-read failure must not orphan the utility after its deadline is cleared.
        void Promise.resolve(child.kill()).catch(() => {});
        await child.wait().catch(() => {});
        throw error;
    } finally {
        timer.clearTimeout(deadline);
    }
}

async function drain(pipe: { readString(): Promise<string> }, retain: boolean) {
    let output = "";
    for (let chunk; (chunk = await pipe.readString()); ) {
        if (retain) {
            if (output.length + chunk.length > 1024 * 1024)
                throw new Error("Voice helper output exceeded limit");
            output += chunk;
        }
    }
    return output;
}
