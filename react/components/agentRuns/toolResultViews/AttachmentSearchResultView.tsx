import React, { useState } from 'react';
import { CSSItemTypeIcon, ArrowDownIcon, ArrowRightIcon, ExternalLinkIcon, Icon } from '../../icons/icons';
import { itemTypeToIconName, ContentKind } from '../../../types/citations';
import {
    AttachmentSearchView,
    AttachmentSearchRowView,
    AttachmentMatchView,
} from '../../../types/toolResultViews';
import { getHost } from '../../../host';

/**
 * Shared renderer for the {@link AttachmentSearchView} view model
 * (find_in_attachments).
 *
 * Each attachment renders as a header row with nested matches. Reveal/open and
 * match navigation route through the navigation host.
 */

/**
 * Word-token boundary shared with the backend tokenizer (Unicode letters,
 * digits, underscore).
 */
const TOKEN_RE = /[\p{L}\p{N}_]+/gu;

/** Leading context kept before the first hit when re-anchoring a preview. */
const PREVIEW_LEAD_CHARS = 20;

function queryTokenSet(query: string): Set<string> {
    const terms = new Set<string>();
    for (const m of query.toLowerCase().matchAll(TOKEN_RE)) {
        terms.add(m[0]);
    }
    return terms;
}

/** Move the first query-term hit toward the start of a long preview. */
function anchorSnippetOnMatch(snippet: string, terms: Set<string>): string {
    if (terms.size === 0) return snippet;
    let hit = -1;
    for (const m of snippet.matchAll(TOKEN_RE)) {
        if (terms.has(m[0].toLowerCase())) {
            hit = m.index;
            break;
        }
    }
    if (hit <= PREVIEW_LEAD_CHARS) return snippet;
    let cut = hit - PREVIEW_LEAD_CHARS;
    const space = snippet.indexOf(' ', cut);
    if (space !== -1 && space < hit) cut = space + 1;
    return '… ' + snippet.slice(cut).replace(/^…\s*/, '');
}

/** Render a snippet with query-term hits highlighted. */
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

function matchPageText(match: AttachmentMatchView): string {
    const page = match.page_label ?? (match.page_number != null ? String(match.page_number) : null);
    return page ? `Page ${page}` : '';
}

/** Whether the attachment contributes match rows to the primary list. */
function hasMatchRows(row: AttachmentSearchRowView): boolean {
    return row.status === 'ok' && row.matches.length > 0;
}

function attachmentStatusText(row: AttachmentSearchRowView): string {
    switch (row.status) {
        case 'error':
            return 'search error';
        case 'no_matches':
            return 'no matches';
        default:
            return row.match_count === 1 ? '1 match' : `${row.match_count} matches`;
    }
}

/** Icon name for an attachment-search result row. */
function iconFor(row: AttachmentSearchRowView): string {
    return itemTypeToIconName(row.item_type ?? 'attachment', row.content_kind as ContentKind);
}

/** Status pill on the attachment header row. */
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

