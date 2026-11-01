import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { RemovedPaper, SourceEntry, TableSpec } from '@beaver/agent-core/layouts/table';
import type { TableSourceDraft } from '@beaver/agent-core/protocol/tableEditProtocol';
import type { TableCardLibraryScope } from '@beaver/agent-core/protocol/tableCardProtocol';
import { useAddSourcesMenu, type AddSourcesMenuHandle } from '@beaver/agent-ui/composer/useAddSourcesMenu';
import { CancelIcon, Icon, PlusSignIcon } from '../icons/icons';
import AddSourcesMenu, { type AddSourcesTarget } from '../ui/menus/AddSourcesMenu';
import { searchableLibraryIdsAtom } from '../../atoms/profile';
import { resolveLibraryRef } from '../../../src/utils/libraryIdentity';
import { getItemDisplayName } from '../../../src/utils/itemDisplayName';
import {
    NO_SEARCH_FILTERS,
    TABLE_MENU_ENTRIES,
    paperOf,
    pickedCollectionScope,
    pickedTagScope,
    portableItemId,
    rowForItem,
    scopeMenuFilters,
} from './card/cardItems';
import { sourceKindIcon } from './sourceKinds';
import { libraryScope } from './tableTabEdits';


/** The portable id of each row's item, as a source names it. */
function rowItemIds(spec: TableSpec): Set<string> {
    const ids = new Set<string>();
    for (const row of spec.rows) if (row.ref?.kind === 'item') ids.add(`${row.ref.library_ref}-${row.ref.zotero_key}`);
    return ids;
}

/** The portable id a removed paper is restored by; null for a paper that is not a Zotero item. */
export function removedPaperId(paper: RemovedPaper): string | null {
    return paper.ref.kind === 'item' ? `${paper.ref.library_ref}-${paper.ref.zotero_key}` : null;
}

/**
 * The composer's Add Sources menu, writing to a table: a picked paper joins
 * the table's items entry, a picked collection or tag becomes a source. A
 * paper already in the table shows checked; it is removed from the row's
 * menu, not here. Excluded libraries are not offered. Each instance owns its
 * menu state, so the toolbar's + Papers and the sources popover's "Add papers
 * or a collection" open independently.
 */
export function TableAddSources({
    spec,
    disabled,
    disabledReason,
    triggerLabel,
    triggerClassName,
    triggerContent,
    portalContainer,
    onAdd,
}: {
    spec: TableSpec;
    disabled?: boolean;
    disabledReason?: string;
    triggerLabel: string;
    triggerClassName: string;
    triggerContent: React.ReactNode;
    portalContainer: HTMLElement | null;
    onAdd(source: TableSourceDraft): void;
}): React.ReactElement {
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const menuRef = useRef<AddSourcesMenuHandle | null>(null);
    const noop = useCallback(() => {}, []);
    const menu = useAddSourcesMenu({
        verticalPosition: 'below',
        deleteTrailingQuery: noop,
        focusEditor: noop,
        setMessageContent: noop,
        menuRef,
    });
    const inTable = useMemo(() => rowItemIds(spec), [spec]);
    const onAddRef = useRef(onAdd);
    onAddRef.current = onAdd;

    const isAttached = useCallback(
        (item: Zotero.Item) => {
            const paper = paperOf(item);
            const id = paper ? portableItemId(paper) : null;
            return !!id && inTable.has(id);
        },
        [inTable],
    );
    const rowIdOf = useCallback(
        (item: Zotero.Item): string | null => {
            const row = rowForItem(item, searchableLibraryIds);
            return 'id' in row ? row.id : null;
        },
        [searchableLibraryIds],
    );
    const canAdd = useCallback((item: Zotero.Item) => rowIdOf(item) !== null, [rowIdOf]);
    const asSourceItem = useCallback((item: Zotero.Item) => paperOf(item), []);
    const scopes = spec.sources;
    const filters = useMemo(() => scopeMenuFilters((scopes ?? []).flatMap((source) => (source.scope ? [source.scope] : []))), [scopes]);

    const addScope = (scope: TableCardLibraryScope) => onAddRef.current({ type: 'library', scope: libraryScope(scope) });
    const target = useMemo<AddSourcesTarget>(
        () => ({
            isAttached,
            canAdd,
            asSourceItem,
            addItem: (item) => {
                const id = rowIdOf(item);
                if (id) onAddRef.current({ type: 'items', ids: [id] });
            },
            removeItem: () => {},
            filters,
            searchFilters: NO_SEARCH_FILTERS,
            setFilters: () => {},
            pickCollection: (collectionId) => {
                const scope = pickedCollectionScope(collectionId);
                if (scope) addScope(scope);
            },
            pickTag: (tag) => {
                const scope = pickedTagScope(tag);
                if (scope) addScope(scope);
            },
            attachFiles: () => {},
            entries: TABLE_MENU_ENTRIES,
        }),
        [isAttached, canAdd, asSourceItem, rowIdOf, filters],
    );

    return (
        <span title={disabledReason}>
            <AddSourcesMenu
                ref={menuRef}
                isMenuOpen={menu.isOpen}
                menuPosition={menu.position}
                searchQuery={menu.query}
                querySource={menu.querySource}
                onQueryChange={menu.setQuery}
                onOpen={menu.openFromButton}
                onDismiss={menu.dismiss}
                onCommit={menu.commit}
                onResetQuery={menu.resetQuery}
                menuPortalContainer={portalContainer}
                disabled={disabled || !!disabledReason}
                verticalPosition="below"
                target={target}
                triggerLabel={triggerLabel}
                triggerTooltip={disabledReason}
                triggerClassName={triggerClassName}
                triggerContent={triggerContent}
            />
        </span>
    );
}

