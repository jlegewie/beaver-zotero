import React, { useState, useEffect } from 'react';
import {
    AttachmentSearchReference,
    AttachmentMatchSummary,
} from '../../agents/toolResultTypes';
import { CSSItemTypeIcon, ArrowDownIcon, ArrowRightIcon, Icon } from '../icons/icons';
import { getDisplayNameFromItem, revealSource } from '../../utils/sourceUtils';
import { navigateToAttachmentMatch } from '../../utils/attachmentMatchNavigation';
import { ZoteroItemReference } from '../../types/zotero';
import { logger } from '../../../src/utils/logger';

interface FindInAttachmentsResultViewProps {
    query: string;
    totalMatches: number;
    attachmentCount: number;
    attachments: AttachmentSearchReference[];
}

interface ResolvedAttachment {
    ref: AttachmentSearchReference;
    /** Parent item display name ("Smith 2024"); zotero_key when unresolved. */
    displayName: string;
    iconType: string | null;
    /** False when the attachment no longer exists in the local library. */
    resolved: boolean;
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
            return 'could not be searched';
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
    totalMatches,
    attachments,
}) => {
    const [resolved, setResolved] = useState<ResolvedAttachment[]>([]);
    const [hoveredKey, setHoveredKey] = useState<string | null>(null);
    const [showNoMatches, setShowNoMatches] = useState(false);

    useEffect(() => {
        let cancelled = false;
        const resolve = async () => {
            const items: ResolvedAttachment[] = [];
            for (const ref of attachments) {
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
                items.push({ ref, displayName, iconType, resolved: true });
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
        if (!att.resolved) return;
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
        if (!att.resolved) return;
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
        const clickable = att.resolved;
        return (
            <React.Fragment key={attKey}>
                <div
                    className={`display-flex flex-row gap-1 items-start min-w-0 px-15 py-15 transition-colors duration-150 ${clickable ? 'cursor-pointer' : 'opacity-50'} ${isHovered && clickable ? 'bg-quinary' : ''}`}
                    onClick={() => handleAttachmentClick(att)}
                    onMouseEnter={() => setHoveredKey(attKey)}
                    onMouseLeave={() => setHoveredKey(null)}
                    title={clickable ? 'Click to reveal in Zotero' : undefined}
                >
                    {att.iconType && (
                        <span className="scale-75" style={{ marginTop: '-2px' }}>
                            <CSSItemTypeIcon itemType={att.iconType} />
                        </span>
                    )}
                    <div className="truncate text-sm font-color-primary">
                        {att.displayName}
                    </div>
                    <div className="flex-1" />
                    <StatusBadge
                        text={attachmentStatusText(att)}
                        variant={hasMatchRows(att) ? 'match' : 'muted'}
                    />
                </div>
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
                                        &ldquo;{match.snippet}&rdquo;
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
