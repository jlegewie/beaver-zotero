/**
 * Resolution of import specs to Zotero item JSON, without writing anything.
 *
 * Runs while validating an `import_item` action, before the user is asked, so
 * the approval card shows real metadata, bad ids and dead URLs fail before
 * approval, and duplicates are checked on resolved metadata.
 *
 * Per spec (see `ImportItemSpec`): model metadata wins; else an identifier is
 * translated (falling back to `fallback_item`); else a URL is web-translated;
 * else `fallback_item` is used as-is (a file then attaches to it); else a file
 * is recognized. Every result
 * is normalized through `fromJSON`/`toJSON`.
 *
 * Work is bounded: per-kind concurrency, a per-item cap, and the caller's
 * overall deadline. A slow source fails as one `timeout` item; the rest of the
 * batch is returned.
 *
 * Time limits, outermost first:
 * - The backend waits 60 s for the validate response and asks for a 45 s
 *   batch deadline; `validateImportItemsAction` caps it at 55 s, so the plugin
 *   always answers before the backend gives up.
 * - Each item gets `PER_ITEM_MS` for its kind, or whatever is left of the batch
 *   deadline if that is less.
 * - Steps inside an item (the URL's DNS check, page reads, identifier lookups,
 *   file recognition) draw on that same per-item time; they never extend it.
 *
 * Separate limits after approval, outside this budget: resolving a citation
 * import when the user clicks it (20 s) and loading a page for its snapshot
 * (60 s), both in `write.ts`.
 */

import type {
    ImportFileRef,
    ImportItemSpec,
    ResolvedItem,
    ResolutionMethod,
    ZoteroItemJson,
} from '@beaver/agent-core/types/itemImport';
import { logger } from '@beaver/agent-core/platform/logger';
import { findExistingItems, WEB_CONTENT_ITEM_TYPES } from './duplicates';
import { normalizeItemJson } from './itemJson';
import { locateImportFile, recognizeFile, type LocatedFile } from './recognizeFile';
import { translateIdentifier } from './resolveIdentifier';
import { translateUrl } from './resolveUrl';

export interface ResolveOptions {
    libraryID: number;
    /** Overall budget for the whole batch. */
    deadlineMs: number;
    /** Path authorization scope. */
    threadId?: string | null;
    /** Skip the duplicate check (callers that run their own). */
    skipDuplicateCheck?: boolean;
}

const PER_ITEM_MS = { identifier: 20_000, url: 20_000, file: 30_000 } as const;
const CONCURRENCY = { identifier: 4, url: 2, file: 2, metadata: 8 } as const;

type Lane = keyof typeof CONCURRENCY;

class Semaphore {
    private active = 0;
    private readonly waiters: Array<() => void> = [];
    constructor(private readonly limit: number) {}
    async run<T>(work: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
        this.active++;
        try {
            return await work();
        } finally {
            this.active--;
            this.waiters.shift()?.();
        }
    }
}

function laneFor(spec: ImportItemSpec): Lane {
    if (spec.item) return 'metadata';
    if (spec.identifier) return 'identifier';
    if (spec.url) return 'url';
    if (spec.file) return 'file';
    return 'metadata';
}

function failed(key: string, code: string, message: string, extra: Partial<ResolvedItem> = {}): ResolvedItem {
    return { key, status: 'failed', error: { code, message }, ...extra };
}

/** Fill an empty abstract from fallback metadata (fill-only; identity fields never touched). */
function fillFromFallback(item: ZoteroItemJson, fallback: ZoteroItemJson | undefined): void {
    const abstract = fallback?.abstractNote;
    if (typeof abstract === 'string' && abstract.trim() && !(typeof item.abstractNote === 'string' && item.abstractNote.trim())) {
        item.abstractNote = abstract;
    }
}

function snapshotUrlFor(item: ZoteroItemJson, pageUrl: string, attachmentUrls: ResolvedItem['attachment_urls']): string | undefined {
    const hasPdf = (attachmentUrls ?? []).some((attachment) =>
        (attachment.mime_type ?? '').toLowerCase() === 'application/pdf' && !attachment.snapshot);
    const hasDoi = typeof item.DOI === 'string' && item.DOI.trim().length > 0;
    return WEB_CONTENT_ITEM_TYPES.has(item.itemType) || (!hasPdf && !hasDoi) ? pageUrl : undefined;
}

