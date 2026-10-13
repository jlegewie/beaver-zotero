/**
 * Note HTML Simplifier
 *
 * Converts Zotero note HTML to a simplified intermediate format that replaces
 * opaque metadata (citations with URI-encoded JSON, annotation position data,
 * base64 images, data-citation-items caches) with clean semantic tags.
 *
 * This enables LLM agents to edit notes via StrReplace without corrupting
 * metadata. The reverse transformation (simplified → raw) lives in
 * `noteCitationExpand.ts`.
 */

import { stripBeaverEditFooter, stripBeaverCreatedFooter } from './noteEditFooter';
import { escapeAttr, unescapeAttr } from './noteHtmlEntities';
import { extractDataCitationItems, stripDataCitationItems, stripNoteWrapperDiv } from './noteWrapper';
import { normalizeNoteHtml } from '../prosemirror/normalize';
import {
    parseLinkCitationPageSuffix,
    parseZoteroCitationLinkHref,
    zoteroLinkCitationPattern,
} from './zoteroLinkCitation';
import { translatePageLabelToNumber } from './pageLabelTranslation';
import { citationItemRefFromUri } from './zoteroUri';
import { modelObjectId } from './libraryIdentity';
import { citationReadback, isItemKey, readBeaverCitationMeta } from './noteCitationMeta';
import type { PageLabels } from '../services/documentCache';

export { normalizeNoteHtml };

// =============================================================================
// Types
// =============================================================================

export interface SimplificationResult {
    simplified: string;
    metadata: SimplificationMetadata;
}

export interface SimplificationMetadata {
    elements: Map<string, StoredElement>;
    /**
     * Cited annotations and attachments recorded in Beaver's citation
     * metadata, and whether each existed. The view names a child by its own id
     * while it exists and falls back to the parent item otherwise, so a cached
     * view is stale once any child's existence changes.
     */
    citedChildren?: Array<{ libraryID: number; key: string; exists: boolean }>;
}

export interface StoredElement {
    rawHtml: string;
    type: 'citation' | 'compound-citation' | 'annotation' | 'annotation-image' | 'image' | 'link';
    originalAttrs?: {
        /** Model id the citation was shown with; empty for an external work. */
        item_id: string;
        page?: string;
        pageConvention?: 'number' | 'label';
        cslLabel?: string;
        /**
         * Locator token the citation was shown with, from its private
         * metadata (empty when it was shown without one). Absent for a
         * citation without metadata, which is shown with its page.
         */
        loc?: string;
        /** External reference id of an embedded external work. */
        external_id?: string;
    };
    isCompound?: boolean;
    /** The `items` attribute a compound citation was read as. */
    originalItems?: string;
    originalText?: string;
}

interface CachedSimplification {
    contentHash: string;
    pageLabelsFingerprint: string;
    simplified: string;
    metadata: SimplificationMetadata;
}

// =============================================================================
// Cache
// =============================================================================

const MAX_CACHE_SIZE = 50;
const simplificationCache = new Map<string, CachedSimplification>();

function simplificationCacheKey(noteId: string, pageLabelsFingerprint: string): string {
    return `${noteId}\u0000${pageLabelsFingerprint}`;
}

function quickHash(str: string): string {
    // Simple hash for content comparison (not cryptographic)
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0; // Convert to 32bit integer
    }
    return String(hash) + ':' + str.length;
}

function fingerprintPageLabels(pageLabelsByItemId?: Record<string, PageLabels>): string {
    if (!pageLabelsByItemId || Object.keys(pageLabelsByItemId).length === 0) return '';
    return JSON.stringify(
        Object.keys(pageLabelsByItemId)
            .sort()
            .map((itemId) => [
                itemId,
                Object.entries(pageLabelsByItemId[itemId] ?? {})
                    .sort(([a], [b]) => Number(a) - Number(b)),
            ])
    );
}

/**
 * Get a cached simplification or re-simplify if cache is stale/missing.
 */
