import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import { type ItemListRow } from '@beaver/agent-core/run-state/toolResultViews';
import { logger } from '@beaver/agent-core/platform/logger';
import { effectiveMaxFileSizeMB, effectiveMaxPageCount } from '@beaver/agent-core/transport/attachmentLimits';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { ArrowDownIcon, ArrowLeftIcon, ArrowRightIcon, Icon, SyncIcon } from '../icons/icons';
import { hydrateItemListRows } from '../../compat/legacyToolResults';
import ItemListResultView from '../agentRuns/toolResultViews/ItemListResultView';
import { activePreferencePageTabAtom } from '../../atoms/ui';
import {
    isRetryableProcessingIssue,
    type AttachmentRef,
    type ProcessingIssueSummary,
    type ProcessingIssueReason,
} from '../../../src/services/backgroundProcessing/issues';

const PAGE_SIZE = 10;

interface ReasonCopy {
    title: string;
    description: string;
    /** Offer the plan page: the remedy is an entitlement, not a file fix. */
    plansLink?: boolean;
}

/** Title and one-line explanation per reason, as shown in preferences. */
function reasonCopy(reason: ProcessingIssueReason, hasOcrAccess: boolean): ReasonCopy {
    switch (reason) {
        case 'scanned':
            return {
                title: 'Scanned files without a text layer',
                description: hasOcrAccess
                    ? 'These files contain only images of text.'
                    : 'OCR can turn scans into readable, searchable text. It is included with eligible plans.',
                plansLink: !hasOcrAccess,
            };
        case 'no_text':
            return {
                title: 'No readable text',
                description: 'The file did not yield any readable text.',
            };
        case 'file_unavailable':
            return {
                title: 'File not available',
                description: 'The attachment is missing on this computer or could not be downloaded. Retry after restoring the file.',
            };
        case 'encrypted':
            return {
                title: 'Password protected',
                description: 'Encrypted files cannot be read. Beaver re-reads a file if it is replaced.',
            };
        case 'too_large':
            return {
                title: 'Too large to process',
                description: `These files exceed the ${effectiveMaxPageCount().toLocaleString()}-page or ${effectiveMaxFileSizeMB().toLocaleString()} MB limit.`,
            };
        case 'unsupported':
            return {
                title: 'Unsupported file type',
                description: 'Beaver reads PDFs, EPUBs and web snapshots.',
            };
        case 'ocr_failed':
            return {
                title: 'OCR failed',
                description: 'Text recognition did not succeed for these scans.',
            };
        case 'index_failed':
            return {
                title: 'Not added to the search index',
                description: 'These files were read but could not be uploaded to the cloud search index.',
            };
        case 'extract_failed':
        default:
            return {
                title: 'Could not extract text',
                description: 'Beaver ran into an error while reading these files.',
            };
    }
}

/**
 * One page of an issue group's attachments, rendered with the shared item-list
 * rows so they look and behave like items anywhere else in Beaver: parent
 * headline, title underneath, click to reveal in Zotero.
 *
 * Titles are resolved locally per page; this is a render path over persisted
 * ledger rows, so it is deliberately not gated on library exclusion.
 */
const ProcessingIssuePage: React.FC<{
    page: number;
    reason: ProcessingIssueReason;
    hasOcrAccess: boolean;
    hasSearchAccess: boolean;
    updatedAt: number | null;
    /** Present only for retryable reasons; renders a per-row retry icon. */
    onRetry?: (refs: AttachmentRef[]) => Promise<void>;
}> = ({ page, reason, hasOcrAccess, hasSearchAccess, updatedAt, onRetry }) => {
    const [rows, setRows] = useState<ItemListRow[] | null>(null);
    const [error, setError] = useState(false);
    const pageRef = useRef<HTMLDivElement>(null);

    useLayoutEffect(() => {
        const element = pageRef.current;
        if (!element) return;
        // Reserve the tallest page until the group closes, including loading
        // and the shorter final page, so pagination cannot collapse the scroller.
        element.style.minHeight = `${element.getBoundingClientRect().height}px`;
    }, [rows]);

    useEffect(() => {
        let cancelled = false;
        setRows(null);
        setError(false);
        const load = async () => {
            const db = Zotero.Beaver?.db;
            if (!db) throw new Error('db not available');
            const pageItems = await db.getProcessingIssuePage(
                { hasOcrAccess, hasSearchIndexAccess: hasSearchAccess }, reason, page * PAGE_SIZE, PAGE_SIZE,
            );
            if (cancelled) return [];
            return hydrateItemListRows(pageItems.map((item) => ({
                ref: { library_id: item.libraryId, zotero_key: item.zoteroKey },
                headline: 'parent',
            })));
        };
        void load()
            .then((hydrated) => {
                if (!cancelled) {
                    setRows(hydrated);
                }
            })
            .catch((error) => {
                logger(`ProcessingIssueList: failed to resolve items: ${error}`, 1);
                if (!cancelled) {
                    setError(true);
                    setRows([]);
                }
            });
        return () => { cancelled = true; };
    }, [page, reason, hasOcrAccess, hasSearchAccess, updatedAt]);

    return (
        <div ref={pageRef} aria-busy={rows === null} style={{ overflowAnchor: 'none' }}>
            {error ? <div className="p-2 text-sm font-color-tertiary">Could not load files. Beaver will try again shortly.</div> : rows === null
                ? <div className="p-2 text-sm font-color-tertiary">Loading…</div>
                : <ItemListResultView
                    view={{ view_type: 'item_list', tool_name: 'background_processing', items: rows }}
                    rowAction={onRetry && ((row) => (
                        <IconButton
                            icon={SyncIcon}
                            variant="ghost-secondary"
                            className="scale-11 mr-1"
                            ariaLabel={`Retry ${row.display_name}`}
                            title="Retry"
                            onClick={(event) => {
                                event.stopPropagation();
                                void onRetry([{ libraryId: row.library_id, zoteroKey: row.zotero_key }]);
                            }}
                        />
                    ))}
                />}
        </div>
    );
};

