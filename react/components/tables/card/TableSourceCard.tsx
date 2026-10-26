import React, { useEffect, useRef, useState } from 'react';
import type { ItemDisplayRow } from '@beaver/agent-core/protocol/agentProtocol';
import type { DraftSource } from '@beaver/agent-core/run-state/tableCardDraft';
import { sourceCount } from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
    BookCopyIcon,
    CancelIcon,
    CSSItemTypeIcon,
    FilterIcon,
    FolderIcon,
    Icon,
    SecurityWarningIcon,
    Spinner,
    TagIcon,
} from '../../icons/icons';

export interface TableSourceCardProps {
    source: DraftSource;
    /** Display rows of the source, once looked up; undefined until then. */
    rows: ItemDisplayRow[] | undefined;
    /** Rows for ids removed on the Selected items card, for their undo line. */
    removedRows?: ItemDisplayRow[];
    /** The source alone holds more papers than a table: its count is marked. */
    overCap?: boolean;
    /** The library a collection, tag or saved search is in, for the subtitle. */
    libraryName?: string | null;
    /** A collection with subcollections: the source includes their items. */
    includesSubcollections?: boolean;
    disabled: boolean;
    onExpand: () => void;
    onRemove: () => void;
    onRemoveItem?: (id: string) => void;
    onUndoRemoveItem?: (id: string) => void;
    /** Select the collection, tag or saved search in Zotero. */
    onShowInZotero?: () => void;
    /** Reveal one of the source's papers in the Zotero library. */
    onRevealItem?: (id: string) => void;
}

/** The items an expanded source lists at first, and per "Show more". */
const ROWS_PER_PAGE = 25;

export function sourceName(source: DraftSource): string {
    if (source.type === 'items') return 'Selected items';
    const scope = source.scope!;
    if (scope.kind === 'tag') return scope.tag ?? 'Tag';
    return scope.name || scope.key || (scope.kind === 'collection' ? 'Collection' : 'Saved search');
}

function sourceSubtitle(source: DraftSource, libraryName: string | null, includesSubcollections: boolean): string {
    const kind =
        source.type === 'items'
            ? 'Individual items'
            : source.scope!.kind === 'collection'
              ? includesSubcollections ? 'Collection, incl. subcollections' : 'Collection'
              : source.scope!.kind === 'tag'
                ? 'Tag'
                : 'Saved search';
    return libraryName ? `${kind} · ${libraryName}` : kind;
}

/** "collection", "tag" or "saved search", for the Show in Zotero link. */
function sourceKindNoun(source: DraftSource): string {
    const kind = source.scope?.kind;
    return kind === 'collection' ? 'collection' : kind === 'tag' ? 'tag' : 'saved search';
}

/**
 * The source's kind as a Beaver icon. Source kinds share one icon family,
 * including kinds Zotero has no icon for; Zotero's item-type icons are kept
 * for the papers listed inside a source.
 */
function sourceIcon(source: DraftSource): React.ReactNode {
    const kind = source.type === 'items' ? 'items' : source.scope!.kind;
    const icon =
        kind === 'items' ? BookCopyIcon : kind === 'collection' ? FolderIcon : kind === 'tag' ? TagIcon : FilterIcon;
    return <Icon icon={icon} className="table-card-source-icon" />;
}

/** "16 without PDF, answered from title and abstract". */
function withoutPdfLine(count: number): string | null {
    if (!count) return null;
    return `${count.toLocaleString('en-US')} without PDF, answered from title and abstract`;
}

