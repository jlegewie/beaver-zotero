/**
 * Identifier resolution: a `Zotero.Translate.Search` dry run.
 *
 * `translate({ libraryID: false, saveAttachments: false })` returns translator
 * JSON without writing anything — the same lookup Zotero's "Add Item by
 * Identifier" performs, minus the save.
 */

import type { AttachmentUrl, TypedIdentifier } from '@beaver/agent-core/types/itemImport';
import { systemDelay } from '../../utils/systemTimers';
import { isApiAvailable, looksLikeApiDrift, markApiUnavailable, withTimeout } from './zoteroApis';

export type IdentifierTranslation =
    | { ok: true; json: Record<string, any>; translator?: string; attachments: AttachmentUrl[] }
    | { ok: false; code: 'not_found' | 'no_translator' | 'timeout' | 'translation_failed'; message: string };

const ZOTERO_IDENTIFIER_KEY: Partial<Record<TypedIdentifier['type'], string>> = {
    doi: 'DOI',
    isbn: 'ISBN',
    arxiv: 'arXiv',
    pmid: 'PMID',
};

const LABEL: Record<TypedIdentifier['type'], string> = {
    doi: 'DOI',
    isbn: 'ISBN',
    arxiv: 'arXiv id',
    pmid: 'PubMed id',
    pmcid: 'PMC id',
};

function cleanISBN(value: string): string | null {
    const cleaned = (Zotero.Utilities as any).cleanISBN?.(value);
    if (!cleaned) return null;
    return (Zotero.Utilities as any).toISBN13?.(cleaned) ?? cleaned;
}

/** ISBN lookups can return an unrelated book; accept a record only if it lists the requested ISBN. */
function isbnMatches(requested: string, json: Record<string, any>): boolean {
    const returned = typeof json.ISBN === 'string' ? json.ISBN : '';
    if (!returned.trim()) return true;
    const wanted = cleanISBN(requested);
    if (!wanted) return true;
    return returned.split(/[\s,;]+/).some((candidate) => cleanISBN(candidate) === wanted);
}

function normalizedDOI(value: string): string | null {
    const cleaned = (Zotero.Utilities as any).cleanDOI?.(value);
    return cleaned ? String(cleaned).toLowerCase() : null;
}

/**
 * DOI lookups can return the record that contains the requested one: Zotero's
 * Crossref XML import turns a chapter of a book Crossref registered as a
 * monograph into the book itself. Accept a record only if it carries the
 * requested DOI (or none).
 */
function doiMatches(requested: string, json: Record<string, any>): boolean {
    const returned = typeof json.DOI === 'string' ? normalizedDOI(json.DOI) : null;
    const wanted = normalizedDOI(requested);
    return !returned || !wanted || returned === wanted;
}

// Crossref REST types a record by its own Crossref type, so it returns such a
// chapter as a book section. Zotero never selects it for a DOI search on its own.
const CROSSREF_REST_TRANSLATOR_ID = '0a61e167-de9a-4f93-a68a-628b48855909';

// An import resolves its items concurrently, but Crossref answers the filter
// query Crossref REST sends at most once per second and one at a time for
// clients without a contact address. Crossref REST reports a rate-limited
// request as a failed translation, so its lookups run one at a time, at least a
// second apart, and a failed one is tried once more after a pause.
const CROSSREF_REST_GAP_MS = 1100;
const CROSSREF_REST_RETRY_DELAY_MS = 2000;
let crossrefRestTail: Promise<void> = Promise.resolve();

/**
 * A turn in the Crossref REST queue: `ready` settles when every earlier lookup
 * has finished, and `release` hands the turn on. Call `release` exactly once.
 */
function crossrefRestTurn(): { ready: Promise<void>; release: () => void } {
    const ready = crossrefRestTail;
    let release!: () => void;
    crossrefRestTail = new Promise<void>((resolve) => { release = resolve; });
    return { ready, release };
}

function timeoutError(label: string): Error {
    return Object.assign(new Error(`${label} timed out`), { code: 'timeout' });
}

/**
 * Crossref REST files a chapter's authors as `bookAuthor`. A book section's
 * own authors are `author`, so convert them when no `author` is present.
 */
function chapterAuthors(json: Record<string, any>): Record<string, any> {
    const creators: any[] = Array.isArray(json.creators) ? json.creators : [];
    if (json.itemType !== 'bookSection' || creators.some((c) => c?.creatorType === 'author')) return json;
    return {
        ...json,
        creators: creators.map((c) => (c?.creatorType === 'bookAuthor' ? { ...c, creatorType: 'author' } : c)),
    };
}

/** Attachment entries a translator returned (never downloaded here), e.g. arXiv's PDF link. */
export function translatorAttachments(json: Record<string, any>): AttachmentUrl[] {
    return (Array.isArray(json.attachments) ? json.attachments : [])
        .filter((attachment: any) => typeof attachment?.url === 'string' && /^https?:/i.test(attachment.url))
        .map((attachment: any) => ({
            url: attachment.url,
            ...(attachment.mimeType ? { mime_type: attachment.mimeType } : {}),
            ...(attachment.title ? { title: attachment.title } : {}),
            ...(attachment.snapshot !== undefined ? { snapshot: !!attachment.snapshot } : {}),
        }));
}

