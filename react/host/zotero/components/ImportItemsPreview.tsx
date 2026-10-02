import React, { useState } from 'react';
import type { AgentAction } from '../../../agents/agentActions';
import {
    importItemDisplayJson,
    itemJsonDisplay,
    type ImportItemProposedData,
    type ImportItemResultData,
} from '@beaver/agent-core/types/itemImport';
import {
    AlertIcon,
    ArrowUpRightIcon,
    AttachmentIcon,
    CancelCircleIcon,
    CheckmarkCircleIcon,
    CSSItemTypeIcon,
    FileIcon,
    Icon,
    InformationCircleIcon,
} from '../../../components/icons/icons';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import Spinner from '@beaver/agent-ui/icons/Spinner';
import { useItemContextMenu } from '@beaver/agent-ui/chat/useItemContextMenu';
import { revealSource } from '../../../utils/sourceUtils';
import { usePdfFetchStatus } from '../../../hooks/useBackgroundTasks';
import { enrichmentNote, importSourceBadge } from '../../../utils/importItemDisplay';
import { shortenActionError } from './agentActionViewHelpers';
import { resolveLibraryRef } from '../../../../src/utils/libraryIdentity';

type ActionStatus = 'pending' | 'applied' | 'rejected' | 'undone' | 'error' | 'awaiting';

const WEB_CONTENT_TYPES = new Set(['webpage', 'blogPost', 'forumPost', 'newspaperArticle', 'magazineArticle', 'encyclopediaArticle', 'presentation']);

interface ImportItemsPreviewProps {
    /** `import_item` actions of one `create_items` call. */
    actions: AgentAction[];
    /** Batch status of the card. */
    status?: ActionStatus;
    /** Status icon per row (defaults to on for several items). */
    showStatusIcons?: boolean;
}

function statusIndicator(status: ActionStatus): { icon: React.FC<React.SVGProps<SVGSVGElement>> | null; className: string } {
    switch (status) {
        case 'applied':
            return { icon: CheckmarkCircleIcon, className: 'font-color-green scale-11' };
        case 'rejected':
        case 'undone':
            return { icon: CancelCircleIcon, className: 'font-color-red scale-11' };
        case 'error':
            return { icon: AlertIcon, className: 'color-error' };
        default:
            return { icon: null, className: '' };
    }
}

function overallStatus(actions: AgentAction[]): ActionStatus {
    const statuses = actions.map((action) => action.status);
    if (statuses.some((s) => s === 'error')) return 'error';
    if (statuses.some((s) => s === 'pending')) return 'pending';
    if (statuses.every((s) => s === 'applied')) return 'applied';
    if (statuses.every((s) => s === 'rejected' || s === 'undone')) return 'rejected';
    return 'pending';
}

const Badge: React.FC<{ label: string; caution?: boolean; tooltip?: string }> = ({ label, caution, tooltip }) => {
    const badge = (
        <span
            className={`text-xs px-15 rounded-sm whitespace-nowrap ${caution ? 'font-color-orange' : 'font-color-secondary'}`}
            style={{ border: '1px solid var(--fill-quinary)', lineHeight: '1.5' }}
        >
            {label}
        </span>
    );
    return tooltip ? <Tooltip content={tooltip} singleLine={tooltip.length < 70}>{badge}</Tooltip> : badge;
};