function ItemRow({
    row,
    action,
    onReveal,
}: {
    row: ItemDisplayRow;
    action?: React.ReactNode;
    onReveal?: () => void;
}) {
    return (
        <div
            className={`table-card-item ${onReveal ? 'table-card-item-link' : ''}`}
            role={onReveal ? 'button' : undefined}
            tabIndex={onReveal ? 0 : undefined}
            title={onReveal ? 'Show in Zotero' : undefined}
            aria-label={onReveal ? `Show ${row.display_name} in Zotero` : undefined}
            onClick={onReveal}
            onKeyDown={
                onReveal
                    ? (e) => {
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              e.stopPropagation();
                              onReveal();
                          }
                      }
                    : undefined
            }
        >
            <span className="scale-80 flex-none table-card-item-icon">
                <CSSItemTypeIcon itemType={row.item_type || 'document'} />
            </span>
            <div className="display-flex flex-col min-w-0 flex-1">
                <div className="font-color-primary truncate">{row.display_name}</div>
                {row.subtitle && <div className="text-sm font-color-secondary truncate">{row.subtitle}</div>}
            </div>
            {row.has_pdf === false && <span className="table-card-chip flex-none">No PDF</span>}
            {action}
        </div>
    );
}

/**
 * One source on the Sources step, the same anatomy for every type: icon, name,
 * subtitle and count on one header row, remove for the card as a whole, and on
 * expand the items it yields. Collections, tags and saved searches are taken as
 * they are; only the Selected items card removes single items, with undo while
 * the card is open. A source that cannot be used opens expanded on its error;
 * every card can be collapsed. The row-cap warning belongs to the step, not to
 * a source: an over-cap source only marks its count. The item list pages
 * rather than scrolling, so the card has a single scroll area.
 */
