/**
 * Short-lived in-worker document cache.
 *
 * Keeps an opened MuPDF `DocumentLike` alive for a short window after each op
 * so the next op against the same bytes reuses it. Multi-call patterns (one
 * handler firing `getPageCountAndLabels` + `getPageCount` + `extractWithMeta`
 * on the same `pdfData`) and back-to-back HTTP requests on the same
 * attachment skip the parse on every call after the first.
 *
 * Key — bytes identity via SHA-256 of the input bytes (Web Crypto, available
 *       in chrome workers). If `crypto.subtle` is missing the cache disables
 *       itself and `acquireDoc` falls through to `openDocUncached`.
 *
 * Capacity — small bounded LRU. Idle-only eviction; the at-most-one currently
 *            borrowed entry is never evicted. Oversized PDFs bypass the cache
 *            entirely.
 *
 * TTL — absolute deadline `expiresAt` set on release / hit. The `setTimeout`
 *       handle is a wake-up nudge: it enqueues a sweep onto the worker's FIFO
 *       queue; it never touches WASM. `sweepExpiredEntries` is the only place
 *       cached docs get destroyed (apart from `clearAllCachedDocs`), so all
 *       destruction stays serialized with WASM heap operations.
 */

import { openDocUncached } from "./docHelpers";
import type { DocumentLike } from "./mupdfApi";
import { enqueue } from "./opQueue";
import { postLog } from "./errors";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULTS = Object.freeze({
    maxEntries: 3,
    maxBytes: 200 * 1024 * 1024,
    ttlMs: 60_000,
});

interface CacheConfig {
    maxEntries: number;
    maxBytes: number;
    ttlMs: number;
}

let config: CacheConfig = { ...DEFAULTS };

/**
 * Test-only: lower the cache limits without shipping a 200 MB fixture
 * through HTTP. Resets counters and clears any cached docs so test cases
 * start from a clean slate.
 */
export function __setCacheConfigForTest(overrides: Partial<CacheConfig>): void {
    clearAllCachedDocs(true);
    config = { ...DEFAULTS, ...overrides };
}