export function getOrSimplify(
    noteId: string,
    rawHtml: string,
    libraryID: number,
    pageLabelsByItemId?: Record<string, PageLabels>,
): { simplified: string; metadata: SimplificationMetadata; isStale: boolean } {
    const contentHash = quickHash(rawHtml);
    const pageLabelsFingerprint = fingerprintPageLabels(pageLabelsByItemId);
    const cacheKey = simplificationCacheKey(noteId, pageLabelsFingerprint);
    const cached = simplificationCache.get(cacheKey);

    if (
        cached
        && cached.contentHash === contentHash
        && cached.pageLabelsFingerprint === pageLabelsFingerprint
        && !cached.metadata.citedChildren?.some(child => isMissingItem(child.libraryID, child.key) === child.exists)
    ) {
        return { simplified: cached.simplified, metadata: cached.metadata, isStale: false };
    }

    // Cache miss or stale — re-simplify
    const result = simplifyNoteHtml(rawHtml, libraryID, pageLabelsByItemId);

    // Evict oldest entries if cache is full
    if (simplificationCache.size >= MAX_CACHE_SIZE) {
        const firstKey = simplificationCache.keys().next().value;
        if (firstKey !== undefined) {
            simplificationCache.delete(firstKey);
        }
    }

    simplificationCache.set(cacheKey, {
        contentHash,
        pageLabelsFingerprint,
        simplified: result.simplified,
        metadata: result.metadata,
    });

    return {
        simplified: result.simplified,
        metadata: result.metadata,
        isStale: cached !== undefined,
    };
}

/**
 * Invalidate cache entry for a note.
 */
export function invalidateSimplificationCache(noteId: string): void {
    const prefix = `${noteId}\u0000`;
    for (const key of [...simplificationCache.keys()]) {
        if (key.startsWith(prefix)) simplificationCache.delete(key);
    }
}

// =============================================================================
// Simplification: Raw HTML → Simplified + Metadata
// =============================================================================

/**
 * Simplify Zotero note HTML to a clean format for LLM editing.
 *
 * Replaces citations, annotations, annotation-images, regular images, and
 * math elements with semantic tags / dollar notation, and strips
 * data-citation-items from the wrapper div.
 * Stores original raw HTML in the metadata map for expansion back.
 */
