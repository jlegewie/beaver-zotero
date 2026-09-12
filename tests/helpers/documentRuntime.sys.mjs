/* global ChromeUtils */
/** Run only in an isolated test profile with a text-bearing PDF. Closes and reopens main windows. */
export async function run(z, bytes) {
    const { setTimeout } = ChromeUtils.importESModule(
        "resource://gre/modules/Timer.sys.mjs",
    );
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const result = (z.__beaverDocumentRuntimeCheck = {});
    let client;
    try {
        const first = z.getMainWindow();
        z.openMainWindow();
        for (let i = 0; i < 100; i++) {
            await pause(100);
            if (
                z.Beaver.runtime
                    .getSnapshot()
                    .filter((r) => r.status === "ready").length >= 2
            )
                break;
        }
        result.runtimes = z.Beaver.runtime.getSnapshot();
        result.windowsBefore = z.getMainWindows().length;
        const second = z.getMainWindows().find((w) => w !== first);
        if (!second) throw new Error("Second main window unavailable");
        result.independentRenderers =
            !!first.__beaverJotaiStore &&
            !!second.__beaverJotaiStore &&
            first.__beaverJotaiStore !== second.__beaverJotaiStore &&
            first.BeaverReact !== second.BeaverReact;
        if (!result.independentRenderers)
            throw new Error("Main windows share a renderer");
        client = z.__beaverMuPDFWorkerClient_hot;
        if (!client) {
            client = z.Beaver.documents.createClient("hot");
            z.__beaverMuPDFWorkerClient_hot = client;
        }
        await client.ping();
        const initialSpawns = client.getStats().spawnCount;
        const pending = client.extract(bytes, { mode: "structured" });
        result.pendingAtClose = client.inFlight;
        second.focus();
        first.close();
        result.firstCloseExtractionBytes = JSON.stringify(await pending).length;
        result.afterFirstClose = client.getStats();
        second.close();
        await pause(500);
        result.zeroWindows = z.getMainWindows().length;
        result.zeroExtractionBytes = JSON.stringify(
            await client.extract(bytes, { mode: "structured" }),
        ).length;
        result.afterZero = client.getStats();
        z.__beaverMuPDFWorkerClient_background?.dispose();
        const cold = z.Beaver.documents.createClient("background");
        z.__beaverMuPDFWorkerClient_background = cold;
        result.coldPages = await cold.getPageCount(bytes);
        result.coldStats = cold.getStats();
        result.lanesAtZero = z.Beaver.backgroundExtractor.getLaneStatus();
        client.setIdleTimeoutForTest(30);
        await client.ping();
        await pause(100);
        result.idleReapedAtZero = !client.hasWorker;
        await client.ping();
        result.respawnAtZero = client.getStats();
        client.setIdleTimeoutForTest(300000);
        if (
            result.zeroWindows !== 0 ||
            !result.idleReapedAtZero ||
            result.afterZero.spawnCount !== initialSpawns ||
            result.afterZero.retryCount !== result.afterFirstClose.retryCount ||
            result.respawnAtZero.spawnCount !== initialSpawns + 1
        ) {
            throw new Error("Document runtime lifecycle assertions failed");
        }
        result.finished = true;
    } catch (e) {
        result.error = String(e) + " " + e.stack;
    } finally {
        if (!z.getMainWindows().length) z.openMainWindow();
    }
}
