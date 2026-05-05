/**
 * Dev-only HTTP handlers for cache inspection, MuPDF worker lifecycle,
 * file-status side-effect, and item resolution.
 *
 * Extracted from `useHttpEndpoints.ts`. Handler exports are wired to paths
 * in `useHttpEndpoints.ts` → `registerEndpoints()`.
 */


export async function handleTestPingHttpRequest(_request: any) {
    const cache = Zotero.Beaver?.attachmentFileCache;
    const db = Zotero.Beaver?.db;
    return {
        ok: true,
        cache_available: !!cache,
        db_available: !!db,
    };
}

export async function handleTestCacheMetadataHttpRequest(request: any) {
    const { library_id, zotero_key, item_id } = request;
    const db = Zotero.Beaver?.db;
    if (!db) return { error: 'db not available' };

    let record;
    if (item_id != null) {
        record = await db.getAttachmentFileCache(item_id);
    } else if (library_id != null && zotero_key != null) {
        record = await db.getAttachmentFileCacheByKey(library_id, zotero_key);
    } else {
        return { error: 'Provide item_id or library_id + zotero_key' };
    }
    return { record: record ?? null };
}

export async function handleTestCacheInvalidateHttpRequest(request: any) {
    const { library_id, zotero_key, item_id } = request;
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return { error: 'cache not available' };

    if (item_id != null && library_id != null && zotero_key != null) {
        await cache.invalidate(item_id, library_id, zotero_key);
    } else if (library_id != null && zotero_key != null) {
        // Resolve item_id from DB
        const db = Zotero.Beaver?.db;
        if (!db) return { error: 'db not available' };
        const record = await db.getAttachmentFileCacheByKey(library_id, zotero_key);
        if (record) {
            await cache.invalidate(record.item_id, library_id, zotero_key);
        } else {
            // No cache entry, nothing to invalidate
        }
    } else {
        return { error: 'Provide library_id + zotero_key (and optionally item_id)' };
    }
    return { ok: true };
}

export async function handleTestCacheClearMemoryHttpRequest(_request: any) {
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return { error: 'cache not available' };
    cache.clearMemoryCache();
    return { ok: true };
}

export async function handleTestCacheDeleteContentHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    const cache = Zotero.Beaver?.attachmentFileCache;
    if (!cache) return { error: 'cache not available' };
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    await cache.deleteContent(library_id, zotero_key);
    return { ok: true };
}

/**
 * Dev-only: snapshot of MuPDFWorkerClient dispatch / spawn counters and
 * the worker-side document cache.
 *
 * Lets manual-test runners (`docs-zotero/manual-tests-fused-worker-ops.md`)
 * verify "exactly one extractWithMeta dispatch", "no extra spawns", etc.
 * without log grepping. POST `{ reset: true }` to zero counters first.
 *
 * `cacheStats` is `null` when no worker has spawned yet — the call must
 * never spawn one or pollute `dispatchCounts`, so the doc-cache fields stay
 * absent until a real op has run.
 */
export async function handleTestWorkerStatsHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../../src/services/pdf/MuPDFWorkerClient'
    );
    const client = getMuPDFWorkerClient();
    if (request?.reset === true) {
        client.resetStats();
    }
    const stats = client.getStats();
    const cacheStats = await client.getCacheStats();
    return { ok: true, stats, cacheStats };
}

/**
 * Dev-only: terminate the current MuPDF worker as if it had died mid-flight.
 *
 * Drives the same `markStale` code path as a real worker death, so the next
 * `call()` either retries (if a request is in-flight) or respawns on the
 * next dispatch. Used by manual test 1.3.
 */
export async function handleTestWorkerMarkStaleHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../../src/services/pdf/MuPDFWorkerClient'
    );
    const reason = typeof request?.reason === 'string' ? request.reason : 'test';
    const client = getMuPDFWorkerClient();
    const before = client.getStats();
    client.markStaleForTest(reason);
    return { ok: true, before, after: client.getStats() };
}

/**
 * Dev-only: clear the worker-side document cache. By default also resets
 * the cache hit/miss/eviction counters so live tests can assert exact
 * values; pass `{ resetCounters: false }` to keep history.
 *
 * No-op when no worker has spawned yet (returns `cacheStats: null`).
 */
export async function handleTestWorkerCacheClearHttpRequest(request: any) {
    const { getMuPDFWorkerClient } = await import(
        '../../../src/services/pdf/MuPDFWorkerClient'
    );
    const client = getMuPDFWorkerClient();
    const resetCounters = request?.resetCounters !== false;
    const cacheStats = await client.clearWorkerCacheForTest({ resetCounters });
    return { ok: true, cacheStats };
}

/**
 * Dev-only: invoke `getAttachmentFileStatus(item, isPrimary)` directly.
 *
 * Manual tests 2.3 (step 3), 5.4, and 7.2 need to trigger the file-status
 * side-effect that, in production, runs from agent or sidebar flows. This
 * endpoint short-circuits the trigger so a runner can assert on the cache
 * write / log output that follows.
 */
export async function handleTestFileStatusHttpRequest(request: any) {
    const { getAttachmentFileStatus } = await import(
        '../../../src/services/agentDataProvider/utils'
    );
    const { library_id, zotero_key, is_primary } = request || {};
    if (library_id == null || zotero_key == null) {
        return { ok: false, error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
        library_id,
        zotero_key,
    );
    if (!item) return { ok: false, error: 'not_found' };
    if (!item.isAttachment()) return { ok: false, error: 'not_an_attachment' };
    const status = await getAttachmentFileStatus(item, is_primary !== false);
    return { ok: true, status };
}

export async function handleTestResolveItemHttpRequest(request: any) {
    const { library_id, zotero_key } = request;
    if (library_id == null || zotero_key == null) {
        return { error: 'Provide library_id + zotero_key' };
    }
    const item = await Zotero.Items.getByLibraryAndKeyAsync(library_id, zotero_key);
    if (!item) return { item_id: null, item_type: null };
    return {
        item_id: item.id,
        item_type: item.itemType,
        is_attachment: item.isAttachment(),
        parent_id: item.parentID || null,
        attachment_content_type: item.isAttachment() ? item.attachmentContentType : null,
    };
}