interface Resolution {
    item?: ZoteroItemJson;
    method?: ResolutionMethod;
    translator?: string;
    attachment_urls?: ResolvedItem['attachment_urls'];
    snapshot_url?: string;
    recognizer_hints?: ResolvedItem['recognizer_hints'];
    warnings: string[];
}

function normalized(json: Record<string, any>, libraryID: number, method: ResolutionMethod, translator: string | undefined, warnings: string[]): Resolution | { error: { code: string; message: string } } {
    const result = normalizeItemJson(json, libraryID);
    if (!result.ok) return { error: { code: result.code, message: result.message } };
    return { item: result.item, method, translator, warnings: [...warnings, ...result.warnings] };
}

async function resolveOne(
    spec: ImportItemSpec,
    options: ResolveOptions,
    remainingMs: () => number,
): Promise<ResolvedItem> {
    const { libraryID } = options;
    const budget = (cap: number) => Math.max(0, Math.min(cap, remainingMs()));
    if (remainingMs() <= 0) return failed(spec.key, 'timeout', 'The lookup ran out of time before this input was reached.');

    let located: LocatedFile | undefined;
    let fileRef: ImportFileRef | undefined;
    if (spec.file) {
        const location = await locateImportFile(spec.file, { threadId: options.threadId });
        if (!location.ok) return failed(spec.key, location.code, location.message);
        located = location.file;
        fileRef = location.file.ref;
    }

    const warnings: string[] = [];
    let resolution: Resolution | { error: { code: string; message: string } } | null = null;

    if (spec.item) {
        resolution = normalized(spec.item, libraryID, 'model_metadata', undefined, warnings);
    } else if (spec.identifier) {
        const translation = await translateIdentifier(spec.identifier, budget(PER_ITEM_MS.identifier));
        if (translation.ok) {
            resolution = normalized(translation.json, libraryID, 'translator', translation.translator, warnings);
            if ('item' in resolution && resolution.item) {
                resolution.attachment_urls = translation.attachments;
                fillFromFallback(resolution.item, spec.fallback_item);
            }
        } else if (spec.fallback_item) {
            warnings.push(`identifier lookup failed (${translation.message}); using the search result's metadata`);
            resolution = normalized(spec.fallback_item, libraryID, 'fallback_metadata', undefined, warnings);
        } else {
            return failed(spec.key, translation.code, translation.message, { file: fileRef });
        }
    } else if (spec.url) {
        const translation = await translateUrl(spec.url, budget(PER_ITEM_MS.url));
        if (translation.ok) {
            resolution = normalized(translation.json, libraryID, 'web_translator', translation.translator, warnings);
            if ('item' in resolution && resolution.item) {
                resolution.attachment_urls = translation.attachments;
                resolution.snapshot_url = located ? undefined : snapshotUrlFor(resolution.item, translation.pageUrl, translation.attachments);
                fillFromFallback(resolution.item, spec.fallback_item);
            }
        } else if (spec.fallback_item) {
            warnings.push(`page lookup failed (${translation.message}); using the search result's metadata`);
            resolution = normalized(spec.fallback_item, libraryID, 'fallback_metadata', undefined, warnings);
        } else {
            return failed(spec.key, translation.code, translation.message, { file: fileRef });
        }
    } else if (spec.fallback_item) {
        // A chosen reference without an identifier: its metadata names the work,
        // and an attached file belongs to it rather than being identified anew.
        resolution = normalized(spec.fallback_item, libraryID, 'fallback_metadata', undefined, warnings);
    } else if (located) {
        resolution = await resolveFromFile(spec, located, libraryID, budget(PER_ITEM_MS.file), warnings);
    } else {
        return failed(spec.key, 'invalid_metadata', 'Nothing to resolve: pass an id, metadata or a file.');
    }

    if ('error' in resolution) return failed(spec.key, resolution.error.code, resolution.error.message, { file: fileRef });
    return {
        key: spec.key,
        status: 'resolved',
        ...(resolution.item ? { item: resolution.item } : {}),
        method: resolution.method,
        ...(resolution.translator ? { translator: resolution.translator } : {}),
        ...(resolution.attachment_urls?.length ? { attachment_urls: resolution.attachment_urls } : {}),
        ...(resolution.snapshot_url ? { snapshot_url: resolution.snapshot_url } : {}),
        ...(resolution.recognizer_hints ? { recognizer_hints: resolution.recognizer_hints } : {}),
        ...(fileRef ? { file: fileRef } : {}),
        ...(resolution.warnings.length ? { warnings: resolution.warnings } : {}),
    };
}

