import React, { useState, useEffect } from 'react';
import {
    AttachmentSearchReference,
    AttachmentMatchSummary,
} from '../../agents/toolResultTypes';
import { CSSItemTypeIcon, ArrowDownIcon, ArrowRightIcon, ExternalLinkIcon, Icon } from '../icons/icons';
import { getDisplayNameFromItem, revealSource } from '../../utils/sourceUtils';
import { navigateToAttachmentMatch } from '../../utils/attachmentMatchNavigation';
import { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';
import { EXTERNAL_LIBRARY_ID } from '../../../src/services/externalFiles';
import { EXTERNAL_FILE_ICON_BY_KIND } from '../input/ExternalFileButton';
import { launchExternalFile } from '../../host/zotero/sourceActions';

interface FindInAttachmentsResultViewProps {
    query: string;
    totalMatches: number;
    attachmentCount: number;
    attachments: AttachmentSearchReference[];
}

interface ResolvedAttachment {
    ref: AttachmentSearchReference;
    /** Parent item display name ("Smith 2024"); external filename; or key when unresolved. */
    displayName: string;
    iconType: string | null;
    /**
     * The reference points to something we recognize and that carries a real
     * search status — a Zotero item that exists, or any external file (the
     * search already ran). False only for a Zotero attachment no longer in the
     * library, which has no status to show.
     */
    resolved: boolean;
    /** Can the user click to open/reveal it (Zotero item exists, or external copy present)? */
    openable: boolean;
    /** External file (library_id === EXTERNAL_LIBRARY_ID); zotero_key holds the ext key. */
    isExternal: boolean;
}

/** Whether the attachment contributes match rows to the primary list. */
function hasMatchRows(att: ResolvedAttachment): boolean {
    return att.resolved && att.ref.status === 'ok' && att.ref.matches.length > 0;
}

/**
 * Status pill on the attachment header row: soft blue for match counts,
 * faint grey for negative outcomes ("no matches" / "could not be searched").
 * Colors come from the theme-aware tag/fill variables so both modes work.
 */
const StatusBadge: React.FC<{ text: string; variant: 'match' | 'muted' }> = ({ text, variant }) => (
    <span
        className="text-xs px-2 py-05 rounded-md whitespace-nowrap"
        style={variant === 'match'
            ? {
                backgroundColor: 'var(--tag-blue-quinary)',
                border: '1px solid var(--tag-blue-tertiary)',
                color: 'var(--tag-blue)',
            }
            : {
                backgroundColor: 'var(--fill-quinary)',
                color: 'var(--fill-secondary)',
            }}
    >
        {text}
    </span>
);

function attachmentStatusText(att: ResolvedAttachment): string {
    if (!att.resolved) return 'not in library';
    switch (att.ref.status) {
        case 'error':
            return 'search error';
        case 'no_matches':
            return 'no matches';
        default:
            return att.ref.match_count === 1 ? '1 match' : `${att.ref.match_count} matches`;
    }
}

function matchPageText(match: AttachmentMatchSummary): string {
    const page = match.page_label ?? (match.page_number !== undefined ? String(match.page_number) : null);
    return page ? `Page ${page}` : '';
}

/**
 * Word-token boundary shared with the backend, which tokenizes on `\w+` with
 * Python's Unicode-aware `re` (letters, digits, underscore). JS `\w` is
 * ASCII-only even under the `u` flag, so a Unicode property class is used to
 * keep non-ASCII terms (e.g. "Müller", "café", CJK) as single tokens and match
 * the backend's query terms exactly.
 */
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/**
 * Tokenize the query the same way the backend search does — lowercase Unicode
 * word tokens, no stemming or stopword filtering — so the tokens we highlight
 * are exactly the terms BM25 matched on. Keeps the preview highlight faithful
 * to which words actually drove the match.
 */
function queryTokenSet(query: string): Set<string> {
    const terms = new Set<string>();
    for (const m of query.toLowerCase().matchAll(TOKEN_RE)) {
        terms.add(m[0]);
    }
    return terms;
}

/** Leading context kept before the first hit when re-anchoring a preview. */
const PREVIEW_LEAD_CHARS = 20;

/**
 * Re-anchor a centered preview so the first query-term hit sits near the start.
 * The backend centers the snippet on the match, but the row renders on a single
 * truncated line whose visible width tracks the sidebar — a centered hit can
 * fall past the cut and never show on a narrow sidebar. Dropping most leading
 * context (to the word boundary before the hit) keeps the hit visible at any
 * width and lets a wider sidebar reveal trailing context, the useful direction.
 */
function anchorSnippetOnMatch(snippet: string, terms: Set<string>): string {
    if (terms.size === 0) return snippet;
    let hit = -1;
    for (const m of snippet.matchAll(TOKEN_RE)) {
        if (terms.has(m[0].toLowerCase())) {
            hit = m.index;
            break;
        }
    }
    if (hit <= PREVIEW_LEAD_CHARS) return snippet; // already near the start
    let cut = hit - PREVIEW_LEAD_CHARS;
    const space = snippet.indexOf(' ', cut);
    if (space !== -1 && space < hit) cut = space + 1;
    return '… ' + snippet.slice(cut).replace(/^…\s*/, '');
}

/**
 * Render a snippet with query-term hits highlighted. Splits on the same `\w+`
 * boundary the backend tokenizer uses and wraps any token whose lowercase form
 * is a query term; characters between tokens are emitted verbatim so the text
 * is unchanged apart from the marks.
 */
function highlightSnippet(snippet: string, terms: Set<string>): React.ReactNode {
    if (terms.size === 0) return snippet;
    const nodes: React.ReactNode[] = [];
    let lastIndex = 0;
    let key = 0;
    for (const m of snippet.matchAll(TOKEN_RE)) {
        const token = m[0];
        const start = m.index;
        if (start > lastIndex) nodes.push(snippet.slice(lastIndex, start));
        if (terms.has(token.toLowerCase())) {
            nodes.push(
                <mark
                    key={key++}
                    style={{
                        backgroundColor: 'var(--tag-yellow-tertiary)',
                        color: 'var(--fill-primary)',
                        borderRadius: '2px',
                    }}
                >
                    {token}
                </mark>
            );
        } else {
            nodes.push(token);
        }
        lastIndex = start + token.length;
    }
    if (lastIndex < snippet.length) nodes.push(snippet.slice(lastIndex));
    return nodes;
}

function pluralize(count: number, noun: string): string {
    if (count === 1) return `${count} ${noun}`;
    const plural = /(?:ch|sh|s|x|z)$/i.test(noun) ? `${noun}es` : `${noun}s`;
    return `${count} ${plural}`;
}

/**
 * Renders the result of the find_in_attachments tool (keyword search across
 * attachments). One header row per attachment — the bibliographic parent's
 * display name, clickable to reveal the attachment in the library — with the
 * returned matches nested below it behind an indent guide. Clicking a match
 * opens the reader at the matched location and highlights it (PDF bounding
 * boxes / EPUB passage). Documents without matches collapse into a single
 * toggle row so negative results don't crowd out the hits.
 */
export const FindInAttachmentsResultView: React.FC<FindInAttachmentsResultViewProps> = ({
    query,
    totalMatches,
    attachments,
}) => {
    const queryTerms = React.useMemo(() => queryTokenSet(query), [query]);
    const [resolved, setResolved] = useState<ResolvedAttachment[]>([]);
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const [showNoMatches, setShowNoMatches] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const resolve = async () => {
            const items: ResolvedAttachment[] = [];
            for (const ref of attachments) {
                // Sentinel references (library_id === EXTERNAL_LIBRARY_ID) are
                // user-attached external files, not Zotero items: resolve the
                // filename/icon from the external-files store, not the library.
                if (ref.library_id === EXTERNAL_LIBRARY_ID) {
                    const record = await Zotero.Beaver?.db
                        ?.getExternalFileByKey(ref.zotero_key)
                        .catch(() => null);
                    const copyExists = record
                        ? await IOUtils.exists(record.storedPath).catch(() => false)
                        : false;
                    items.push({
                        ref,
                        displayName: record?.filename ?? `Attached file (ext-${ref.zotero_key})`,
                        iconType: (record?.contentKind && EXTERNAL_FILE_ICON_BY_KIND[record.contentKind])
                            || 'attachmentFile',
                        resolved: true,
                        openable: copyExists,
                        isExternal: true,
                    });
                    continue;
                }

                let item: Zotero.Item | false | undefined;
                try {
                    item = await Zotero.Items.getByLibraryAndKeyAsync(
                        ref.library_id,
                        ref.zotero_key
                    );
                } catch (error) {
                    logger(`FindInAttachmentsResultView: failed to resolve ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
                }
                if (!item) {
                    items.push({
                        ref,
                        displayName: ref.zotero_key,
                        iconType: null,
                        resolved: false,
                        openable: false,
                        isExternal: false,
                    });
                    continue;
                }

                // getByLibraryAndKeyAsync only guarantees primaryData. Resolve
                // the bibliographic parent asynchronously and load the data
                // getDisplayNameFromItem reads (itemData, creators); a display
                // failure degrades the label, not the row's click behavior.
                let displayItem = item;
                let displayName: string;
                try {
                    if (item.parentItemID) {
                        displayItem = (await Zotero.Items.getAsync(item.parentItemID)) || item;
                    }
                    await displayItem.loadDataType('itemData');
                    if (displayItem.isRegularItem()) {
                        await displayItem.loadDataType('creators');
                    }
                    displayName = getDisplayNameFromItem(displayItem);
                } catch (error) {
                    logger(`FindInAttachmentsResultView: failed to load display data for ${ref.library_id}-${ref.zotero_key}: ${error}`, 1);
                    displayName = displayItem.getDisplayTitle?.() || ref.zotero_key;
                }
                let iconType: string | null = null;
                try {
                    iconType = displayItem.getItemTypeIconName();
                } catch {
                    // Icon is cosmetic; render the row without one.
                }
                items.push({
                    ref,
                    displayName,
                    iconType,
                    resolved: true,
                    openable: true,
                    isExternal: false,
                });
            }
            if (!cancelled) setResolved(items);
        };
        resolve();
        return () => { cancelled = true; };
    }, [attachments]);

    if (attachments.length === 0) {
        return (
            <div className="p-3 text-sm font-color-secondary">
                No matches found
            </div>
        );
    }

    const handleAttachmentClick = (att: ResolvedAttachment) => {
        if (!att.openable) return;
        // External files have no library entry to reveal — open the file copy.
        if (att.isExternal) {
            launchExternalFile(att.ref.zotero_key).catch((error) => {
                logger(`FindInAttachmentsResultView: failed to open external file ext-${att.ref.zotero_key}: ${error}`, 1);
            });
            return;
        }
        try {
            revealSource({
                library_id: att.ref.library_id,
                zotero_key: att.ref.zotero_key,
            } as ZoteroItemReference);
        } catch (error) {
            logger(`FindInAttachmentsResultView: failed to reveal ${att.ref.library_id}-${att.ref.zotero_key}: ${error}`, 1);
        }
    };

    const handleMatchClick = async (
        att: ResolvedAttachment,
        match: AttachmentMatchSummary,
        e: React.MouseEvent
    ) => {
        if (!att.openable) return;
        // In-reader navigation/highlight is not wired for external files (they
        // open in the OS viewer, not Zotero's reader) — open the file instead.
        if (att.isExternal) {
            launchExternalFile(att.ref.zotero_key).catch((error) => {
                logger(`FindInAttachmentsResultView: failed to open external file ext-${att.ref.zotero_key}: ${error}`, 1);
            });
            return;
        }
        const ownerDocument = e.currentTarget.ownerDocument;
        try {
            await navigateToAttachmentMatch({
                library_id: att.ref.library_id,
                zotero_key: att.ref.zotero_key,
                content_kind: att.ref.content_kind,
                page_number: match.page_number,
                page_label: match.page_label,
                target: match.target,
                snippet: match.snippet,
                ownerDocument,
            });
        } catch (error) {
            logger(`FindInAttachmentsResultView: failed to navigate to match in ${att.ref.library_id}-${att.ref.zotero_key}: ${error}`, 1);
        }
    };

    const renderAttachment = (att: ResolvedAttachment) => {
        const attKey = `${att.ref.library_id}-${att.ref.zotero_key}`;
        const isHovered = hoveredKey === attKey;
        const clickable = att.openable;
        const title = !clickable
            ? undefined
            : att.isExternal ? 'Click to open the file' : 'Click to reveal in Zotero';
        return (
            <React.Fragment key={attKey}>
                <div
                    className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 transition-colors duration-150 ${clickable ? 'cursor-pointer' : 'opacity-50'} ${isHovered && clickable ? 'bg-quinary' : ''}`}
                    onClick={() => handleAttachmentClick(att)}
                    onMouseEnter={() => setHoveredKey(attKey)}
                    onMouseLeave={() => setHoveredKey(null)}
                    title={title}
                >
                    {att.iconType && (
                        <span className="scale-75" style={{ marginTop: '-2px' }}>
                            <CSSItemTypeIcon itemType={att.iconType} />
                        </span>
                    )}
                    <div className="truncate text-sm font-color-primary">
                        {att.displayName}
                    </div>
                    {att.isExternal && (
                        <Icon
                            icon={ExternalLinkIcon}
                            size={12}
                            className="font-color-primary scale-85"
                            style={{ marginTop: '2px' }}
                        />
                    )}
                    <div className="flex-1" />
                    <StatusBadge
                        text={attachmentStatusText(att)}
                        variant={hasMatchRows(att) ? 'match' : 'muted'}
                    />
                </div>
                {att.resolved && att.ref.status === 'error' && att.ref.error && (
                    <div className="display-flex flex-row min-w-0 ml-3 border-left-quarternary">
                        <div className="text-sm font-color-secondary px-25 py-2">
                            {att.ref.error}
                        </div>
                    </div>
                )}
                {att.ref.status === 'ok' && att.ref.matches.length > 0 && (
                    <div className="display-flex flex-col min-w-0 ml-3 border-left-quarternary">
                        {att.ref.matches.map((match, index) => {
                            const matchKey = `${attKey}-m${index}`;
                            const matchHovered = hoveredKey === matchKey;
                            const pageText = matchPageText(match);
                            return (
                                <div
                                    key={matchKey}
                                    className={`display-flex flex-row items-baseline gap-2 min-w-0 px-25 py-2 rounded-sm transition user-select-none ${clickable ? 'cursor-pointer' : 'opacity-50'} ${matchHovered && clickable ? 'bg-quinary' : ''}`}
                                    onClick={(e) => handleMatchClick(att, match, e)}
                                    onMouseEnter={() => setHoveredKey(matchKey)}
                                    onMouseLeave={() => setHoveredKey(null)}
                                >
                                    <div className="text-sm truncate min-w-0 flex-1 font-color-secondary">
                                        &ldquo;{highlightSnippet(anchorSnippetOnMatch(match.snippet, queryTerms), queryTerms)}&rdquo;
                                    </div>
                                    {pageText && (
                                        <div className="text-sm font-color-secondary whitespace-nowrap">
                                            {pageText}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </React.Fragment>
        );
    };

    const positive = resolved.filter(hasMatchRows);
    const negative = resolved.filter(att => !hasMatchRows(att));
    // Collapsing only makes sense when there are hits to keep in focus; when
    // nothing matched, the negative rows ARE the result — show them directly.
    const collapseNegative = positive.length > 0 && negative.length > 0;
    const errorCount = negative.filter(att => att.resolved && att.ref.status === 'error').length;
    const toggleHovered = hoveredKey === '__no-matches-toggle';
    const toggleLabel = `${showNoMatches ? 'Hide' : 'Show'} ${pluralize(negative.length, 'document')} without matches`
        + (errorCount > 0 ? ` (${errorCount} could not be searched)` : '');

    const returnedMatches = attachments.reduce((sum, att) => sum + att.matches.length, 0);
    const documentsWithMatches = attachments.filter(att => att.matches.length > 0).length;
    const footerText = returnedMatches === totalMatches
        ? `${pluralize(totalMatches, 'match')} found across ${pluralize(documentsWithMatches, 'document')}`
        : `Showing ${returnedMatches} of ${totalMatches} matches across ${pluralize(documentsWithMatches, 'document')}`;

    return (
        <div className="display-flex flex-col min-w-0">
            {(collapseNegative ? positive : resolved).map(renderAttachment)}
            {collapseNegative && (
                <>
                    <div
                        className={`display-flex flex-row gap-1 items-center min-w-0 px-15 py-15 cursor-pointer transition-colors duration-150 ${toggleHovered ? 'bg-quinary' : ''}`}
                        onClick={() => setShowNoMatches(v => !v)}
                        onMouseEnter={() => setHoveredKey('__no-matches-toggle')}
                        onMouseLeave={() => setHoveredKey(null)}
                    >
                        <Icon icon={showNoMatches ? ArrowDownIcon : ArrowRightIcon} size={12} />
                        <div className="text-sm font-color-secondary">
                            {toggleLabel}
                        </div>
                    </div>
                    {showNoMatches && negative.map(renderAttachment)}
                </>
            )}
            {totalMatches > 0 && (
                <div className="display-flex flex-row px-15 py-2">
                    <div className="flex-1" />
                    <div className="text-sm font-color-secondary">
                        {footerText}
                    </div>
                </div>
            )}
        </div>
    );
};

export default FindInAttachmentsResultView;