export function simplifyNoteHtml(
    rawHtml: string,
    libraryID: number,
    pageLabelsByItemId?: Record<string, PageLabels>,
): SimplificationResult {
    const metadata: SimplificationMetadata = { elements: new Map() };

    // Content-based citation refs, numbered by occurrence: c_<key>_<n>.
    const citationKeyCounts = new Map<string, number>();
    const nextRef = (key: string): string => {
        const occurrence = citationKeyCounts.get(key) || 0;
        citationKeyCounts.set(key, occurrence + 1);
        return `c_${key}_${occurrence}`;
    };
    const elementId = uniqueElementIdFactory(metadata);

    // Strip Beaver footers before normalization so internal Beaver protocol
    // links never enter the agent-visible note body or citation-link pass.
    // This only affects the simplified view; the raw note HTML on disk is
    // untouched until edit_note applies a user-requested change.
    let simplified = stripBeaverEditFooter(rawHtml);
    simplified = stripBeaverCreatedFooter(simplified);

    // Use regex-based approach to avoid DOMParser re-serialization issues.
    // DOMParser + innerHTML can change attribute order, whitespace, and entity encoding.
    // Pre-normalize to ProseMirror-canonical format so the simplified output is stable
    // across PM re-serializations (hex→rgb, style splitting, legacy elements, etc.).
    simplified = normalizeNoteHtml(simplified);

    // 1. Strip data-citation-items from wrapper div, keeping the item data of
    // works that are not library items to name them in the simplified view.
    const cachedItemDataByUri = new Map<string, Record<string, unknown>>();
    for (const entry of extractDataCitationItems(simplified) ?? []) {
        for (const uri of entry?.uris ?? []) {
            if (entry.itemData && !cachedItemDataByUri.has(uri)) cachedItemDataByUri.set(uri, entry.itemData);
        }
    }
    simplified = stripDataCitationItems(simplified);

    // 2. Replace annotation images (img with both data-attachment-key and data-annotation)
    // Must process before regular images since annotation images also have data-attachment-key
    simplified = simplified.replace(
        /<img\s+([^>]*data-attachment-key="([^"]*)"[^>]*data-annotation="([^"]*)"[^>]*)\/?\s*>/g,
        (match, _allAttrs, attachmentKey, encodedAnnotation) => {
            try {
                const annotationData = JSON.parse(decodeURIComponent(encodedAnnotation));
                const annotationKey = annotationKeyOf(annotationData);
                const id = elementId(`ai_${annotationKey ?? 'nokey'}`);

                // Extract width/height from attrs
                const widthMatch = match.match(/width="(\d+)"/);
                const heightMatch = match.match(/height="(\d+)"/);
                const width = widthMatch ? widthMatch[1] : '';
                const height = heightMatch ? heightMatch[1] : '';

                metadata.elements.set(id, {
                    rawHtml: match,
                    type: 'annotation-image',
                });

                let tag = `<annotation-image id="${id}"`;
                if (annotationKey) tag += ` key="${annotationKey}"`;
                tag += ` attachment="${attachmentKey}"`;
                if (width) tag += ` width="${width}"`;
                if (height) tag += ` height="${height}"`;
                tag += ' />';
                return tag;
            } catch {
                return match; // Leave unchanged if parsing fails
            }
        }
    );

    // 3. Replace regular images (img with data-attachment-key but no data-annotation)
    simplified = simplified.replace(
        /<img\s+([^>]*data-attachment-key="([^"]*)"[^>]*)\/?\s*>/g,
        (match, _allAttrs, attachmentKey) => {
            // Skip if this was already handled as annotation-image (check if it has data-annotation)
            if (match.includes('data-annotation=')) {
                return match;
            }
            const id = elementId(`i_${attachmentKey}`);

            metadata.elements.set(id, {
                rawHtml: match,
                type: 'image',
            });

            return `<image id="${id}" attachment="${attachmentKey}" />`;
        }
    );

    // 4. Replace annotations (span.highlight with data-annotation)
    simplified = simplified.replace(
        /<span\s+class="highlight"\s+data-annotation="([^"]*)">([\s\S]*?)<\/span>/g,
        (match, encodedAnnotation, innerText) => {
            try {
                const annotationData = JSON.parse(decodeURIComponent(encodedAnnotation));
                const annotationKey = annotationKeyOf(annotationData);
                const color = annotationData.color || '';
                const pageLabel = annotationData.pageLabel || '';
                const id = elementId(`a_${annotationKey ?? 'nokey'}`);

                metadata.elements.set(id, {
                    rawHtml: match,
                    type: 'annotation',
                    originalText: innerText,
                });

                let tag = `<annotation id="${id}"`;
                if (annotationKey) tag += ` key="${annotationKey}"`;
                if (color) tag += ` color="${color}"`;
                if (pageLabel) tag += ` page="${pageLabel}"`;
                tag += `>${innerText}</annotation>`;
                return tag;
            } catch {
                return match;
            }
        }
    );

    // 5. Replace citations (span.citation with data-citation)
    // Regex handles nested <span class="citation-item"> tags inside citations.
    // Zotero's formatCitation() wraps each item: (<span class="citation-item">Author, 2024</span>)
    // The content group matches: non-< chars, or nested <span>...</span> pairs (one level deep).
    simplified = simplified.replace(
        /<span\s+class="citation"\s+data-citation="([^"]*)">((?:[^<]*(?:<span\b[^>]*>[^<]*<\/span>)?)*)<\/span>/g,
        (match, encodedCitation, visibleContent) => {
            try {
                const citationData = JSON.parse(decodeURIComponent(encodedCitation));
                const citationItems = citationData.citationItems || [];

                if (citationItems.length === 0) {
                    return match; // No citation items — leave unchanged
                }

                // Extract visible text (label) — the full visible content of the citation span
                let label = visibleContent
                    .replace(/<[^>]+>/g, '') // Strip HTML tags (e.g., <span class="citation-item">)
                    .trim();

                // ProseMirror atom nodes regenerate visible text from data-citation attrs.
                // When itemData is missing (schema v2+ moves it to container), toDOM
                // produces "()" — recover a useful label by looking up the item.
                if (!label || label === '()') {
                    label = generateCitationLabel(citationData);
                }

                if (citationItems.length === 1) {
                    // Single citation
                    const ci = citationItems[0];
                    const uri = ci.uris?.[0] || '';
                    const itemRef = citationItemRefFromUri(uri, libraryID);

                    if (!itemRef) {
                        // An external work Beaver embedded reads back as the
                        // external reference it was written from. The work is
                        // not in the library, so the tag names it: a short
                        // label and the URL the citation cites it by.
                        const meta = readBeaverCitationMeta(ci);
                        if (meta?.ext) {
                            const ref = nextRef(`ext_${meta.ext.replace(/[^\w.-]/g, '_')}`);
                            metadata.elements.set(ref, {
                                rawHtml: match,
                                type: 'citation',
                                originalAttrs: { item_id: '', external_id: meta.ext, loc: meta.loc ?? '' },
                            });
                            let tag = `<citation external_id="${escapeAttr(meta.ext)}"`;
                            if (meta.loc) tag += ` loc="${escapeAttr(meta.loc)}"`;
                            tag += ` ref="${ref}"`;
                            const workLabel = embeddedWorkLabel(meta.csl);
                            if (workLabel) tag += ` label="${escapeAttr(workLabel)}"`;
                            return `${tag}${urlAttr(uri)}/>`;
                        }

                        // Any other work that is not a library item (cited from
                        // another library, or an embedded work edited in
                        // Zotero's citation dialog) is shown by name only. It
                        // can be kept, moved or removed, not edited.
                        const ref = nextRef('embedded');
                        metadata.elements.set(ref, { rawHtml: match, type: 'citation' });
                        const workLabel = embeddedWorkLabel(
                            (ci.itemData as Record<string, unknown> | undefined) ?? cachedItemDataByUri.get(uri),
                        ) || label.replace(/^\(|\)$/g, '');
                        let tag = `<citation ref="${ref}"`;
                        if (workLabel) tag += ` label="${escapeAttr(workLabel)}"`;
                        return `${tag}${urlAttr(uri)}/>`;
                    }

                    // Beaver's metadata says what was cited. A cited annotation
                    // or attachment that no longer exists reads back as the
                    // parent item and page the note shows; whether each child
                    // existed is recorded so a cached view can be invalidated.
                    const readback = citationReadback(ci, (key) => {
                        const exists = !isMissingItem(itemRef.libraryID, key);
                        (metadata.citedChildren ??= []).push({ libraryID: itemRef.libraryID, key, exists });
                        return exists;
                    });
                    // A citation of an annotation or attachment names its
                    // parent item; the metadata says which child was cited.
                    const citedKey = readback?.childKey ?? itemRef.key;
                    const itemId = modelObjectId(itemRef.libraryID, citedKey);
                    const ref = nextRef(citedKey);

                    // The locator as Beaver wrote it, in the agent's own convention.
                    if (readback && readback.loc !== null) {
                        metadata.elements.set(ref, {
                            rawHtml: match,
                            type: 'citation',
                            originalAttrs: {
                                item_id: itemId,
                                loc: readback.loc,
                                pageConvention: 'number',
                                ...(ci.label !== undefined ? { cslLabel: ci.label } : {}),
                            },
                        });
                        let tag = `<citation id="${itemId}"`;
                        if (readback.loc) tag += ` loc="${escapeAttr(readback.loc)}"`;
                        tag += ` ref="${ref}"/>`;
                        return tag;
                    }

                    const rawPage = ci.locator != null ? String(ci.locator) : '';
                    let page = rawPage;
                    let pageConvention: 'number' | 'label' | undefined = page ? 'label' : undefined;
                    const pageLabels = pageLabelsByItemId?.[itemId];
                    if (page && pageLabels && (ci.label == null || ci.label === 'page')) {
                        const translated = translatePageLabelToNumber(pageLabels, page);
                        if (translated !== rawPage) {
                            page = translated;
                            pageConvention = 'number';
                        }
                    }

                    metadata.elements.set(ref, {
                        rawHtml: match,
                        type: 'citation',
                        originalAttrs: {
                            item_id: itemId,
                            ...(page ? { page } : {}),
                            ...(pageConvention ? { pageConvention } : {}),
                            ...(ci.label !== undefined ? { cslLabel: ci.label } : {}),
                        },
                    });

                    let tag = `<citation id="${itemId}"`;
                    if (page) tag += ` loc="${escapeAttr(`page${page}`)}"`;
                    tag += ` ref="${ref}"/>`;
                    return tag;
                } else {
                    // Compound citation (multiple items). The ref and the
                    // items attribute name each item the same way.
                    const itemRefs = citationItems.map((ci: any) => citationItemRefFromUri(ci.uris?.[0] || '', libraryID));
                    const ref = nextRef(itemRefs.map((itemRef: { key: string } | null) => itemRef?.key ?? 'unknown').join('+'));

                    // Build items attribute: "LIB-KEY1:page=P1, LIB-KEY2:page=P2"
                    const itemsAttr = citationItems.map((ci: any, i: number) => {
                        const itemRef = itemRefs[i];
                        const itemId = modelObjectId(itemRef?.libraryID ?? libraryID, itemRef?.key ?? 'unknown');
                        let page = ci.locator != null ? String(ci.locator) : '';
                        const pageLabels = pageLabelsByItemId?.[itemId];
                        if (page && pageLabels && (ci.label == null || ci.label === 'page')) {
                            page = translatePageLabelToNumber(pageLabels, page);
                        }
                        return page ? `${itemId}:page=${page}` : itemId;
                    }).join(', ');

                    metadata.elements.set(ref, {
                        rawHtml: match,
                        type: 'compound-citation',
                        isCompound: true,
                        originalItems: itemsAttr,
                    });

                    let tag = `<citation items="${escapeAttr(itemsAttr)}"`;
                    tag += ` ref="${ref}"/>`;
                    return tag;
                }
            } catch {
                return match;
            }
        }
    );

    // 5.5. Replace self-linking anchors with a compact <link href="X"/> token.
    // Zotero auto-linkifies bare URLs typed into notes, producing
    // <a href="X" rel="...">X</a> where the visible text equals the href. The
    // verbose, URL-duplicating anchor is hard for the agent to copy verbatim
    // into edit_note old_string; the token is short and stable.
    // Annotation tokens are shielded first: a self-linking <a> could sit inside
    // an annotation's inner text, and rewriting it there would desync the
    // <annotation> tag from the stored originalText, breaking the equality
    // check in expandToRawHtml. Citations/images are self-closing tokens and
    // cannot contain a nested <a>.
    {
        const shieldedAnnotations: string[] = [];
        simplified = simplified.replace(
            /<annotation\s[^>]*>[\s\S]*?<\/annotation>/g,
            (annMatch) => {
                const idx = shieldedAnnotations.push(annMatch) - 1;
                return `__BEAVER_LINK_SHIELD_${idx}__`;
            }
        );
        // Link citations (notes, annotations, standalone attachments) are written
        // as `(<a …>label</a>, p. 6)`. The parenthesized form collapses into one
        // token, carrying the locator as `loc` rather than leaving `, p. 6` as
        // loose text: the link navigates to the page it was built with, so a
        // locator the agent can edit outside the token would move the visible
        // page while the link stayed behind. Only Beaver's own shape is
        // absorbed; any other text around the anchor is left where it was.
        simplified = simplified.replace(
            zoteroLinkCitationPattern(),
            (match, openParen, anchor, rawHref, rawSuffix, closeParen) => {
                const parsed = parseZoteroCitationLinkHref(rawHref);
                if (!parsed) return match;

                const suffix: string = rawSuffix ?? '';
                const suffixPage = parseLinkCitationPageSuffix(suffix);
                const wrapped = !!openParen && !!closeParen && (!suffix || suffixPage !== null);

                const itemId = modelObjectId(parsed.libraryId, parsed.itemKey);
                const ref = nextRef(parsed.itemKey);

                // The stored locator is a display label. Show the agent physical
                // page numbers where labels are known, as native citations do.
                const rawPage = wrapped && suffixPage ? suffixPage : '';
                let page = rawPage;
                let pageConvention: 'number' | 'label' | undefined = page ? 'label' : undefined;
                const pageLabels = pageLabelsByItemId?.[itemId];
                if (page && pageLabels) {
                    const translated = translatePageLabelToNumber(pageLabels, page);
                    if (translated !== rawPage) {
                        page = translated;
                        pageConvention = 'number';
                    }
                }

                metadata.elements.set(ref, {
                    rawHtml: wrapped ? match : anchor,
                    type: 'citation',
                    // Link citation labels are derived from the target item and
                    // preserved from rawHtml while the target id is unchanged.
                    originalAttrs: {
                        item_id: itemId,
                        ...(page ? { page, pageConvention } : {}),
                    },
                });

                const tag = `<citation id="${itemId}"`
                    + (page ? ` loc="${escapeAttr(`page${page}`)}"` : '')
                    + ` ref="${ref}"/>`;
                return wrapped ? tag : `${openParen ?? ''}${tag}${suffix}${closeParen ?? ''}`;
            }
        );
        simplified = simplified.replace(
            /<a\s+href="([^"]*)"\s+rel="[^"]*">([^<]*)<\/a>/g,
            (match, rawHref, rawText) => {
                // Decode both sides so entity-encoded ampersands etc. compare
                // equal. Only collapse genuine auto-linkified bare URLs: the
                // visible text must equal the href and the scheme must be
                // http(s) (exclude zotero://, mailto:, relative hrefs).
                const decodedHref = unescapeAttr(rawHref);
                const decodedText = unescapeAttr(rawText);
                if (decodedHref !== decodedText) return match;
                if (!/^https?:\/\//i.test(decodedHref)) return match;
                metadata.elements.set(`link:${decodedHref}`, {
                    rawHtml: match,
                    type: 'link',
                });
                // rawHref is already valid attribute encoding — use verbatim.
                return `<link href="${rawHref}"/>`;
            }
        );
        simplified = simplified.replace(
            /__BEAVER_LINK_SHIELD_(\d+)__/g,
            (m, idx) => shieldedAnnotations[Number(idx)] ?? m
        );
    }

    // 6. Simplify math to dollar notation
    // Strip HTML wrappers from math elements, leaving dollar-delimited content.
    // Empty math blocks (`$$$$` / `$$`) are intentionally left as HTML: the
    // expandToRawHtml regex requires non-empty content between `$` delimiters,
    // so simplifying them would break the round-trip (the expander can't
    // rewrap them, and edit_note old_string matching fails).
    // Display math: <pre class="math">$$...$$</pre> → $$...$$
    simplified = simplified.replace(
        /<pre\s+class="math">(\$\$[^<]+\$\$)<\/pre>/g,
        (_match, content) => content
    );
    // Inline math: <span class="math">$...$</span> → $...$
    simplified = simplified.replace(
        /<span\s+class="math">(\$[^<]+\$)<\/span>/g,
        (_match, content) => content
    );

    // 7. Strip the outer wrapper div.
    // Zotero notes are wrapped in <div data-schema-version="N">...</div>.
    // This wrapper is structural metadata, not content the agent should edit.
    // Stripping it prevents the agent from anchoring edits on </div>.
    simplified = stripNoteWrapperDiv(simplified);

    return { simplified, metadata };
}