async function resolveFromFile(
    spec: ImportItemSpec,
    file: LocatedFile,
    libraryID: number,
    timeoutMs: number,
    warnings: string[],
): Promise<Resolution | { error: { code: string; message: string } }> {
    // One deadline for the whole file: recognition, then each identifier lookup.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    let recognition;
    try {
        recognition = await recognizeFile(file, timeoutMs);
    } catch (error: any) {
        if (error?.code === 'timeout') return { error: { code: 'timeout', message: `Identifying ${file.filename} took too long.` } };
        throw error;
    }
    switch (recognition.kind) {
        case 'error':
            return { error: { code: recognition.code, message: recognition.message } };
        case 'item': {
            const result = normalized(recognition.json, libraryID, 'recognizer', recognition.translator, warnings);
            if ('item' in result) result.recognizer_hints = recognition.hints;
            return result;
        }
        case 'identifiers': {
            for (const identifier of recognition.identifiers) {
                if (left() <= 0) break;
                const translation = await translateIdentifier(identifier, left());
                if (translation.ok) {
                    const result = normalized(translation.json, libraryID, 'recognizer', translation.translator, warnings);
                    if ('item' in result) result.recognizer_hints = recognition.hints;
                    return result;
                }
            }
            if (recognition.titleItem) {
                const result = normalized(recognition.titleItem, libraryID, 'recognizer', 'Zotero recognizer', warnings);
                if ('item' in result) result.recognizer_hints = recognition.hints;
                return result;
            }
            return { error: { code: 'unrecognized_file', message: `Zotero found an identifier in ${file.filename} but could not look it up.` } };
        }
    }
}

/** Resolve every spec (same order as the input). Never writes to the library. */
export async function resolveImportItems(specs: ImportItemSpec[], options: ResolveOptions): Promise<ResolvedItem[]> {
    const started = Date.now();
    const remainingMs = () => options.deadlineMs - (Date.now() - started);
    const lanes: Record<Lane, Semaphore> = {
        identifier: new Semaphore(CONCURRENCY.identifier),
        url: new Semaphore(CONCURRENCY.url),
        file: new Semaphore(CONCURRENCY.file),
        metadata: new Semaphore(CONCURRENCY.metadata),
    };

    const results = await Promise.all(specs.map((spec) => lanes[laneFor(spec)].run(async () => {
        try {
            return await resolveOne(spec, options, remainingMs);
        } catch (error) {
            logger(`itemImport/resolve: ${spec.key} failed: ${error}`, 1);
            return failed(spec.key, 'resolution_failed', `Could not resolve this input: ${error instanceof Error ? error.message : String(error)}`);
        }
    })));

    if (!options.skipDuplicateCheck) {
        const withItems = results
            .filter((result) => result.status === 'resolved' && result.item)
            .map((result) => ({ key: result.key, json: result.item! }));
        const existing = await findExistingItems(withItems, options.libraryID);
        for (const result of results) {
            const match = existing.get(result.key);
            if (!match) continue;
            result.status = 'already_in_library';
            result.existing_item = {
                library_id: match.library_id,
                zotero_key: match.zotero_key,
                ...(match.library_ref ? { library_ref: match.library_ref } : {}),
            };
        }
    }

    logger(`itemImport/resolve: ${specs.length} spec(s) in ${Date.now() - started}ms: `
        + results.map((result) => `${result.key}=${result.status}${result.error ? `(${result.error.code})` : ''}`).join(', '), 2);
    return results;
}
