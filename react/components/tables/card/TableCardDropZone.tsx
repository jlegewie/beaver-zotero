import React, { useEffect, useRef, useState } from 'react';
import type { TableCardLibraryScope } from '@beaver/agent-core/protocol/tableCardProtocol';
import { BookCopyIcon, FilterIcon, FolderIcon, Icon } from '../../icons/icons';
import {
    rejectionMessage,
    rowForItem,
    scopeForCollection,
    scopeForSavedSearch,
    type RowRejection,
} from './cardItems';

/** What a drag would add, or why it adds nothing. */
interface DropPlan {
    ids: string[];
    scopes: TableCardLibraryScope[];
    /** Dragged items that cannot be rows, by reason. */
    rejected: Map<RowRejection, number>;
    /** Shown when the drop adds nothing. */
    error: string | null;
}

const ITEM_TYPE = 'zotero/item';
const COLLECTION_TYPE = 'zotero/collection';
const SEARCH_TYPE = 'zotero/search';
const ANNOTATION_TYPE = 'zotero/annotation';

/** How long the overlay explains a refused drop. */
const ERROR_MS = 2000;

function ids(dataTransfer: DataTransfer, type: string): number[] {
    return dataTransfer
        .getData(type)
        .split(',')
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isFinite(id));
}

/**
 * What dropping `dataTransfer` adds: papers (a child attachment stands for its
 * parent), collections and saved searches. Everything else is refused with
 * the reason, so the overlay can say it before the drop.
 */
function planDrop(dataTransfer: DataTransfer, searchableLibraryIds: number[]): DropPlan | null {
    const types = dataTransfer.types;
    const plan: DropPlan = { ids: [], scopes: [], rejected: new Map(), error: null };
    if (types.includes(ITEM_TYPE)) {
        for (const id of ids(dataTransfer, ITEM_TYPE)) {
            const item = Zotero.Items.get(id) as Zotero.Item | false;
            if (!item) continue;
            const row = rowForItem(item, searchableLibraryIds);
            if ('id' in row) {
                if (!plan.ids.includes(row.id)) plan.ids.push(row.id);
            } else {
                plan.rejected.set(row.rejection, (plan.rejected.get(row.rejection) ?? 0) + 1);
            }
        }
    } else if (types.includes(COLLECTION_TYPE)) {
        for (const id of ids(dataTransfer, COLLECTION_TYPE)) {
            const collection = Zotero.Collections.get(id) as Zotero.Collection | false;
            const scope = collection ? scopeForCollection(collection, searchableLibraryIds) : null;
            if (scope) plan.scopes.push(scope);
        }
        if (!plan.scopes.length) plan.error = 'This collection cannot be a source';
    } else if (types.includes(SEARCH_TYPE)) {
        for (const id of ids(dataTransfer, SEARCH_TYPE)) {
            const search = Zotero.Searches.get(id) as Zotero.Search | false;
            const scope = search ? scopeForSavedSearch(search, searchableLibraryIds) : null;
            if (scope) plan.scopes.push(scope);
        }
        if (!plan.scopes.length) plan.error = 'This saved search cannot be a source';
    } else if (types.includes(ANNOTATION_TYPE)) {
        plan.error = rejectionMessage('annotation', 2);
    } else if (types.includes('application/x-moz-file') || types.includes('Files')) {
        plan.error = 'Files from disk cannot be added; add them to Zotero first';
    } else {
        return null;
    }
    if (!plan.error && !plan.ids.length && !plan.scopes.length) {
        const [first] = [...plan.rejected.entries()].sort((a, b) => b[1] - a[1]);
        plan.error = first ? rejectionMessage(first[0], first[1]) : 'Only papers can be table rows';
    }
    return plan;
}

/** "3 papers", "Gender & Labor Market", "2 collections". */
function dropLabel(plan: DropPlan): string {
    if (plan.ids.length) return `${plan.ids.length} ${plan.ids.length === 1 ? 'paper' : 'papers'}`;
    if (plan.scopes.length === 1) return plan.scopes[0].name || 'source';
    return `${plan.scopes.length} sources`;
}