/** One `import_item` row; a component so it can subscribe to its background task. */
const ImportItemRow: React.FC<{
    action: AgentAction;
    showStatusIcon: boolean;
    textClass: (defaultClass?: string) => string;
}> = ({ action, showStatusIcon, textClass }) => {
    const data = action.proposed_data as ImportItemProposedData;
    const result = action.result_data as ImportItemResultData | undefined;
    const status = action.status as ActionStatus;
    const [showAbstract, setShowAbstract] = useState(false);
    const [showWarnings, setShowWarnings] = useState(false);
    const { openItemMenu, itemMenu } = useItemContextMenu();

    const applied = status === 'applied' && !!result?.zotero_key;
    const attachmentTask = usePdfFetchStatus(applied ? result?.library_id : undefined, applied ? result?.zotero_key : undefined);
    const createdRef = applied ? { library_id: result!.library_id, zotero_key: result!.zotero_key, library_ref: result!.library_ref } : null;

    const json = importItemDisplayJson(data);
    const display = json ? itemJsonDisplay(json) : null;
    const badge = importSourceBadge(data);
    const enrichment = enrichmentNote(data);
    const file = data?.file;
    const isDeferred = !json && data?.resolution?.method === 'recognizer_deferred';
    const isWeb = !!display && WEB_CONTENT_TYPES.has(display.itemType);
    const indicator = statusIndicator(status);
    const warnings = data?.warnings ?? [];
    const errorCode = (action.error_details as any)?.error_code;

    const meta = display
        ? isWeb
            ? [display.venue ?? display.site, display.year].filter(Boolean).join(' · ')
            : [display.creatorsSummary, display.year, display.venue].filter(Boolean).join(' · ')
        : '';

    return (
        <div
            className="display-flex flex-row items-start gap-2 py-1"
            onContextMenu={createdRef ? (event) => openItemMenu(createdRef, event) : undefined}
        >
            {itemMenu}
            {showStatusIcon && (
                <div className="mt-015 flex-shrink-0 w-4">
                    {indicator.icon && <Icon icon={indicator.icon} className={indicator.className} />}
                </div>
            )}
            <div className="mt-015 flex-shrink-0">
                {display
                    ? <CSSItemTypeIcon itemType={display.itemType} />
                    : <Icon icon={FileIcon} className="font-color-secondary" />}
            </div>

            <div className="display-flex flex-col gap-1 flex-1 min-w-0">
                <div className={textClass()}>
                    {display?.title ?? file?.filename ?? 'Untitled item'}
                </div>
                {meta && <div className={`${textClass('font-color-secondary')} truncate`}>{meta}</div>}
                {isWeb && display?.url && (
                    <div className={`${textClass('font-color-tertiary')} truncate text-sm`}>{display.url}</div>
                )}
                {isDeferred && (
                    <div className="font-color-secondary text-sm">
                        Zotero will identify this file after it is added.
                    </div>
                )}

                {(badge || file || enrichment || display?.abstract || warnings.length > 0) && (
                    <div className="display-flex flex-row flex-wrap items-center gap-15 mt-020">
                        {badge && <Badge label={badge.label} caution={badge.caution} tooltip={badge.tooltip} />}
                        {file && (
                            <Tooltip content={file.path ?? file.filename ?? ''} singleLine>
                                <span className="display-flex items-center gap-05 text-xs font-color-secondary truncate" style={{ maxWidth: '100%' }}>
                                    <Icon icon={AttachmentIcon} className="scale-80" />
                                    <span className="truncate">
                                        {file.filename ?? 'File'}{' '}
                                        {status === 'applied'
                                            ? (file.mode === 'link' ? '· linked' : '· attached')
                                            : status === 'error' || status === 'rejected' || status === 'undone'
                                                ? '· not attached'
                                                : (file.mode === 'link' ? '· will be linked' : '· will be attached')}
                                    </span>
                                </span>
                            </Tooltip>
                        )}
                        {display?.abstract && (
                            <Tooltip content={enrichment ?? (showAbstract ? 'Hide abstract' : 'Show abstract')} singleLine>
                                <button
                                    type="button"
                                    className="text-link-muted text-xs"
                                    style={{ background: 'transparent', border: 0, padding: 0 }}
                                    onClick={() => setShowAbstract((value) => !value)}
                                >
                                    {showAbstract ? 'Hide abstract' : 'Abstract'}
                                </button>
                            </Tooltip>
                        )}
                        {warnings.length > 0 && (
                            <button
                                type="button"
                                className="display-flex items-center gap-05 text-xs font-color-tertiary"
                                style={{ background: 'transparent', border: 0, padding: 0 }}
                                onClick={() => setShowWarnings((value) => !value)}
                            >
                                <Icon icon={InformationCircleIcon} className="scale-80" />
                                {warnings.length === 1 ? '1 note' : `${warnings.length} notes`}
                            </button>
                        )}
                    </div>
                )}

                {showAbstract && display?.abstract && (
                    <div className="font-color-secondary text-sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {display.abstract}
                    </div>
                )}
                {showWarnings && warnings.length > 0 && (
                    <ul className="font-color-tertiary text-xs" style={{ margin: 0, paddingInlineStart: '1.2em' }}>
                        {warnings.map((warning, index) => <li key={index}>{warning}</li>)}
                    </ul>
                )}
                {status === 'error' && action.error_message && (
                    <div className="font-color-red text-sm">
                        {errorCode === 'already_in_library' ? 'Already in your library' : shortenActionError(action.error_message)}
                    </div>
                )}
                {attachmentTask.isLoading && (
                    <div className="display-flex items-center gap-1 font-color-secondary text-sm">
                        <Spinner size={12} />
                        <span>{attachmentTask.kind === 'snapshot' ? 'Saving snapshot…' : 'Fetching PDF…'}</span>
                    </div>
                )}
            </div>

            {createdRef && (
                <Tooltip content="Reveal in Zotero" singleLine>
                    <IconButton
                        variant="ghost-secondary"
                        icon={ArrowUpRightIcon}
                        className="font-color-secondary scale-11 flex-shrink-0"
                        onClick={() => revealSource(createdRef, data.collection_ids?.[0] ?? data.collection_keys?.[0])}
                    />
                </Tooltip>
            )}
        </div>
    );
};

