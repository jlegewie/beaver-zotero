import React, { useEffect, useState } from 'react';
import type { BatchItemGroup, BatchPopulationItem, BatchPopulationLookup } from '@beaver/agent-core/run-state/batchProgress';
import { batchItemReference, batchPopulationItemFor } from '@beaver/agent-core/run-state/batchProgress';
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import { itemTypeToIconName } from '@beaver/agent-core/types/citations';
import { ArrowUpRightIcon, FileIcon, Icon, SearchIcon } from '../icons';
import { getHost } from '../host';
import type { ResolvedItemDisplay } from '../host/types';

/**
 * The item rows a batch outcome row opens to, and the item-first row a
 * one-item finding is drawn as.
 *
 * Host-agnostic. An item is drawn from the batch's population record when the
 * thread carries one — the name, subtitle and type the backend stamped when
 * the batch started, so history renders the same everywhere and without a
 * library at hand. Without a record (a thread written before it existed, or a
 * row it lacks) the row resolves through the `itemData` host slice, and a
 * client that offers neither still lists the id. Reveal always goes through
 * `navigation`.
 */

/** Rows an item list shows before it offers the rest. */
export const MAX_ITEM_ROWS = 10;

/** Layout wording. Everything that describes a batch is composed backend-side. */
const showAllLabel = (count: number): string => `Show all ${count.toLocaleString()}`;

/**
 * The host's display data for an item, resolved once per mount.
 *
 * `undefined` while resolving, `null` when the host cannot resolve it (no
 * slice, no reference, or the item is gone) — the row then shows the key,
 * which is still an identity the user can search for.
 */
export function useItemDisplay(ref: ZoteroItemReference | null): ResolvedItemDisplay | null | undefined {
    const [display, setDisplay] = useState<ResolvedItemDisplay | null | undefined>(undefined);
    useEffect(() => {
        let cancelled = false;
        const itemData = getHost().itemData;
        if (!ref || !itemData?.resolveItemDisplay) {
            setDisplay(null);
            return undefined;
        }
        itemData
            .resolveItemDisplay(ref)
            .then((resolved) => {
                if (!cancelled) setDisplay(resolved);
            })
            .catch(() => {
                if (!cancelled) setDisplay(null);
            });
        return () => {
            cancelled = true;
        };
    }, [ref?.zotero_key, ref?.library_id, ref?.library_ref]);
    return display;
}

/**
 * One item: its type, its name, its title, and a way to it.
 *
 * The name is the "Author Year" identity. An item with no creator has only a
 * placeholder for one, so its title leads instead and the type takes the
 * title's place — "Test Report · Report" rather than "Unknown · Test Report".
 */
interface ItemRowModel {
    name: string;
    /** The second, quieter half of the line: the title, or the type when the title leads. */
    title?: string;
    /** Client-agnostic icon name for the host's item-type artwork. */
    iconName: string | null;
    /** Reveal the item in the library. Absent when the host cannot, or the id is not an item. */
    activate?: (e: React.SyntheticEvent) => void;
}

/** The row as the population record describes it; nothing is looked up. */
function stampedRowModel(stamped: BatchPopulationItem): Pick<ItemRowModel, 'name' | 'title' | 'iconName'> {
    return {
        name: stamped.n,
        title: stamped.s || undefined,
        iconName: stamped.t || stamped.c ? itemTypeToIconName(stamped.t, stamped.c) : null,
    };
}

/** The row as the host resolves it live, or as bare identity while it cannot. */
function resolvedRowModel(
    display: ResolvedItemDisplay | null | undefined,
    fallback: string,
): Pick<ItemRowModel, 'name' | 'title' | 'iconName'> {
    const leadsWithTitle = !!display && !display.creator && !!display.title;
    const name = leadsWithTitle
        ? display.title!
        : display?.displayName || (display === undefined ? '…' : fallback);
    // The title repeats the display name for a note, whose name IS its title.
    const title = leadsWithTitle
        ? display.itemTypeLabel
        : display?.title && display.title !== display.displayName
          ? display.title
          : undefined;
    const iconName = display?.itemType ? itemTypeToIconName(display.itemType, undefined) : null;
    return { name, title, iconName };
}

/**
 * What an item row draws. The population record answers when it can; the
 * host is asked only for an item the record does not describe.
 */
function useItemRowModel(itemId: string, population?: BatchPopulationLookup): ItemRowModel {
    const ref = batchItemReference(itemId);
    const stamped = batchPopulationItemFor(population, itemId);
    // Always called, so the hook order is stable; asked nothing when stamped.
    const display = useItemDisplay(stamped ? null : ref);
    // Bind so a host object with state still gets its `this`.
    const navigation = getHost().navigation;
    const reveal = navigation?.revealObject ? navigation.revealObject.bind(navigation) : null;

    const drawn = stamped ? stampedRowModel(stamped) : resolvedRowModel(display, ref?.zotero_key || itemId);
    const activate = reveal && ref
        ? (e: React.SyntheticEvent) => {
              e.stopPropagation();
              void reveal(ref);
          }
        : undefined;
    return { ...drawn, activate };
}