/** Test-only: restore the production defaults. */
export function __resetCacheConfigForTest(): void {
    clearAllCachedDocs(true);
    config = { ...DEFAULTS };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface CacheEntry {
    key: string;
    doc: DocumentLike;
    byteLength: number;
    lastAccessedAt: number;
    inUse: boolean;
    /** Absolute deadline (ms epoch). `Infinity` while `inUse === true`. */
    expiresAt: number;
    /** Wake-up timer; cleared on hit / release reschedule. */
    ttlTimerId: ReturnType<typeof setTimeout> | undefined;
}

// Insertion-ordered Map → LRU position. Re-insert (delete + set) on hit.
const cache: Map<string, CacheEntry> = new Map();
// Reverse lookup so releaseDoc(doc) is O(1).
const docToEntry: Map<DocumentLike, CacheEntry> = new Map();
let totalBytes = 0;

const counters = { hits: 0, misses: 0, evictions: 0 };

// One-time feature-detect for `crypto.subtle.digest`.
let cryptoChecked = false;
let cryptoUsable = false;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Acquire an opened `DocumentLike` for `pdfData`. On a cache hit the same
 * doc handle is returned without re-parsing; on a miss the bytes are parsed
 * via the existing `openDocUncached` path and (if size allows) inserted.
 *
 * Callers MUST pair every successful `acquireDoc` with `releaseDoc(doc)`,
 * regardless of whether the work threw. Mixing `acquireDoc` with raw
 * `doc.destroy()` will corrupt the cache.
 */
export async function acquireDoc(pdfData: Uint8Array | ArrayBuffer): Promise<DocumentLike> {
    sweepExpiredEntries();

    const key = await fingerprintOf(pdfData);
    if (key !== null) {
        // Re-sweep AFTER the SHA-256 await: WebCrypto can take tens of ms
        // on large PDFs, long enough for an entry that was alive at the top
        // of acquireDoc to have crossed its absolute deadline. Without this
        // second sweep the hit path would extend the TTL of an already-
        // expired entry and quietly violate the deadline contract.
        sweepExpiredEntries();
        const existing = cache.get(key);
        if (existing && existing.expiresAt > Date.now()) {
            // LRU bump: re-insert at the end of insertion order.
            cache.delete(key);
            cache.set(key, existing);
            existing.inUse = true;
            existing.lastAccessedAt = Date.now();
            existing.expiresAt = Infinity;
            if (existing.ttlTimerId !== undefined) {
                clearTimeout(existing.ttlTimerId);
                existing.ttlTimerId = undefined;
            }
            counters.hits++;
            postLog(
                "info",
                `[doc-cache] HIT key=${shortKey(key)} bytes=${existing.byteLength} entries=${cache.size}`,
            );
            return existing.doc;
        }
    }

    counters.misses++;
    postLog(
        "info",
        `[doc-cache] MISS — parsing ${byteLengthOf(pdfData)} bytes${key ? ` key=${shortKey(key)}` : " (cache disabled)"}`,
    );
    const doc = await openDocUncached(pdfData);

    // Insertion path. If anything below fails we still return the doc, and
    // releaseDoc(doc) will detect "no entry" and destroy it directly.
    if (key === null) {
        return doc;
    }

    const byteLength = byteLengthOf(pdfData);
    if (byteLength > config.maxBytes) {
        // Oversized — never insert. releaseDoc destroys directly.
        postLog(
            "info",
            `[doc-cache] BYPASS oversized bytes=${byteLength} > maxBytes=${config.maxBytes}`,
        );
        return doc;
    }

    if (!evictForInsert(byteLength)) {
        // Could not make room without evicting an in-use entry. Return the
        // doc as a bypass; releaseDoc will destroy it.
        postLog(
            "info",
            `[doc-cache] BYPASS no room bytes=${byteLength} totalBytes=${totalBytes} entries=${cache.size}`,
        );
        return doc;
    }

    const entry: CacheEntry = {
        key,
        doc,
        byteLength,
        lastAccessedAt: Date.now(),
        inUse: true,
        expiresAt: Infinity,
        ttlTimerId: undefined,
    };
    cache.set(key, entry);
    docToEntry.set(doc, entry);
    totalBytes += byteLength;
    postLog(
        "info",
        `[doc-cache] INSERT key=${shortKey(key)} bytes=${byteLength} entries=${cache.size} totalBytes=${totalBytes}`,
    );
    return doc;
}

/**
 * Release a doc previously returned by `acquireDoc`. If the doc was cached,
 * mark it idle and (re)arm its TTL timer; if it was a bypass (oversized or
 * insertion-evicted), destroy it directly.
 */
export function releaseDoc(doc: DocumentLike): void {
    const entry = docToEntry.get(doc);
    if (!entry) {
        // Bypass path: doc was never inserted (oversized, no-key, or already
        // evicted while in flight).
        try {
            doc.destroy();
        } catch (e) {
            postLog("warn", `[doc-cache] uncached doc.destroy() threw: ${e}`);
        }
        postLog("info", "[doc-cache] RELEASE bypass — destroyed uncached doc");
        return;
    }

    const now = Date.now();
    entry.inUse = false;
    entry.lastAccessedAt = now;
    entry.expiresAt = now + config.ttlMs;
    if (entry.ttlTimerId !== undefined) {
        clearTimeout(entry.ttlTimerId);
    }
    entry.ttlTimerId = setTimeout(() => {
        entry.ttlTimerId = undefined;
        // Wake-up only — destruction happens inside the queued sweep so it
        // stays serialized with in-flight ops.
        enqueue(() => sweepExpiredEntries());
    }, config.ttlMs);
    postLog(
        "info",
        `[doc-cache] RELEASE key=${shortKey(entry.key)} expires_in_ms=${config.ttlMs}`,
    );
}

/**
 * Walk the cache and destroy idle entries whose absolute deadline has
 * passed. Safe to call from inside the worker FIFO queue (e.g. at the top of
 * a real op or via the timer wake-up). The in-use entry, if any, is never
 * touched. The absolute deadline is the source of truth: an op that lands
 * past `expiresAt` but before the timer fires also misses.
 */
export function sweepExpiredEntries(): void {
    const now = Date.now();
    for (const entry of Array.from(cache.values())) {
        if (entry.inUse) continue;
        if (entry.expiresAt > now) continue;
        evictEntry(entry);
    }
}

/**
 * Tear down every cached entry. Used by `__cacheClear` and (transitively) by
 * the test config overrides. When `resetCounters` is true, also zero
 * hits/misses/evictions so live tests can assert exact values.
 *
 * Order: clear timers and the reverse map BEFORE calling destroy(), so a
 * racing timer callback can't observe a half-torn-down entry.
 */
export function clearAllCachedDocs(resetCounters: boolean = true): void {
    const entries = Array.from(cache.values());
    cache.clear();
    docToEntry.clear();
    totalBytes = 0;
    for (const entry of entries) {
        if (entry.ttlTimerId !== undefined) {
            clearTimeout(entry.ttlTimerId);
            entry.ttlTimerId = undefined;
        }
    }
    for (const entry of entries) {
        try {
            entry.doc.destroy();
        } catch (e) {
            postLog("warn", `[doc-cache] doc.destroy() during clear threw: ${e}`);
        }
    }
    if (resetCounters) {
        counters.hits = 0;
        counters.misses = 0;
        counters.evictions = 0;
    }
}

export interface CacheStats {
    entries: number;
    totalBytes: number;
    hits: number;
    misses: number;
    evictions: number;
    ttlMs: number;
    maxEntries: number;
    maxBytes: number;
    cryptoUsable: boolean | null;
}

export function getCacheStats(): CacheStats {
    return {
        entries: cache.size,
        totalBytes,
        hits: counters.hits,
        misses: counters.misses,
        evictions: counters.evictions,
        ttlMs: config.ttlMs,
        maxEntries: config.maxEntries,
        maxBytes: config.maxBytes,
        cryptoUsable: cryptoChecked ? cryptoUsable : null,
    };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function evictEntry(entry: CacheEntry): void {
    cache.delete(entry.key);
    docToEntry.delete(entry.doc);
    totalBytes -= entry.byteLength;
    if (entry.ttlTimerId !== undefined) {
        clearTimeout(entry.ttlTimerId);
        entry.ttlTimerId = undefined;
    }
    try {
        entry.doc.destroy();
    } catch (e) {
        postLog("warn", `[doc-cache] doc.destroy() during eviction threw: ${e}`);
    }
    counters.evictions++;
    postLog(
        "info",
        `[doc-cache] EVICT key=${shortKey(entry.key)} bytes=${entry.byteLength} entries=${cache.size}`,
    );
}

/**
 * Make room for an entry of `byteLength` by evicting idle LRU entries.
 * Returns false if even after evicting every idle entry there is not enough
 * room — caller should bypass the cache for this doc.
 *
 * Because the worker FIFO serializes ops, at most one entry can ever be
 * `inUse` at a time, so capacity-1 idle entries are evictable.
 */
function evictForInsert(byteLength: number): boolean {
    // First pass: evict expired entries (defense in depth — sweepExpired ran
    // at the top of acquireDoc, but a fresh release could have changed
    // counts since then).
    sweepExpiredEntries();

    for (const entry of Array.from(cache.values())) {
        if (cache.size < config.maxEntries && totalBytes + byteLength <= config.maxBytes) {
            break;
        }
        if (entry.inUse) continue;
        evictEntry(entry);
    }

    return cache.size < config.maxEntries && totalBytes + byteLength <= config.maxBytes;
}

function byteLengthOf(pdfData: Uint8Array | ArrayBuffer): number {
    return pdfData instanceof Uint8Array ? pdfData.byteLength : pdfData.byteLength;
}

/**
 * SHA-256 fingerprint over the full bytes via Web Crypto. Returns
 * `${byteLength}|${hashHex}` so byteLength is part of the key for cheap
 * extra discriminator and visibility.
 *
 * Returns null if `crypto.subtle` is unavailable; callers fall through to
 * uncached open + bypass insert.
 */
async function fingerprintOf(pdfData: Uint8Array | ArrayBuffer): Promise<string | null> {
    if (!cryptoChecked) {
        cryptoChecked = true;
        const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
        cryptoUsable = !!subtle && typeof subtle.digest === "function";
        if (!cryptoUsable) {
            postLog(
                "warn",
                "[doc-cache] crypto.subtle.digest unavailable — cache disabled",
            );
        }
    }
    if (!cryptoUsable) return null;

    // crypto.subtle.digest expects a BufferSource. Normalize to a plain
    // ArrayBuffer to dodge `Uint8Array<ArrayBufferLike>` narrowing in lib.dom
    // and to guarantee the digest sees only the bytes we care about even
    // when `pdfData` is a sub-view of a larger backing buffer.
    let buffer: ArrayBuffer;
    let byteLength: number;
    if (pdfData instanceof ArrayBuffer) {
        buffer = pdfData;
        byteLength = pdfData.byteLength;
    } else {
        byteLength = pdfData.byteLength;
        if (pdfData.byteOffset === 0 && pdfData.byteLength === pdfData.buffer.byteLength) {
            buffer = pdfData.buffer as ArrayBuffer;
        } else {
            buffer = pdfData.buffer.slice(
                pdfData.byteOffset,
                pdfData.byteOffset + pdfData.byteLength,
            ) as ArrayBuffer;
        }
    }
    let hashBuffer: ArrayBuffer;
    try {
        hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", buffer);
    } catch (e) {
        postLog("warn", `[doc-cache] SHA-256 digest failed, bypassing cache: ${e}`);
        return null;
    }
    return `${byteLength}|${toHex(new Uint8Array(hashBuffer))}`;
}

function toHex(bytes: Uint8Array): string {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        s += (b < 16 ? "0" : "") + b.toString(16);
    }
    return s;
}

/** Short-form key for log lines (full key is `${len}|${64-hex}`, too noisy). */
function shortKey(key: string): string {
    const pipe = key.indexOf("|");
    if (pipe < 0) return key.slice(0, 12);
    return `${key.slice(0, pipe)}|${key.slice(pipe + 1, pipe + 9)}`;
}
