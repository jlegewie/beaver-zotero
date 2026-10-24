import React, { useEffect, useState } from 'react';
import type { ItemDisplayRow } from '@beaver/agent-core/protocol/agentProtocol';
import type { DraftSource } from '@beaver/agent-core/run-state/tableCardDraft';
import { sourceCount } from '@beaver/agent-core/run-state/tableCardDraft';
import Button from '@beaver/agent-ui/primitives/Button';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    CancelIcon,
    CSSIcon,
    CSSItemTypeIcon,
    Icon,
    SecurityWarningIcon,
    Spinner,
} from '../../icons/icons';

export interface TableSourceCardProps {
    source: DraftSource;
    /** Display rows of the source, once looked up; undefined until then. */
    rows: ItemDisplayRow[] | undefined;
    /** Rows for ids removed on the Selected items card, for their undo line. */
    removedRows?: ItemDisplayRow[];
    /** The row-cap warning this card carries, if any. */
    warning: string | null;
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
}

function sourceName(source: DraftSource): string {
    if (source.type === 'items') return 'Selected items';
    const scope = source.scope!;
    if (scope.kind === 'tag') return scope.tag ?? 'Tag';
    return scope.name || scope.key || (scope.kind === 'collection' ? 'Collection' : 'Saved search');
}

function sourceSubtitle(source: DraftSource, libraryName: string | null, includesSubcollections: boolean): string {
    const kind =
        source.type === 'items'
            ? 'Items'
            : source.scope!.kind === 'collection'
              ? includesSubcollections ? 'Collection, incl. subcollections' : 'Collection'
              : source.scope!.kind === 'tag'
                ? 'Tag'
                : 'Saved search';
    return libraryName ? `${kind} · ${libraryName}` : kind;
}

function sourceIcon(source: DraftSource): React.ReactNode {
    if (source.type === 'items') return <CSSItemTypeIcon itemType="journalArticle" />;
    const kind = source.scope!.kind;
    return (
        <CSSIcon
            name={kind === 'collection' ? 'collection' : kind === 'tag' ? 'tag' : 'saved-search'}
            className="icon-16 scale-90"
        />
    );
}

/** "16 without PDF, answered from title and abstract". */
function withoutPdfLine(count: number): string | null {
    if (!count) return null;
    return `${count.toLocaleString('en-US')} without PDF, answered from title and abstract`;
}

function ItemRow({ row, action }: { row: ItemDisplayRow; action?: React.ReactNode }) {
    return (
        <div className="display-flex flex-row items-start gap-2 min-w-0 py-05">
            <span className="scale-80 flex-none">
                <CSSItemTypeIcon itemType={row.item_type || 'document'} />
            </span>
            <div className="display-flex flex-col min-w-0 flex-1">
                <div className="font-color-primary truncate">{row.display_name}</div>
                {row.subtitle && <div className="text-sm font-color-tertiary truncate">{row.subtitle}</div>}
            </div>
            {row.has_pdf === false && (
                <span
                    className="text-xs font-color-secondary flex-none whitespace-nowrap"
                    style={{ border: '1px solid var(--fill-quarternary)', borderRadius: '4px', padding: '0 4px' }}
                >
                    No PDF
                </span>
            )}
            {action}
        </div>
    );
}

/**
 * One source on the Sources step, the same anatomy for every type: icon, name,
 * subtitle and count on one header row, remove for the card as a whole, and on
 * expand the items it yields. Collections, tags and saved searches are taken as
 * they are; only the Selected items card removes single items, with undo while
 * the card is open. A card with a problem opens expanded with its warning.
 */