function dropIcon(plan: DropPlan) {
    if (plan.ids.length) return BookCopyIcon;
    return plan.scopes[0]?.kind === 'saved_search' ? FilterIcon : FolderIcon;
}

/** A sentence about the dragged items a drop left out, or null. */
function skippedLine(plan: DropPlan): string | null {
    const skipped = [...plan.rejected.values()].reduce((sum, n) => sum + n, 0);
    if (!skipped || !(plan.ids.length || plan.scopes.length)) return null;
    const [first] = [...plan.rejected.entries()].sort((a, b) => b[1] - a[1]);
    const reason = plan.rejected.size === 1 ? `: ${rejectionMessage(first[0], first[1]).toLowerCase()}` : '';
    return `${skipped} ${skipped === 1 ? 'item was' : 'items were'} not added${reason}.`;
}

export interface TableCardDropZoneProps {
    children: React.ReactNode;
    searchableLibraryIds: number[];
    disabled: boolean;
    onAddItems: (ids: string[]) => void;
    onAddScopes: (scopes: TableCardLibraryScope[]) => void;
    /** A note about the last drop for the card to show (items it left out), or null to clear it. */
    onNotice: (notice: string | null) => void;
}

/**
 * Drop target over the whole card. Items dragged from Zotero add papers (a
 * child attachment adds its parent); collections and saved searches add a
 * source. While a drag is over the card an overlay says what the drop adds,
 * or why it adds nothing. Drags never reach the composer behind the card.
 */
export const TableCardDropZone: React.FC<TableCardDropZoneProps> = ({
    children,
    searchableLibraryIds,
    disabled,
    onAddItems,
    onAddScopes,
    onNotice,
}) => {
    const [plan, setPlan] = useState<DropPlan | null>(null);
    const [error, setError] = useState<string | null>(null);
    const errorTimer = useRef<number | undefined>(undefined);
    const rootRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => () => {
        const win = rootRef.current?.ownerDocument.defaultView;
        if (errorTimer.current !== undefined) win?.clearTimeout(errorTimer.current);
    }, []);

    const flashError = (message: string) => {
        const win = rootRef.current?.ownerDocument.defaultView;
        setError(message);
        if (!win) return;
        if (errorTimer.current !== undefined) win.clearTimeout(errorTimer.current);
        errorTimer.current = win.setTimeout(() => setError(null), ERROR_MS);
    };

    const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        if (disabled) return;
        const next = planDrop(e.dataTransfer, searchableLibraryIds);
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = next.error ? 'none' : 'copy';
        setPlan(next);
    };

    const onDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPlan(null);
    };

    const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
        setPlan(null);
        if (disabled) return;
        const dropped = planDrop(e.dataTransfer, searchableLibraryIds);
        if (!dropped) return;
        e.preventDefault();
        e.stopPropagation();
        if (dropped.error) {
            flashError(dropped.error);
            return;
        }
        if (dropped.ids.length) onAddItems(dropped.ids);
        if (dropped.scopes.length) onAddScopes(dropped.scopes);
        onNotice(skippedLine(dropped));
    };

    const showing = plan !== null || error !== null;
    const message = error ?? plan?.error ?? null;

    return (
        <div
            ref={rootRef}
            className="relative min-w-0"
            onDragEnter={onDragOver}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
        >
            {children}
            <div
                className={`table-card-drop-overlay ${message ? 'table-card-drop-overlay-error' : ''}`}
                style={{ opacity: showing ? 1 : 0, visibility: showing ? 'visible' : 'hidden' }}
                aria-hidden={!showing}
            >
                {message ? (
                    <div className="table-card-drop-message font-color-red">{message}</div>
                ) : plan ? (
                    <div className="table-card-drop-message">
                        <Icon icon={dropIcon(plan)} className="table-card-drop-icon" />
                        <span>{`Drop to add ${dropLabel(plan)}`}</span>
                    </div>
                ) : null}
            </div>
        </div>
    );
};

export default TableCardDropZone;