/** A source entry's name: the scope's, or "Added papers" for the papers picked by hand. */
export function sourceEntryName(entry: SourceEntry): string {
    if (entry.type === 'items') return 'Added papers';
    const scope = entry.scope;
    if (!scope) return 'Source';
    if (scope.kind === 'tag') return scope.tag ?? 'Tag';
    return scope.name ?? (scope.kind === 'collection' ? 'Collection' : 'Saved search');
}

const KIND_NAMES: Record<string, string> = { collection: 'Collection', tag: 'Tag', saved_search: 'Saved search' };

/** "Collection · My Library · 38 papers"; "Picked by hand · 8 papers". */
function sourceEntryLine(entry: SourceEntry, rows: number): string {
    const papers = `${rows.toLocaleString('en-US')} ${rows === 1 ? 'paper' : 'papers'}`;
    if (entry.type === 'items' || !entry.scope) return `Picked by hand · ${papers}`;
    const libraryID = resolveLibraryRef({ library_ref: entry.scope.library_ref });
    const library = libraryID ? (Zotero.Libraries.get(libraryID) as Zotero.Library | false) : false;
    return [KIND_NAMES[entry.scope.kind] ?? 'Source', library ? library.name : null, papers].filter(Boolean).join(' · ');
}

/**
 * Removed papers' titles, looked up locally: the titles render in the user's
 * own tab, so a paper in an excluded library is named like any other
 * (exclusion is not a UI restriction).
 */
function useRemovedTitles(removed: readonly RemovedPaper[]): Map<string, string> {
    const key = removed.map(removedPaperId).filter(Boolean).join(',');
    const [titles, setTitles] = useState<Map<string, string>>(new Map());
    useEffect(() => {
        let live = true;
        void (async () => {
            const found = new Map<string, string>();
            for (const id of key ? key.split(',') : []) {
                const dash = id.indexOf('-');
                const libraryID = resolveLibraryRef({ library_ref: id.slice(0, dash) });
                const item = libraryID
                    ? ((await Zotero.Items.getByLibraryAndKeyAsync(libraryID, id.slice(dash + 1))) as Zotero.Item | false)
                    : false;
                if (!item) continue;
                try {
                    await item.loadDataType('itemData');
                    await item.loadDataType('creators');
                    found.set(id, getItemDisplayName(item));
                } catch {
                    // A paper that cannot be read is listed without its title.
                }
            }
            if (live) setTitles(found);
        })();
        return () => {
            live = false;
        };
    }, [key]);
    return titles;
}

/**
 * The sources popover, under the sources chip: one entry per source with its
 * paper count, "N new papers · Add" for a library source with papers the table
 * lacks, and remove; then the removed papers with Restore; and at the bottom
 * the Add Sources menu.
 */