export const TableSourceCard: React.FC<TableSourceCardProps> = ({
    source,
    rows,
    removedRows = [],
    warning,
    libraryName = null,
    includesSubcollections = false,
    disabled,
    onExpand,
    onRemove,
    onRemoveItem,
    onUndoRemoveItem,
    onShowInZotero,
}) => {
    const error = source.resolved?.error ?? null;
    const [expanded, setExpanded] = useState(() => !!warning || !!error);
    const toggle = () => setExpanded(!expanded);
    const count = sourceCount(source);
    const total = source.resolved?.total ?? count;
    const pdfLine = withoutPdfLine(source.resolved?.without_pdf ?? 0);
    const isItems = source.type === 'items';
    const open = expanded || !!warning || !!error;
    // Whatever opened the card (a click, or a warning that opens it), its
    // items are looked up then.
    useEffect(() => {
        if (open) onExpand();
    }, [open, onExpand]);

    return (
        <div
            className="display-flex flex-col min-w-0 rounded-md"
            style={{ border: '1px solid var(--fill-quinary)', padding: '0.4rem 0.55rem' }}
            role="group"
            aria-label={`Source: ${sourceName(source)}`}
        >
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row items-center gap-2 min-w-0 flex-1 text-left"
                    style={{ background: 'transparent', border: 0, padding: 0 }}
                    aria-expanded={open}
                    onClick={toggle}
                >
                    <Icon icon={open ? ArrowDownIcon : ArrowRightIcon} className="scale-10 font-color-tertiary flex-none" />
                    <span className="flex-none">{sourceIcon(source)}</span>
                    <span className="display-flex flex-col min-w-0">
                        <span className="font-color-primary font-medium truncate">{sourceName(source)}</span>
                        <span className="text-sm font-color-tertiary truncate">
                            {sourceSubtitle(source, libraryName, includesSubcollections)}
                        </span>
                    </span>
                </button>
                <span className="font-color-secondary flex-none" aria-label="Papers">
                    {source.counting ? <Spinner size={12} /> : total.toLocaleString('en-US')}
                </span>
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
                <div className="display-flex flex-col min-w-0 mt-2" style={{ gap: '0.35rem' }}>
                    {(warning || error) && (
                        <div
                            className="display-flex flex-row items-start gap-2 p-2 rounded-md min-w-0"
                            style={{
                                backgroundColor: 'var(--tag-orange-quinary)',
                                border: '1px solid var(--tag-orange-tertiary)',
                            }}
                            role="alert"
                        >
                            <Icon icon={SecurityWarningIcon} className="font-color-orange scale-12 flex-none mt-1" />
                            <div className="font-color-orange min-w-0">{warning ?? error}</div>
                        </div>
                    )}
                    {pdfLine && <div className="text-sm font-color-secondary">{pdfLine}</div>}
                    {rows === undefined ? (
                        <div className="text-sm font-color-tertiary">Loading items…</div>
                    ) : rows.length === 0 && !error ? (
                        <div className="text-sm font-color-tertiary">No papers.</div>
                    ) : (
                        <div
                            className="display-flex flex-col min-w-0"
                            style={{ maxHeight: '220px', overflowY: 'auto' }}
                        >
                            {rows.map((row) => (
                                <ItemRow
                                    key={row.item_id}
                                    row={row}
                                    action={
                                        isItems && onRemoveItem ? (
                                            <IconButton
                                                icon={CancelIcon}
                                                variant="ghost-tertiary"
                                                onClick={() => onRemoveItem(row.item_id)}
                                                ariaLabel={`Remove ${row.display_name}`}
                                                disabled={disabled}
                                                className="flex-none"
                                            />
                                        ) : undefined
                                    }
                                />
                            ))}
                            {total > (rows?.length ?? 0) && !isItems && (
                                <div className="text-sm font-color-tertiary py-05">
                                    {`and ${(total - rows.length).toLocaleString('en-US')} more`}
                                </div>
                            )}
                        </div>
                    )}
                    {isItems && removedRows.length > 0 && (
                        <div className="display-flex flex-col min-w-0" style={{ gap: '0.2rem' }}>
                            {removedRows.map((row) => (
                                <div key={row.item_id} className="display-flex flex-row items-center gap-2 min-w-0 text-sm">
                                    <span className="font-color-tertiary truncate flex-1" style={{ textDecoration: 'line-through' }}>
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
                            variant="ghost"
                            onClick={onShowInZotero}
                            style={{ alignSelf: 'flex-start', marginLeft: '-6px' }}
                        >
                            Show in Zotero
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
};

export default TableSourceCard;