export const TableSourceCard: React.FC<TableSourceCardProps> = ({
    source,
    rows,
    removedRows = [],
    overCap = false,
    libraryName = null,
    includesSubcollections = false,
    disabled,
    onExpand,
    onRemove,
    onRemoveItem,
    onUndoRemoveItem,
    onShowInZotero,
    onRevealItem,
}) => {
    const error = source.resolved?.error ?? null;
    const [expanded, setExpanded] = useState(() => !!error);
    // An error can arrive after the card mounted (a source added on the card
    // resolves later): it opens the card once, and the user may close it.
    const shownError = useRef(error);
    useEffect(() => {
        if (error && error !== shownError.current) setExpanded(true);
        shownError.current = error;
    }, [error]);
    const [shown, setShown] = useState(ROWS_PER_PAGE);
    const toggle = () => setExpanded(!expanded);
    const count = sourceCount(source);
    const total = source.resolved?.total ?? count;
    const pdfLine = withoutPdfLine(source.resolved?.without_pdf ?? 0);
    const isItems = source.type === 'items';
    const open = expanded;
    // Whatever opened the card (a click, or an error it opens on), its items
    // are looked up then.
    useEffect(() => {
        if (open) onExpand();
    }, [open, onExpand]);

    return (
        <div
            className={`table-card-source ${open ? 'table-card-source-open' : ''}`}
            role="group"
            aria-label={`Source: ${sourceName(source)}`}
        >
            <div className="table-card-source-head">
                <button
                    type="button"
                    className="table-card-source-toggle"
                    aria-expanded={open}
                    onClick={toggle}
                >
                    <Icon icon={open ? ArrowDownIcon : ArrowRightIcon} className="scale-10 font-color-secondary flex-none" />
                    <span className="flex-none">{sourceIcon(source)}</span>
                    <span className="display-flex flex-col min-w-0 flex-1">
                        <span className="font-color-primary font-medium truncate">{sourceName(source)}</span>
                        <span className="text-sm font-color-secondary truncate">
                            {sourceSubtitle(source, libraryName, includesSubcollections)}
                        </span>
                    </span>
                    <span
                        className={`table-card-count flex-none ${overCap ? 'table-card-count-warning' : ''}`}
                        aria-label={overCap ? 'Items, more than a table holds' : 'Items'}
                        title={overCap ? 'More items than a table holds' : undefined}
                    >
                        {source.counting ? <Spinner size={12} /> : total.toLocaleString('en-US')}
                    </span>
                </button>
                <IconButton
                    icon={CancelIcon}
                    variant="ghost-secondary"
                    onClick={onRemove}
                    ariaLabel={`Remove ${sourceName(source)}`}
                    disabled={disabled}
                    className="flex-none"
                />
            </div>

            {open && (
                <div className="table-card-source-body">
                    {error && (
                        <div
                            className="display-flex flex-row items-start gap-2 p-2 rounded-md min-w-0"
                            style={{
                                backgroundColor: 'var(--tag-orange-quinary)',
                                border: '1px solid var(--tag-orange-tertiary)',
                            }}
                            role="alert"
                        >
                            <Icon icon={SecurityWarningIcon} className="font-color-orange scale-12 flex-none mt-1" />
                            <div className="font-color-orange min-w-0">{error}</div>
                        </div>
                    )}
                    {pdfLine && <div className="text-sm font-color-secondary px-1">{pdfLine}</div>}
                    {rows === undefined ? (
                        <div className="display-flex flex-row items-center gap-2 text-sm font-color-secondary px-1 py-1">
                            <Spinner size={12} />
                            <span>Loading items…</span>
                        </div>
                    ) : rows.length === 0 && !error ? (
                        <div className="text-sm font-color-secondary px-1 py-1">No items.</div>
                    ) : (
                        <div className="table-card-item-list">
                            {rows.slice(0, shown).map((row) => (
                                <ItemRow
                                    key={row.item_id}
                                    row={row}
                                    onReveal={onRevealItem ? () => onRevealItem(row.item_id) : undefined}
                                    action={
                                        isItems && onRemoveItem ? (
                                            <IconButton
                                                icon={CancelIcon}
                                                variant="ghost-secondary"
                                                onClick={(e) => {
                                                    e.stopPropagation();
                                                    onRemoveItem(row.item_id);
                                                }}
                                                ariaLabel={`Remove ${row.display_name}`}
                                                disabled={disabled}
                                                className="flex-none"
                                            />
                                        ) : undefined
                                    }
                                />
                            ))}
                            {rows.length > shown ? (
                                <button
                                    type="button"
                                    className="table-card-show-more"
                                    onClick={() => setShown((n) => n + ROWS_PER_PAGE)}
                                >
                                    {`Show ${Math.min(ROWS_PER_PAGE, rows.length - shown).toLocaleString('en-US')} more`}
                                    <span className="font-color-secondary">
                                        {` of ${(Math.max(total, rows.length) - shown).toLocaleString('en-US')} not shown`}
                                    </span>
                                </button>
                            ) : (
                                total > rows.length && !isItems && (
                                    <div className="text-sm font-color-secondary px-1 py-05">
                                        {`and ${(total - rows.length).toLocaleString('en-US')} more`}
                                    </div>
                                )
                            )}
                        </div>
                    )}
                    {isItems && removedRows.length > 0 && (
                        <div className="display-flex flex-col min-w-0" style={{ gap: '0.2rem' }}>
                            {removedRows.map((row) => (
                                <div key={row.item_id} className="display-flex flex-row items-center gap-2 min-w-0 text-sm px-1">
                                    <span className="font-color-secondary truncate flex-1" style={{ textDecoration: 'line-through' }}>
                                        {row.display_name}
                                    </span>
                                    <Button
                                        variant="ghost"
                                        onClick={() => onUndoRemoveItem?.(row.item_id)}
                                        disabled={disabled}
                                        ariaLabel={`Undo removing ${row.display_name}`}
                                        className="flex-none"
                                    >
                                        Undo
                                    </Button>
                                </div>
                            ))}
                        </div>
                    )}
                    {!isItems && onShowInZotero && (
                        <Button
                            variant="ghost-secondary"
                            rightIcon={ArrowUpRightIcon}
                            onClick={onShowInZotero}
                            style={{ alignSelf: 'flex-start' }}
                        >
                            {`Show ${sourceKindNoun(source)} in Zotero`}
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
};

export default TableSourceCard;