/**
 * The annotation key a note highlight or annotation image names, if any.
 * Highlights made by dragging a reader text selection into a note have none:
 * they point at a position in the file, not at an annotation item.
 */
function annotationKeyOf(annotationData: any): string | undefined {
    const key = annotationData?.annotationKey;
    return isItemKey(key) ? key : undefined;
}

/** A `url` attribute naming a web URI a citation cites its work by, or nothing. */
function urlAttr(uri: string): string {
    return /^https?:\/\//i.test(uri) ? ` url="${escapeAttr(uri)}"` : '';
}

/**
 * A short label for an embedded work from its CSL data: "Smith et al. 2020,
 * Title". Empty when the data names neither authors, year nor title.
 */
function embeddedWorkLabel(csl: Record<string, unknown> | undefined): string {
    if (!csl) return '';
    const authors = Array.isArray(csl.author) ? csl.author as Array<Record<string, unknown>> : [];
    const first = authors[0];
    const firstName = typeof first?.family === 'string' ? first.family
        : typeof first?.literal === 'string' ? first.literal : '';
    const author = firstName ? `${firstName}${authors.length > 1 ? ' et al.' : ''}` : '';
    const issued = csl.issued as { 'date-parts'?: unknown[][] } | undefined;
    const year = issued?.['date-parts']?.[0]?.[0];
    const byline = [author, year != null ? String(year) : ''].filter(Boolean).join(' ');
    const rawTitle = typeof csl.title === 'string' ? csl.title.replace(/\s+/g, ' ').trim() : '';
    const title = rawTitle.length > 80 ? `${rawTitle.slice(0, 77).trimEnd()}...` : rawTitle;
    return [byline, title].filter(Boolean).join(', ');
}