/** Translate one identifier to item JSON within `timeoutMs`. Never writes. */
export async function translateIdentifier(identifier: TypedIdentifier, timeoutMs: number): Promise<IdentifierTranslation> {
    const key = ZOTERO_IDENTIFIER_KEY[identifier.type];
    if (!key) {
        return { ok: false, code: 'no_translator', message: `${LABEL[identifier.type]} lookups are not supported.` };
    }
    if (!isApiAvailable('translateSearch')) {
        return { ok: false, code: 'no_translator', message: 'Zotero identifier lookup is unavailable in this Zotero version.' };
    }

    const label = `${LABEL[identifier.type]} ${identifier.value}`;
    // One deadline for translator discovery and translation together.
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(0, deadline - Date.now());
    // Starts a translation; the caller bounds the wait, which never cancels it.
    const startSearch = (translators: unknown) => {
        const translate = new (Zotero as any).Translate.Search();
        translate.setIdentifier({ [key]: identifier.value });
        translate.setTranslator(translators);
        // A search returning several records (rare) resolves to the first one.
        translate.setHandler?.('select', (_t: unknown, items: Record<string, unknown>, callback: (selected: Record<string, unknown>) => void) => {
            const first = Object.keys(items)[0];
            callback(first ? { [first]: items[first] } : {});
        });
        const items: Promise<any[]> = Promise.resolve().then(() =>
            translate.translate({ libraryID: false, saveAttachments: false }));
        return { translate, items };
    };
    const firstRecord = (translate: any, items: any[] | undefined) => {
        const json = items?.[0];
        const translatorLabel = translate.translator?.[0]?.label;
        return {
            json: json && typeof json === 'object' ? json as Record<string, any> : null,
            label: typeof translatorLabel === 'string' ? translatorLabel : undefined,
        };
    };
    const search = async (translators: unknown) => {
        const { translate, items } = startSearch(translators);
        return firstRecord(translate, await withTimeout(items, left(), `Looking up ${label}`));
    };
    // One Crossref REST lookup in its queue turn. The wait for the turn counts
    // against the deadline, and the turn is held until the translation itself
    // settles, even when this lookup stopped waiting for it. Timeouts and API
    // drift propagate; any other failure (including a rate-limited request)
    // counts as no record.
    const searchCrossrefRest = async () => {
        const { ready, release } = crossrefRestTurn();
        try {
            await withTimeout(ready, left(), `Looking up ${label}`);
        } catch (error) {
            void ready.then(release);
            throw error;
        }
        if (left() <= 0) {
            release();
            throw timeoutError(`Looking up ${label}`);
        }
        let started: ReturnType<typeof startSearch>;
        try {
            started = startSearch(CROSSREF_REST_TRANSLATOR_ID);
        } catch (error) {
            release();
            throw error;
        }
        void started.items.then(() => undefined, () => undefined)
            .then(() => systemDelay(CROSSREF_REST_GAP_MS))
            .then(release);
        try {
            return firstRecord(started.translate, await withTimeout(started.items, left(), `Looking up ${label}`));
        } catch (error: any) {
            if (error?.code === 'timeout' || looksLikeApiDrift(error)) throw error;
            return null;
        }
    };
    try {
        const discovery = new (Zotero as any).Translate.Search();
        discovery.setIdentifier({ [key]: identifier.value });
        const translators = await withTimeout<any[]>(discovery.getTranslators(), left(), `Looking up ${label}`);
        if (!translators?.length) {
            return { ok: false, code: 'no_translator', message: `No Zotero translator can look up ${label}.` };
        }
        let { json, label: translatorLabel } = await search(translators);
        if (!json) {
            return { ok: false, code: 'not_found', message: `${label} was not found.` };
        }
        if (identifier.type === 'isbn' && !isbnMatches(identifier.value, json)) {
            return { ok: false, code: 'not_found', message: `The lookup for ${label} returned a different book.` };
        }
        if (identifier.type === 'doi' && !doiMatches(identifier.value, json)) {
            let retry = await searchCrossrefRest();
            if (!retry?.json && left() > CROSSREF_REST_RETRY_DELAY_MS) {
                await systemDelay(CROSSREF_REST_RETRY_DELAY_MS);
                retry = await searchCrossrefRest();
            }
            if (!retry?.json || !doiMatches(identifier.value, retry.json)) {
                return { ok: false, code: 'not_found', message: `The lookup for ${label} returned a different record.` };
            }
            json = chapterAuthors(retry.json);
            translatorLabel = 'Crossref REST';
        }
        translatorLabel ??= typeof translators[0]?.label === 'string' ? translators[0].label : undefined;
        return {
            ok: true,
            json,
            translator: translatorLabel,
            attachments: translatorAttachments(json),
        };
    } catch (error: any) {
        if (error?.code === 'timeout') {
            return { ok: false, code: 'timeout', message: `Looking up ${label} took too long.` };
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/No items returned from any translator/i.test(message)) {
            return { ok: false, code: 'not_found', message: `${label} was not found.` };
        }
        if (looksLikeApiDrift(error)) markApiUnavailable('translateSearch', error);
        return { ok: false, code: 'translation_failed', message: `Looking up ${label} failed: ${message}` };
    }
}