export const AttachmentSearchResultView: React.FC<{ view: AttachmentSearchView }> = ({ view }) => {
    const queryTerms = React.useMemo(() => queryTokenSet(view.query), [view.query]);
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const [showNoMatches, setShowNoMatches] = useState(false);

    const attachments = view.attachments;

    if (attachments.length === 0) {
        return (
            <div className="p-3 text-sm font-color-secondary">
                No matches found
            </div>
        );
    }

    const handleAttachmentClick = (row: AttachmentSearchRowView) => {
        if (row.is_external) {
            getHost().navigation?.launchExternalFile(row.zotero_key);
            return;
        }
        getHost().navigation?.revealInLibrary({ library_id: row.library_id, zotero_key: row.zotero_key });
    };

    const handleMatchClick = (
        row: AttachmentSearchRowView,
        match: AttachmentMatchView,
        e: React.MouseEvent,
    ) => {
        // External files open in the OS viewer (no in-reader navigation).
        if (row.is_external) {
            getHost().navigation?.launchExternalFile(row.zotero_key);
            return;
        }
        getHost().navigation?.navigateToAttachmentMatch({
            library_id: row.library_id,
            zotero_key: row.zotero_key,
            content_kind: row.content_kind,
            page_number: match.page_number,
            page_label: match.page_label,
            target: match.target,
            snippet: match.snippet,
            ownerDocument: e.currentTarget.ownerDocument,
        });
    };

    const renderAttachment = (row: AttachmentSearchRowView) => {
        const attKey = `${row.library_id}-${row.zotero_key}`;
        const isHovered = hoveredKey === attKey;
        const title = row.is_external ? 'Click to open the file' : 'Click to reveal in Zotero';
        return (
            <React.Fragment key={attKey}>
                <div
                    className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 cursor-pointer transition-colors duration-150 ${isHovered ? 'bg-quinary' : ''}`}
                    onClick={() => handleAttachmentClick(row)}
                    onMouseEnter={() => setHoveredKey(attKey)}
                    onMouseLeave={() => setHoveredKey(null)}
                    title={title}
                >
                    <span className="scale-75" style={{ marginTop: '-2px' }}>
                        <CSSItemTypeIcon itemType={iconFor(row)} />
                    </span>
                    <div className="truncate text-sm font-color-primary">
                        {row.display_name}
                    </div>
                    {row.is_external && (
                        <Icon
                            icon={ExternalLinkIcon}
                            size={12}
                            className="font-color-primary scale-85"
                            style={{ marginTop: '2px' }}
                        />
                    )}
                    <div className="flex-1" />
                    <StatusBadge
                        text={attachmentStatusText(row)}
                        variant={hasMatchRows(row) ? 'match' : 'muted'}
                    />
                </div>
                {row.status === 'error' && row.error && (
                    <div className="display-flex flex-row min-w-0 ml-3 border-left-quarternary">
                        <div className="text-sm font-color-secondary px-25 py-2">
                            {row.error}
                        </div>
                    </div>
                )}
                {row.status === 'ok' && row.matches.length > 0 && (
                    <div className="display-flex flex-col min-w-0 ml-3 border-left-quarternary">
                        {row.matches.map((match, index) => {
                            const matchKey = `${attKey}-m${index}`;
                            const matchHovered = hoveredKey === matchKey;
                            const pageText = matchPageText(match);
                            return (
                                <div
                                    key={matchKey}
                                    className={`display-flex flex-row items-baseline gap-2 min-w-0 px-25 py-2 rounded-sm transition user-select-none cursor-pointer ${matchHovered ? 'bg-quinary' : ''}`}
                                    onClick={(e) => handleMatchClick(row, match, e)}
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

    const positive = attachments.filter(hasMatchRows);
    const negative = attachments.filter((row) => !hasMatchRows(row));
    // Show negative rows directly when they are the whole result.
    const collapseNegative = positive.length > 0 && negative.length > 0;
    const errorCount = negative.filter((row) => row.status === 'error').length;
    const toggleHovered = hoveredKey === '__no-matches-toggle';
    const toggleLabel = `${showNoMatches ? 'Hide' : 'Show'} ${pluralize(negative.length, 'document')} without matches`
        + (errorCount > 0 ? ` (${errorCount} could not be searched)` : '');

    const returnedMatches = attachments.reduce((sum, row) => sum + row.matches.length, 0);
    const documentsWithMatches = attachments.filter((row) => row.matches.length > 0).length;
    const footerText = returnedMatches === view.total_matches
        ? `${pluralize(view.total_matches, 'match')} found across ${pluralize(documentsWithMatches, 'document')}`
        : `Showing ${returnedMatches} of ${view.total_matches} matches across ${pluralize(documentsWithMatches, 'document')}`;

    return (
        <div className="display-flex flex-col min-w-0">
            {(collapseNegative ? positive : attachments).map(renderAttachment)}
            {collapseNegative && (
                <>
                    <div
                        className={`display-flex flex-row gap-1 items-center min-w-0 px-15 py-15 cursor-pointer transition-colors duration-150 ${toggleHovered ? 'bg-quinary' : ''}`}
                        onClick={() => setShowNoMatches((v) => !v)}
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
            {view.total_matches > 0 && (
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

export default AttachmentSearchResultView;