/**
 * Whether an item is known not to exist. An item that cannot be looked up
 * (its library is not loaded) is not reported missing.
 */
function isMissingItem(libraryID: number, key: string): boolean {
    try {
        return !Zotero.Items.getByLibraryAndKey(libraryID, key);
    } catch {
        return false;
    }
}

/**
 * Returns a function that makes element ids unique within one note: the first
 * use of a base id is returned as is, later ones get `_2`, `_3`, …. Several
 * highlights can share a base id (key-less highlights, or one annotation added
 * to the note twice), and each needs its own entry in the metadata map.
 */
function uniqueElementIdFactory(metadata: SimplificationMetadata): (base: string) => string {
    return (base: string) => {
        let id = base;
        for (let n = 2; metadata.elements.has(id); n++) id = `${base}_${n}`;
        return id;
    };
}

/**
 * Generate a label for a citation when the visible text is empty/just parentheses.
 * This happens when ProseMirror round-trips citations: the atom node's toDOM
 * regenerates visible text from data-citation attrs, and if itemData is missing
 * (schema v2+ strips it into the container), the output is just "()".
 *
 * Uses Zotero.EditorInstanceUtilities.formatCitation when available (produces
 * "(<span class='citation-item'>Author, Year</span>)"), falling back to a
 * minimal "Author, Year" format from CSL-JSON data.
 */
