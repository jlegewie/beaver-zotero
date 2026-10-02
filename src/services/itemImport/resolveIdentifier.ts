/**
 * Identifier resolution: a `Zotero.Translate.Search` dry run.
 *
 * `translate({ libraryID: false, saveAttachments: false })` returns translator
 * JSON without writing anything — the same lookup Zotero's "Add Item by
 * Identifier" performs, minus the save.
 */

import type { AttachmentUrl, TypedIdentifier } from '@beaver/agent-core/types/itemImport';
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
    try {
        const translate = new (Zotero as any).Translate.Search();
        translate.setIdentifier({ [key]: identifier.value });
        const translators = await withTimeout<any[]>(translate.getTranslators(), left(), `Looking up ${label}`);
        if (!translators?.length) {
            return { ok: false, code: 'no_translator', message: `No Zotero translator can look up ${label}.` };
        }
        translate.setTranslator(translators);
        // A search returning several records (rare) resolves to the first one.
        translate.setHandler?.('select', (_t: unknown, items: Record<string, unknown>, callback: (selected: Record<string, unknown>) => void) => {
            const first = Object.keys(items)[0];
            callback(first ? { [first]: items[first] } : {});
        });
        const items = await withTimeout<any[]>(
            translate.translate({ libraryID: false, saveAttachments: false }),
            left(),
            `Looking up ${label}`,
        );
        const json = items?.[0];
        if (!json || typeof json !== 'object') {
            return { ok: false, code: 'not_found', message: `${label} was not found.` };
        }
        if (identifier.type === 'isbn' && !isbnMatches(identifier.value, json)) {
            return { ok: false, code: 'not_found', message: `The lookup for ${label} returned a different book.` };
        }
        const translatorLabel = translate.translator?.[0]?.label ?? translators[0]?.label;
        return {
            ok: true,
            json,
            translator: typeof translatorLabel === 'string' ? translatorLabel : undefined,
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