/**
 * A collapsible group of attachments that share one reason for not being
 * processed. The header carries the reason's title, count and explanation;
 * expanding it pages through the affected files. Retryable reasons get a
 * group-level "Retry all" and a per-row retry; `onRetry` receives the ledger
 * refs to requeue, or `null` for the whole group.
 */
export const ProcessingIssueGroupRow: React.FC<{
    group: ProcessingIssueSummary;
    hasOcrAccess: boolean;
    hasSearchAccess: boolean;
    updatedAt: number | null;
    hasBorder?: boolean;
    onRetry?: (reason: ProcessingIssueReason, refs: AttachmentRef[] | null) => Promise<void>;
}> = ({ group, hasOcrAccess, hasSearchAccess, updatedAt, hasBorder = false, onRetry }) => {
    const [open, setOpen] = useState(false);
    const [page, setPage] = useState(0);
    const [retrying, setRetrying] = useState(false);
    const setActiveTab = useSetAtom(activePreferencePageTabAtom);
    const copy = reasonCopy(group.reason, hasOcrAccess);
    const retryable = Boolean(onRetry) && isRetryableProcessingIssue(group.reason);
    const retry = async (refs: AttachmentRef[] | null) => {
        if (!onRetry || retrying) return;
        setRetrying(true);
        try {
            await onRetry(group.reason, refs);
        } finally {
            setRetrying(false);
        }
    };
    const pageCount = Math.max(1, Math.ceil(group.count / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const first = safePage * PAGE_SIZE + 1;
    const last = Math.min(group.count, (safePage + 1) * PAGE_SIZE);
    const headerId = React.useId();
    const panelId = React.useId();

    return (
        <div className={`display-flex flex-col ${hasBorder ? 'border-top-quinary' : ''}`}>
            <div
                className="display-flex flex-row items-center gap-3 cursor-pointer"
                style={{ padding: '8px 12px', minHeight: '38px' }}
                onClick={(event) => {
                    if ((event.target as HTMLElement).closest('button')) return;
                    setOpen((value) => !value);
                }}
            >
                <button
                    type="button"
                    id={headerId}
                    className="display-flex items-center justify-center flex-shrink-0"
                    style={{ background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer' }}
                    aria-expanded={open}
                    aria-controls={panelId}
                    aria-label={`${open ? 'Hide' : 'Show'} files: ${copy.title}`}
                    onClick={() => setOpen((value) => !value)}
                >
                    <Icon icon={open ? ArrowDownIcon : ArrowRightIcon} className="scale-11 font-color-secondary" />
                </button>
                <div className="display-flex flex-col gap-05 flex-1 min-w-0">
                    <div className="display-flex flex-row items-center gap-2 min-w-0">
                        <span className="font-color-primary text-base font-medium">{copy.title}</span>
                        <span
                            className="text-xs font-color-secondary bg-quinary font-medium flex-shrink-0"
                            style={{ padding: '1px 6px', borderRadius: '8px' }}
                        >
                            {group.count.toLocaleString()}
                        </span>
                    </div>
                    <div className="font-color-secondary text-base">{copy.description}</div>
                </div>
                {copy.plansLink && (
                    // <Button variant="outline" onClick={() => setActiveTab('billing')}>
                    //     See plans
                    // </Button>
                    <Button variant="outline" onClick={() => setActiveTab('billing')} disabled>
                        Soon
                    </Button>
                )}
                {retryable && (
                    <Button
                        variant="outline"
                        loading={retrying}
                        disabled={retrying}
                        ariaLabel={`Retry all: ${copy.title}`}
                        onClick={() => void retry(null)}
                    >
                        Retry all
                    </Button>
                )}
            </div>
            {open && (
                <div id={panelId} role="region" aria-labelledby={headerId} className="display-flex flex-col bg-senary">
                    <div style={{ paddingLeft: '28px' }}>
                        <ProcessingIssuePage page={safePage} reason={group.reason}
                            hasOcrAccess={hasOcrAccess} hasSearchAccess={hasSearchAccess} updatedAt={updatedAt}
                            onRetry={retryable ? (refs) => retry(refs) : undefined} />
                    </div>
                    {pageCount > 1 && (
                        <div
                            className="display-flex flex-row items-center justify-between gap-3 border-top-quinary"
                            style={{ padding: '4px 12px 6px 40px' }}
                        >
                            <span className="text-sm font-color-secondary">
                                {first.toLocaleString()}–{last.toLocaleString()} of {group.count.toLocaleString()}
                            </span>
                            <div className="display-flex flex-row gap-1">
                                <IconButton
                                    variant="ghost"
                                    icon={ArrowLeftIcon}
                                    ariaLabel="Previous page"
                                    disabled={safePage === 0}
                                    onClick={() => setPage(Math.max(0, safePage - 1))}
                                />
                                <IconButton
                                    variant="ghost"
                                    icon={ArrowRightIcon}
                                    ariaLabel="Next page"
                                    disabled={safePage >= pageCount - 1}
                                    onClick={() => setPage(Math.min(pageCount - 1, safePage + 1))}
                                />
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default ProcessingIssueGroupRow;