function generateCitationLabel(citationData: any): string {
    // Try using Zotero's formatter if available
    try {
        const citationItems = citationData.citationItems || [];
        // Ensure each item has itemData — look up from library if missing
        const enriched = citationItems.map((ci: any) => {
            if (ci.itemData) return ci;
            const uri = ci.uris?.[0];
            if (!uri) return ci;
            const itemInfo = (Zotero.URI as any).getURIItemLibraryKey(uri);
            if (!itemInfo) return ci;
            const item = Zotero.Items.getByLibraryAndKey(itemInfo.libraryID, itemInfo.key);
            if (!item) return ci;
            return { ...ci, itemData: Zotero.Utilities.Item.itemToCSLJSON(item) };
        });

        const enrichedCitation = { ...citationData, citationItems: enriched };
        const formatted = Zotero.EditorInstanceUtilities.formatCitation(enrichedCitation);
        // Strip HTML tags from the formatted output
        const text = formatted.replace(/<[^>]+>/g, '').trim();
        if (text && text !== '()') return text;
    } catch {
        // Fall through to manual construction
    }
    return '()';
}

// =============================================================================
// Utility: Count Occurrences
// =============================================================================

export function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let pos = 0;
    while ((pos = haystack.indexOf(needle, pos)) !== -1) {
        count++;
        pos += needle.length;
    }
    return count;
}