/** Where the items go: library, collections (named locally) and tags. */
function destinationText(data: ImportItemProposedData | undefined): string | null {
    if (!data) return null;
    const libraryId = resolveLibraryRef({ library_ref: data.library_ref, library_id: data.library_id });
    const libraryName = data.library_name
        ?? (libraryId ? (Zotero.Libraries.get(libraryId) as any)?.name : undefined);
    const collectionNames = (data.collection_keys ?? [])
        .map((key) => {
            if (!libraryId) return undefined;
            try {
                return (Zotero.Collections.getByLibraryAndKey(libraryId, key) as any)?.name as string | undefined;
            } catch {
                return undefined;
            }
        })
        .filter((name): name is string => !!name);
    const parts = [
        libraryName,
        collectionNames.length ? collectionNames.join(', ') : undefined,
    ].filter(Boolean);
    const tags = (data.tags ?? []).filter(Boolean);
    if (!parts.length && !tags.length) return null;
    return [
        parts.length ? `To ${parts.join(' › ')}` : undefined,
        tags.length ? `Tags: ${tags.join(', ')}` : undefined,
    ].filter(Boolean).join(' · ');
}

/**
 * Approval card and run view for `import_item` actions (create_items v2).
 * Rows render the item JSON the user is approving: what gets written.
 */
export const ImportItemsPreview: React.FC<ImportItemsPreviewProps> = ({ actions, status, showStatusIcons }) => {
    const effective = status ?? overallStatus(actions);
    const struck = effective === 'rejected' || effective === 'undone';
    const textClass = (defaultClass: string = 'font-color-primary') => {
        if (struck) return 'font-color-tertiary line-through';
        if (effective === 'error') return 'font-color-tertiary';
        return defaultClass;
    };
    const showStatusIcon = showStatusIcons ?? actions.length > 1;
    // Citation imports name no destination: they go wherever the user is when clicking.
    const destination = destinationText(actions[0]?.proposed_data as ImportItemProposedData | undefined);
    return (
        <div className="import-items-preview px-3 py-2">
            {destination && (
                <div className="font-color-tertiary text-sm truncate mb-2">{destination}</div>
            )}
            <div className="display-flex flex-col gap-3">
                {actions.map((action) => (
                    <ImportItemRow key={action.id} action={action} showStatusIcon={showStatusIcon} textClass={textClass} />
                ))}
            </div>
        </div>
    );
};

export default ImportItemsPreview;