export function TableSourcesPopover({
    spec,
    newBySource,
    disabledReason,
    addMenu,
    onRefresh,
    onRemove,
    onRestore,
}: {
    spec: TableSpec;
    /** Papers a library source holds that the table does not, by source id. */
    newBySource: ReadonlyMap<string, number>;
    disabledReason?: string;
    /** "Add papers or a collection". */
    addMenu: React.ReactNode;
    onRefresh(entry: SourceEntry): void;
    onRemove(entry: SourceEntry): void;
    onRestore(paper: RemovedPaper): void;
}): React.ReactElement {
    const rowsBySource = useMemo(() => {
        const counts = new Map<string, number>();
        for (const row of spec.rows)
            for (const origin of row.origin ?? []) counts.set(origin.source, (counts.get(origin.source) ?? 0) + 1);
        return counts;
    }, [spec.rows]);
    const removed = spec.removed ?? [];
    const titles = useRemovedTitles(removed);
    const disabled = !!disabledReason;

    return (
        <div className="rt-sources">
            <div className="rt-sources-heading">Sources</div>
            {(spec.sources ?? []).length === 0 ? <div className="rt-sources-empty">No sources yet.</div> : null}
            {(spec.sources ?? []).map((entry) => {
                const name = sourceEntryName(entry);
                const fresh = newBySource.get(entry.id) ?? 0;
                return (
                    <div key={entry.id} className="rt-source" data-source-id={entry.id}>
                        <span className="rt-source-icon" aria-hidden="true">
                            <Icon icon={sourceKindIcon(entry.type, entry.scope?.kind)} />
                        </span>
                        <div className="rt-source-text">
                            <div className="rt-source-name">{name}</div>
                            <div className="rt-source-line">{sourceEntryLine(entry, rowsBySource.get(entry.id) ?? 0)}</div>
                            {fresh > 0 ? (
                                <div className="rt-source-new">
                                    <span className="rt-source-new-count">
                                        <span className="rt-dot" aria-hidden="true" />
                                        {fresh === 1 ? '1 new paper' : `${fresh.toLocaleString('en-US')} new papers`}
                                    </span>
                                    <button
                                        type="button"
                                        className="rt-source-add"
                                        disabled={disabled}
                                        title={disabledReason ?? `Add the new papers in ${name}`}
                                        onClick={() => onRefresh(entry)}
                                    >
                                        Add
                                    </button>
                                </div>
                            ) : null}
                        </div>
                        <button
                            type="button"
                            className="rt-icon-button rt-source-remove"
                            aria-label={`Remove source ${name}`}
                            title={disabledReason ?? `Remove source ${name}`}
                            disabled={disabled}
                            onClick={() => onRemove(entry)}
                        >
                            <Icon icon={CancelIcon} size={12} />
                        </button>
                    </div>
                );
            })}
            {removed.length > 0 ? (
                <>
                    <div className="rt-sources-heading rt-sources-removed-heading">Removed papers · {removed.length}</div>
                    <p className="rt-sources-note">Removed papers stay out when a source refreshes.</p>
                    <div className="rt-removed-list">
                        {removed.map((paper, index) => {
                            const id = removedPaperId(paper);
                            const title = (id && titles.get(id)) || (paper.ref.kind === 'item' ? 'Paper' : 'Work');
                            return (
                                <div key={`${id ?? index}`} className="rt-removed">
                                    <span className="rt-removed-title" title={title}>
                                        {title}
                                    </span>
                                    {id ? (
                                        <button
                                            type="button"
                                            className="rt-removed-restore"
                                            disabled={disabled}
                                            title={disabledReason}
                                            aria-label={`Restore ${title}`}
                                            onClick={() => onRestore(paper)}
                                        >
                                            Restore
                                        </button>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                </>
            ) : null}
            <div className="rt-sources-footer">{addMenu}</div>
        </div>
    );
}

/** The (+) trigger's content for the "+ Papers" control. */
export const addPapersContent = (label: string) => (
    <>
        <Icon icon={PlusSignIcon} size={13} />
        <span>{label}</span>
    </>
);