/** The identity line: type icon, name, title, and the reveal glyph. */
const ItemIdentity: React.FC<{ model: ItemRowModel }> = ({ model }) => (
    <>
        {model.iconName && (
            <span className="batch-item-row-icon flex-none">
                {/* The client owns its item-type artwork; the generic
                    document glyph is the honest fallback when it has none. */}
                {getHost().components?.itemTypeIcon({ itemType: model.iconName, className: 'scale-85' })
                    ?? <Icon icon={FileIcon} className="font-color-tertiary scale-85" />}
            </span>
        )}
        <span className="batch-item-row-name font-color-primary">{model.name}</span>
        {model.title && <span className="batch-item-row-title font-color-secondary truncate">{model.title}</span>}
        {model.activate && (
            <Icon icon={ArrowUpRightIcon} className="batch-item-row-reveal font-color-tertiary flex-none" />
        )}
    </>
);

/** Keyboard activation for a row that is a button. */
function activateOnKey(activate: (e: React.SyntheticEvent) => void) {
    return (e: React.KeyboardEvent) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        activate(e);
    };
}

export const BatchItemRow: React.FC<{
    itemId: string;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
}> = ({ itemId, population }) => {
    const model = useItemRowModel(itemId, population);
    const { activate } = model;
    return (
        <div
            className={['batch-item-row display-flex flex-row items-center gap-1 text-sm min-w-0', activate && 'batch-item-row-link']
                .filter(Boolean)
                .join(' ')}
            role={activate ? 'button' : undefined}
            tabIndex={activate ? 0 : undefined}
            title={model.title ? `${model.name} · ${model.title}` : model.name}
            onClick={activate}
            onKeyDown={activate ? activateOnKey(activate) : undefined}
        >
            <ItemIdentity model={model} />
        </div>
    );
};

/** An action the row that owns an item list offers beside the list's own. */
export interface BatchItemListAction {
    label: string;
    run: () => void;
}

/**
 * The items under one outcome row, opened out: a capped list, the rest on
 * request, and the row's own action (the collection or tag it names) when it
 * has one.
 */
export const BatchItemList: React.FC<{
    group: BatchItemGroup;
    /** Rows before "Show all". */
    maxRows?: number;
    /** The owning row's action, drawn after the list's own. */
    action?: BatchItemListAction;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
}> = ({ group, maxRows = MAX_ITEM_ROWS, action, population }) => {
    const [showAll, setShowAll] = useState(false);
    const ids = group.item_ids;
    const shown = showAll ? ids : ids.slice(0, maxRows);

    return (
        <div className="batch-item-list display-flex flex-col min-w-0">
            {shown.map((itemId) => (
                <BatchItemRow key={itemId} itemId={itemId} population={population} />
            ))}
            {(ids.length > shown.length || action) && (
                <div className="display-flex flex-row gap-3 text-sm batch-item-list-actions">
                    {ids.length > shown.length && (
                        <span
                            className="batch-outcome-target font-color-secondary"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                                e.stopPropagation();
                                setShowAll(true);
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                e.preventDefault();
                                e.stopPropagation();
                                setShowAll(true);
                            }}
                        >
                            {showAllLabel(ids.length)}
                        </span>
                    )}
                    {action && (
                        <span
                            className="batch-outcome-target font-color-accent-blue"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                                e.stopPropagation();
                                action.run();
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter' && e.key !== ' ') return;
                                e.preventDefault();
                                e.stopPropagation();
                                action.run();
                            }}
                        >
                            {action.label}
                        </span>
                    )}
                </div>
            )}
        </div>
    );
};

/**
 * A finding recorded for exactly one item, drawn item-first: the item leads
 * and the finding follows in full. A tally row for a count of one would say
 * nothing the finding does not, and would hide the one thing that matters —
 * which item. The whole block opens the item: the finding is about it, so
 * the text is as much the target as the name.
 */
export const BatchItemFindingRow: React.FC<{
    group: BatchItemGroup;
    /** How the batch's items look, when the thread carries that record. */
    population?: BatchPopulationLookup;
}> = ({ group, population }) => {
    const model = useItemRowModel(group.item_ids[0], population);
    const { activate } = model;
    return (
        <div
            className={['batch-item-finding display-flex flex-col min-w-0', activate && 'batch-item-finding-link']
                .filter(Boolean)
                .join(' ')}
            role={activate ? 'button' : undefined}
            tabIndex={activate ? 0 : undefined}
            title={model.title ? `${model.name} · ${model.title}` : model.name}
            onClick={activate}
            onKeyDown={activate ? activateOnKey(activate) : undefined}
        >
            <div className="batch-item-row display-flex flex-row items-center gap-1 text-sm min-w-0">
                <ItemIdentity model={model} />
            </div>
            <div className="batch-item-finding-text text-sm font-color-primary">{group.label}</div>
        </div>
    );
};

/** A filter box for a batch with more rows than a list is read through. */
export const BatchItemFilter: React.FC<{
    count: number;
    value: string;
    onChange: (value: string) => void;
}> = ({ count, value, onChange }) => (
    <div className="batch-item-filter display-flex flex-row items-center gap-1 min-w-0">
        <Icon icon={SearchIcon} className="font-color-tertiary flex-none" />
        <input
            className="batch-item-filter-input flex-1 min-w-0 text-sm"
            type="text"
            value={value}
            placeholder={`Filter ${count.toLocaleString()} rows…`}
            aria-label="Filter rows"
            onChange={(e) => onChange(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
        />
    </div>
);
