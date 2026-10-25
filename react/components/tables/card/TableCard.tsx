import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { tableCardDraftsAtom } from '@beaver/agent-core/run-state/pendingTableCards';
import type { ItemDisplayRow } from '@beaver/agent-core/protocol/agentProtocol';
import type {
    TableCardChoice,
    TableCardLibraryScope,
    WSTableCardRequest,
    WSTableCardResponse,
} from '@beaver/agent-core/protocol/tableCardProtocol';
import {
    addColumn,
    addItems,
    addLibrarySource,
    createActions,
    createBlocker,
    cardDestination,
    destinationLine,
    goToStep,
    initialTableCardDraft,
    itemsSource,
    librarySourceKey,
    mergeLine,
    nextStep,
    overCapMessage,
    overCapSources,
    previousStep,
    removeColumn,
    removeItem,
    removeScreening,
    removeSource,
    setDescription,
    setInstructions,
    setSourceName,
    setSourceResolved,
    setTitle,
    setSourceItemIds,
    stepCount,
    stepSummary,
    tableCardDecline,
    tableCardResponse,
    tableCardSteps,
    undoRemoveItem,
    updateColumn,
    type DraftSource,
    type TableCardDraft,
    type TableCardStep,
} from '@beaver/agent-core/run-state/tableCardDraft';
import { useAddSourcesMenu, type AddSourcesMenuHandle } from '@beaver/agent-ui/composer/useAddSourcesMenu';
import Button from '@beaver/agent-ui/primitives/Button';
import InstructionsDisclosure from '@beaver/agent-ui/primitives/InstructionsDisclosure';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import type { ZoteroTag } from '@beaver/agent-core/types/zotero';
import { libraryRefForLibraryID, resolveLibraryRef } from '../../../../src/utils/libraryIdentity';
import { tableFilesEditable } from '../../../../src/services/artifacts/tableItemIdentity';
import { searchableLibraryIdsAtom } from '../../../atoms/profile';
import type { MessageFiltersState } from '../../../atoms/messageComposition';
import { selectCollection, selectTagFilter, selectView } from '../../../utils/selectItem';
import { Icon, StopStrokeIcon, TableIcon } from '../../icons/icons';
import AddSourcesMenu, { type AddSourcesTarget } from '../../ui/menus/AddSourcesMenu';
import type { SourcesMenuEntries } from '../../ui/menus/hooks/useSourcesMenu';
import { describeItems, resolveItems, resolveLibraryScope } from './liveSources';
import AutoGrowTextarea from './AutoGrowTextarea';
import TableColumnsStep from './TableColumnsStep';
import TableSourceCard from './TableSourceCard';

const STEP_LABELS: Record<TableCardStep, string> = {
    sources: 'Sources',
    screening: 'Screening',
    columns: 'Columns',
};

/** The card takes items, collections and tags; files, notes and whole libraries are not sources. */
const MENU_ENTRIES: SourcesMenuEntries = { libraries: false, notes: false, files: false, scopeVerb: 'add' };

const BLOCK_GAP = '0.85rem';

/** Tries for a source's item lookup, and the base delay between them. */
const MAX_LOOKUP_ATTEMPTS = 3;
const LOOKUP_RETRY_MS = 1000;

export interface TableCardProps {
    request: WSTableCardRequest;
    onSubmit: (response: WSTableCardResponse) => void;
    /** Hold the answer back for now (the run's connection is being recovered). */
    disabled?: boolean;
    heldCaption?: string;
    onStop?: () => void;
}

function libraryIdOf(ref: string): number | null {
    return resolveLibraryRef({ library_ref: ref });
}

function libraryNameOf(ref: string): string | null {
    const id = libraryIdOf(ref);
    if (!id) return null;
    try {
        const library = Zotero.Libraries.get(id) as Zotero.Library | false;
        return library ? library.name : null;
    } catch {
        return null;
    }
}

/** Whether a collection scope has subcollections, whose items it includes. */
function hasSubcollections(scope: TableCardLibraryScope): boolean {
    if (scope.kind !== 'collection' || !scope.key) return false;
    const id = libraryIdOf(scope.library_ref);
    if (!id) return false;
    const collection = Zotero.Collections.getByLibraryAndKey(id, scope.key) as Zotero.Collection | false;
    return !!collection && collection.hasChildCollections();
}

/**
 * A library's name and whether Beaver may write a table into it; null for a
 * library the user excluded, which the backend does not see at all.
 */
function destinationLibrary(ref: string, searchableLibraryIds: number[]): { name: string; writable: boolean } | null {
    const id = libraryIdOf(ref);
    if (!id || !searchableLibraryIds.includes(id)) return null;
    try {
        const library = Zotero.Libraries.get(id) as Zotero.Library | false;
        return library
            ? { name: library.name, writable: tableFilesEditable(library) }
            : null;
    } catch {
        return null;
    }
}

/** What a live resolution depends on; a result for an older key is dropped. */
function resolutionKey(source: DraftSource): string {
    if (source.type === 'items') return `items:${(source.ids ?? []).join(',')}`;
    const scope = source.scope!;
    return `${scope.kind}:${scope.library_ref}:${scope.key ?? scope.tag}`;
}

/** The regular item a pick stands for: itself, or a child attachment's parent. */
function paperOf(item: Zotero.Item): Zotero.Item | null {
    if (item.isRegularItem()) return item;
    if (item.isAttachment() && item.parentItemID) {
        const parent = Zotero.Items.get(item.parentItemID) as Zotero.Item | false;
        return parent && parent.isRegularItem() ? parent : null;
    }
    return null;
}

function portableItemId(item: Zotero.Item): string | null {
    const ref = libraryRefForLibraryID(item.libraryID);
    return ref ? `${ref}-${item.key}` : null;
}

/**
 * The table card: the proposed table, editable step by step, answered once.
 *
 * Title and description sit above the stepper on every step with the
 * destination line under them. Sources come first, then Screening when the
 * card has it, then Columns, which is always last because it holds the run
 * choice. Step state is local; Create sends every part as edited, and Cancel
 * declines with the user's instructions, if any.
 */
/** "+ Source" searches every library: the card's sources are not a search scope. */
const NO_SEARCH_FILTERS: MessageFiltersState = { libraryIds: [], collectionIds: [], tagSelections: [] };

export const TableCard: React.FC<TableCardProps> = ({ request, onSubmit, disabled = false, heldCaption, onStop }) => {
    // The draft lives in the renderer's store, keyed by card, so a remount
    // (switching sidebars, closing Beaver) keeps the user's edits.
    const cardId = request.card_id;
    const drafts = useAtomValue(tableCardDraftsAtom);
    const setDrafts = useSetAtom(tableCardDraftsAtom);
    const initialDraft = useMemo(() => initialTableCardDraft(request), [request]);
    const draft = drafts.get(cardId) ?? initialDraft;
    const setDraft = useCallback(
        (update: (prev: TableCardDraft) => TableCardDraft) =>
            setDrafts((prev) => {
                const next = new Map(prev);
                next.set(cardId, update(prev.get(cardId) ?? initialDraft));
                return next;
            }),
        [cardId, initialDraft, setDrafts],
    );
    const [rows, setRows] = useState<Record<string, ItemDisplayRow[] | undefined>>({});
    const [rowsById, setRowsById] = useState<Record<string, ItemDisplayRow>>({});
    const [wantsInstructions, setWantsInstructions] = useState(() => !!request.user_instructions_prefill);
    const [isDecided, setIsDecided] = useState(false);
    const decidedRef = useRef(false);
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const steps = tableCardSteps(draft);
    const stepIndex = steps.indexOf(draft.step);
    const locked = isDecided || disabled;

    const rememberRows = useCallback((key: string, found: ItemDisplayRow[]) => {
        setRows((prev) => ({ ...prev, [key]: found }));
        setRowsById((prev) => {
            const next = { ...prev };
            for (const row of found) next[row.item_id] = row;
            return next;
        });
    }, []);

    // Live counts: every source whose content changed on the card is resolved
    // here. A result is applied only while the source still has the content it
    // was asked for; one request per content is in flight at a time.
    const draftRef = useRef(draft);
    draftRef.current = draft;
    const inFlight = useRef<Record<string, string>>({});
    // A lookup outlives a card that unmounts (switching sidebars); its result
    // then belongs to no one, and the card mounted next asks again.
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
        };
    }, []);
    const isCurrent = (sourceKey: string, key: string) => {
        if (!mounted.current) return false;
        const source = draftRef.current.sources.find((s) => s.key === sourceKey);
        return !!source && resolutionKey(source) === key;
    };
    /** Applies a result only while the stored draft's source still has `key`'s content. */
    const sourceStill = (prev: TableCardDraft, sourceKey: string, key: string) => {
        const source = prev.sources.find((s) => s.key === sourceKey);
        return !!source && resolutionKey(source) === key;
    };
    useEffect(() => {
        for (const source of draft.sources) {
            if (!source.counting) continue;
            const key = resolutionKey(source);
            if (inFlight.current[source.key] === key) continue;
            inFlight.current[source.key] = key;
            const sourceKey = source.key;
            const settle = () => {
                if (inFlight.current[sourceKey] === key) delete inFlight.current[sourceKey];
            };
            const work = source.type === 'items' ? resolveItems(source.ids ?? []) : resolveLibraryScope(source.scope!);
            work.then(
                (live) => {
                    settle();
                    if (!isCurrent(sourceKey, key)) return;
                    rememberRows(sourceKey, live.rows);
                    setDraft((prev) => {
                        if (!sourceStill(prev, sourceKey, key)) return prev;
                        let next = setSourceResolved(
                            prev,
                            sourceKey,
                            live.resolved,
                            live.rows.map((row) => row.item_id),
                        );
                        if (live.name) next = setSourceName(next, sourceKey, live.name);
                        return next;
                    });
                },
                (error) => {
                    settle();
                    if (!isCurrent(sourceKey, key)) return;
                    setDraft((prev) =>
                        !sourceStill(prev, sourceKey, key) ? prev : setSourceResolved(prev, sourceKey, {
                            count: 0,
                            total: 0,
                            truncated: false,
                            without_pdf: 0,
                            sample: [],
                            error: error instanceof Error ? error.message : String(error),
                        }),
                    );
                },
            );
        }
    }, [draft.sources, rememberRows]);

    // A proposed source shows the backend's count; its item list is looked up
    // when the card is first open.
    // Each lookup is for the source's content when it started, and lands only
    // while the source still has that content.
    // A failed lookup is asked again a few times, since without a source's
    // items the card falls back to summing counts, which can hold Create
    // above the cap although the distinct papers fit.
    const requested = useRef(new Set<string>());
    const lookupAttempts = useRef(new Map<string, number>());
    const [lookupRetry, setLookupRetry] = useState(0);
    const loadRows = useCallback(
        (source: DraftSource) => {
            const key = resolutionKey(source);
            const ask = `${source.key}|${key}`;
            if (rows[source.key] !== undefined || source.counting || requested.current.has(ask)) return;
            requested.current.add(ask);
            const work =
                source.type === 'items'
                    ? describeItems(source.ids ?? [])
                    : resolveLibraryScope(source.scope!).then((live) => {
                          if (live.resolved.error) throw new Error(live.resolved.error);
                          return live.rows;
                      });
            work.then(
                (found) => {
                    if (!isCurrent(source.key, key)) return;
                    rememberRows(source.key, found);
                    const ids = found.map((row) => row.item_id);
                    setDraft((prev) => (sourceStill(prev, source.key, key) ? setSourceItemIds(prev, source.key, ids) : prev));
                },
                () => {
                    if (!isCurrent(source.key, key)) return;
                    const attempts = (lookupAttempts.current.get(ask) ?? 0) + 1;
                    lookupAttempts.current.set(ask, attempts);
                    if (attempts < MAX_LOOKUP_ATTEMPTS) {
                        requested.current.delete(ask);
                        setTimeout(() => {
                            if (mounted.current) setLookupRetry((n) => n + 1);
                        }, LOOKUP_RETRY_MS * attempts);
                    } else {
                        rememberRows(source.key, []);
                    }
                },
            );
        },
        [rows, rememberRows, setDraft],
    );

    // Once the sources are edited, the card counts distinct papers, which
    // needs every source's items: proposed sources are looked up then.
    useEffect(() => {
        if (!draft.sourcesEdited) return;
        for (const source of draft.sources) {
            if (!source.itemIds && !source.counting) loadRows(source);
        }
    }, [draft.sourcesEdited, draft.sources, loadRows, lookupRetry]);

    // Removed ids need their rows for the undo line. Each id is looked up
    // once; one that does not resolve keeps showing its id.
    const items = itemsSource(draft);
    const describedIds = useRef(new Set<string>());
    useEffect(() => {
        const missing = (items?.removed ?? []).filter((id) => !rowsById[id] && !describedIds.current.has(id));
        if (!missing.length) return;
        for (const id of missing) describedIds.current.add(id);
        describeItems(missing).then((found) => {
            if (!found.length) return;
            setRowsById((prev) => {
                const next = { ...prev };
                for (const row of found) next[row.item_id] = row;
                return next;
            });
        });
    }, [items?.removed, rowsById]);

    // "+ Source": the composer's Add Sources menu, writing to this card.
    const menuRef = useRef<AddSourcesMenuHandle | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const noop = useCallback(() => {}, []);
    const menu = useAddSourcesMenu({
        verticalPosition: 'above',
        deleteTrailingQuery: noop,
        focusEditor: noop,
        setMessageContent: noop,
        menuRef,
    });

    const itemIds = items?.ids;
    const isAttached = useCallback(
        (item: Zotero.Item) => {
            const paper = paperOf(item);
            const id = paper ? portableItemId(paper) : null;
            return !!id && (itemIds ?? []).includes(id);
        },
        [itemIds],
    );
    const libraryScopes = useMemo(
        () => draft.sources.flatMap((source) => (source.scope ? [source.scope] : [])),
        [draft.sources],
    );
    const filters = useMemo<MessageFiltersState>(() => {
        const collectionIds: number[] = [];
        const tagSelections: ZoteroTag[] = [];
        for (const scope of libraryScopes) {
            const libraryId = libraryIdOf(scope.library_ref);
            if (!libraryId) continue;
            if (scope.kind === 'collection' && scope.key) {
                const collection = Zotero.Collections.getByLibraryAndKey(libraryId, scope.key) as Zotero.Collection | false;
                if (collection) collectionIds.push(collection.id);
            } else if (scope.kind === 'tag' && scope.tag) {
                const id = Zotero.Tags.getID(scope.tag);
                if (id) tagSelections.push({ id, tag: scope.tag, libraryId, type: 0, color: '' });
            }
        }
        return { libraryIds: [], collectionIds, tagSelections };
    }, [libraryScopes]);

    const toggleScope = useCallback((scope: TableCardLibraryScope) => {
        setDraft((prev) => {
            const existing = librarySourceKey(prev, scope);
            return existing ? removeSource(prev, existing) : addLibrarySource(prev, scope).draft;
        });
    }, [setDraft]);

    // A row is a paper: a picked attachment stands for its parent item; a
    // standalone attachment or a note cannot be a row yet, so it is not offered.
    // Nor is a paper in the trash, which the backend does not resolve.
    const rowIdOf = useCallback((item: Zotero.Item): string | null => {
        const paper = paperOf(item);
        if (!paper || paper.deleted || !searchableLibraryIds.includes(paper.libraryID)) return null;
        return portableItemId(paper);
    }, [searchableLibraryIds]);
    const canAdd = useCallback((item: Zotero.Item) => rowIdOf(item) !== null, [rowIdOf]);

    const target = useMemo<AddSourcesTarget>(() => ({
        isAttached,
        canAdd,
        addItem: (item) => {
            const id = rowIdOf(item);
            if (id) setDraft((prev) => addItems(prev, [id]));
        },
        removeItem: (item) => {
            const paper = paperOf(item);
            const id = paper ? portableItemId(paper) : null;
            if (id) setDraft((prev) => removeItem(prev, id));
        },
        // The pickers below say which source they toggle; the composer's
        // exclusive filter state is only read, for the checkmarks.
        filters,
        searchFilters: NO_SEARCH_FILTERS,
        setFilters: () => {},
        pickCollection: (collectionId) => {
            const collection = Zotero.Collections.get(collectionId) as Zotero.Collection | false;
            const ref = collection ? libraryRefForLibraryID(collection.libraryID) : null;
            if (collection && ref)
                toggleScope({ kind: 'collection', library_ref: ref, key: collection.key, name: collection.name });
        },
        pickTag: (tag) => {
            const ref = libraryRefForLibraryID(tag.libraryId);
            if (ref) toggleScope({ kind: 'tag', library_ref: ref, tag: tag.tag });
        },
        attachFiles: () => {},
        entries: MENU_ENTRIES,
    }), [isAttached, canAdd, rowIdOf, filters, toggleScope, setDraft]);

    const menuPortalContainer = containerRef.current?.closest(
        '[id^="beaver-react-root-"], #beaver-pane-window',
    ) as HTMLElement | null;

    // Decisions ------------------------------------------------------------------

    const libraryOf = useCallback(
        (ref: string) => destinationLibrary(ref, searchableLibraryIds),
        [searchableLibraryIds],
    );
    const blocker = createBlocker(draft, request, libraryOf);
    const actions = createActions(draft, request);
    const hasInstructions = draft.instructions.trim().length > 0
        && draft.instructions.trim() !== (request.user_instructions_prefill ?? '').trim();

    const decide = useCallback(
        (choice: TableCardChoice | null) => {
            if (decidedRef.current || disabled) return;
            if (choice && createBlocker(draft, request, libraryOf)) return;
            decidedRef.current = true;
            setIsDecided(true);
            onSubmit(
                choice
                    ? tableCardResponse(draft, request, choice)
                    : tableCardDecline(hasInstructions ? draft : setInstructions(draft, ''), request),
            );
        },
        [disabled, draft, hasInstructions, libraryOf, onSubmit, request],
    );

    const showInZotero = useCallback((scope: TableCardLibraryScope) => {
        const libraryId = libraryIdOf(scope.library_ref);
        if (!libraryId) return;
        if (scope.kind === 'collection' && scope.key) {
            const collection = Zotero.Collections.getByLibraryAndKey(libraryId, scope.key) as Zotero.Collection | false;
            if (collection) void selectCollection(collection);
        } else if (scope.kind === 'tag' && scope.tag) {
            void selectTagFilter(scope.tag, libraryId);
        } else if (scope.kind === 'saved_search' && scope.key) {
            void selectView(
                { type: 'saved_search', library_ref: scope.library_ref, zotero_key: scope.key, name: scope.name ?? '' },
                libraryId,
            );
        }
    }, []);

    // Rendering ------------------------------------------------------------------

    const overCap = overCapSources(draft, request);
    // A derived destination follows the sources as edited; the backend
    // derives it again on approval with the same rule.
    const destination = cardDestination(draft, request, libraryOf);
    const merge = mergeLine(draft, request);
    const isLast = stepIndex === steps.length - 1;

    const header = (
        <div className="display-flex flex-col min-w-0" style={{ gap: '0.35rem' }}>
            <div className="display-flex flex-row items-center gap-2 min-w-0">
                <Icon icon={TableIcon} className="font-color-secondary scale-12 flex-none" />
                <input
                    className="preference-input py-1 px-2 font-semibold flex-1 min-w-0"
                    value={draft.title}
                    placeholder="Title"
                    aria-label="Table title"
                    disabled={locked}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            e.stopPropagation();
                        }
                    }}
                    onChange={(e) => setDraft((prev) => setTitle(prev, e.target.value))}
                />
            </div>
            <AutoGrowTextarea
                value={draft.description}
                placeholder="One sentence: what is compared and why"
                aria-label="Table description"
                disabled={locked}
                onChange={(e) => setDraft((prev) => setDescription(prev, e.target.value))}
            />
            <div className="text-sm font-color-tertiary">
                {destination ? destinationLine(destination) : 'No library to save the table in'}
            </div>
        </div>
    );

    const stepper = (
        <div className="display-flex flex-row min-w-0" style={{ gap: '6px' }} role="tablist" aria-label="Steps">
            {steps.map((step, index) => {
                const current = step === draft.step;
                return (
                    <button
                        key={step}
                        type="button"
                        role="tab"
                        aria-selected={current}
                        className="flex-1 text-sm min-w-0 truncate"
                        disabled={locked}
                        style={{
                            background: 'transparent',
                            border: 0,
                            borderBottom: `2px solid ${current ? 'var(--accent-blue)' : 'var(--fill-quinary)'}`,
                            padding: '4px 2px',
                            color: current ? 'var(--fill-primary)' : 'var(--fill-tertiary)',
                            fontWeight: current ? 600 : 400,
                            cursor: 'pointer',
                        }}
                        onClick={() => setDraft((prev) => goToStep(prev, step))}
                    >
                        {`${STEP_LABELS[step]} · ${stepCount(draft, step, request).toLocaleString('en-US')}`}
                    </button>
                );
            })}
        </div>
    );

    // Completed steps collapse to one line each, so only one part is open.
    const summaries = steps.slice(0, stepIndex).map((step) => (
        <button
            key={step}
            type="button"
            className="variant-ghost-secondary text-sm text-left"
            style={{ background: 'transparent', border: 0, padding: 0 }}
            disabled={locked}
            onClick={() => setDraft((prev) => goToStep(prev, step))}
        >
            <span className="font-color-tertiary">{`${STEP_LABELS[step]}: `}</span>
            <span className="font-color-secondary">{stepSummary(draft, step, request)}</span>
        </button>
    ));

    const sourcesStep = (
        <div className="display-flex flex-col min-w-0" style={{ gap: '0.45rem' }}>
            {draft.sources.length === 0 && (
                <div className="text-sm font-color-secondary">No sources. Add papers, a collection or a tag.</div>
            )}
            {draft.sources.map((source) => (
                <TableSourceCard
                    key={source.key}
                    source={source}
                    rows={rows[source.key]}
                    removedRows={(source.removed ?? []).map((id) => rowsById[id] ?? { item_id: id, display_name: id })}
                    warning={overCap.includes(source.key) ? overCapMessage(draft, source, request) : null}
                    libraryName={source.scope ? libraryNameOf(source.scope.library_ref) : null}
                    includesSubcollections={source.scope ? hasSubcollections(source.scope) : false}
                    disabled={locked}
                    onExpand={() => loadRows(source)}
                    onRemove={() => setDraft((prev) => removeSource(prev, source.key))}
                    onRemoveItem={(id) => setDraft((prev) => removeItem(prev, id))}
                    onUndoRemoveItem={(id) => setDraft((prev) => undoRemoveItem(prev, id))}
                    onShowInZotero={source.scope ? () => showInZotero(source.scope!) : undefined}
                />
            ))}
            {merge && <div className="text-sm font-color-secondary">{merge}</div>}
            <div className="display-flex flex-row" style={{ marginLeft: '-6px' }}>
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
                    menuPortalContainer={menuPortalContainer}
                    disabled={locked}
                    verticalPosition="above"
                    target={target}
                    triggerLabel="Source"
                />
            </div>
        </div>
    );

    const screeningStep = (
        <div className="display-flex flex-col min-w-0" style={{ gap: '0.45rem' }}>
            <div className="text-sm font-color-secondary">
                Screening criteria are not available yet. The table is created without screening.
            </div>
            <Button
                variant="ghost"
                onClick={() => setDraft((prev) => removeScreening(prev))}
                disabled={locked}
                style={{ alignSelf: 'flex-start', marginLeft: '-6px' }}
            >
                Remove screening
            </Button>
        </div>
    );

    const columnsStep = (
        <TableColumnsStep
            columns={draft.columns}
            disabled={locked}
            onAdd={() => setDraft((prev) => addColumn(prev).draft)}
            onUpdate={(key, patch) => setDraft((prev) => updateColumn(prev, key, patch))}
            onRemove={(key) => setDraft((prev) => removeColumn(prev, key))}
        />
    );

    const cancelLabel = hasInstructions ? 'Send instructions' : 'Cancel';

    return (
        <div
            ref={containerRef}
            className="user-message-display"
            style={{ minHeight: 'fit-content', padding: '0.8rem', maxHeight: '70vh', overflowY: 'auto' }}
            role="group"
            aria-label="Proposed table"
            aria-live="assertive"
        >
            <div className="display-flex flex-col min-w-0" style={{ gap: BLOCK_GAP }}>
                {header}
                {stepper}
                {summaries.length > 0 && (
                    <div className="display-flex flex-col min-w-0" style={{ gap: '0.2rem' }}>
                        {summaries}
                    </div>
                )}
                {draft.step === 'sources' ? sourcesStep : draft.step === 'screening' ? screeningStep : columnsStep}

                {isLast && (
                    <InstructionsDisclosure
                        open={wantsInstructions}
                        onOpen={() => setWantsInstructions(true)}
                        value={draft.instructions}
                        onChange={(text) => setDraft((prev) => setInstructions(prev, text))}
                        revealLabel="Add instructions"
                        revealAriaLabel="Add instructions for this table"
                        heading="Your instructions"
                        placeholder="What to change, or what you want done instead"
                        ariaLabel="Instructions for this table (optional)"
                        disabled={isDecided}
                        autoFocus={!request.user_instructions_prefill}
                    />
                )}

                {disabled && heldCaption && (
                    <div className="text-sm font-color-secondary" role="status">
                        {heldCaption}
                    </div>
                )}
                {isLast && blocker && !disabled && (
                    <div className="text-sm font-color-tertiary" role="status">
                        {blocker}
                    </div>
                )}

                <div
                    className="display-flex flex-row items-center gap-2 min-w-0"
                    style={{ borderTop: '1px solid var(--fill-quinary)', paddingTop: '0.7rem', flexWrap: 'wrap' }}
                >
                    {disabled && onStop && (
                        <Tooltip content="Stop the agent run" showArrow singleLine>
                            <Button
                                variant="outline"
                                rightIcon={StopStrokeIcon}
                                ariaLabel="Stop generating"
                                style={{ padding: '2px 5px' }}
                                onClick={onStop}
                                className="flex-none"
                            >
                                Stop
                            </Button>
                        </Tooltip>
                    )}
                    {/* "Add screening" joins this footer when screening exists (P4). */}
                    <div className="flex-1" />
                    <Button
                        variant="ghost"
                        ariaLabel={hasInstructions ? 'Decline the table and send instructions' : 'Cancel the table'}
                        onClick={() => decide(null)}
                        disabled={locked}
                        className="flex-none whitespace-nowrap"
                    >
                        {cancelLabel}
                    </Button>
                    {stepIndex > 0 && (
                        <Button
                            variant="outline"
                            onClick={() => setDraft((prev) => previousStep(prev))}
                            disabled={locked}
                            className="flex-none whitespace-nowrap"
                            style={{ padding: '2px 6px' }}
                        >
                            Back
                        </Button>
                    )}
                    {!isLast ? (
                        <Button
                            variant="solid"
                            onClick={() => setDraft((prev) => nextStep(prev))}
                            disabled={locked}
                            className="flex-none whitespace-nowrap"
                            style={{ padding: '3px 8px' }}
                        >
                            Next
                        </Button>
                    ) : (
                        <>
                            {actions.secondary && (
                                <Button
                                    variant="outline"
                                    onClick={() => decide(actions.secondary!.choice)}
                                    disabled={locked || !!blocker}
                                    className="flex-none whitespace-nowrap"
                                    style={{ padding: '2px 6px' }}
                                >
                                    {actions.secondary.label}
                                </Button>
                            )}
                            <Button
                                variant="solid"
                                ariaLabel={`${actions.primary.label} the table`}
                                onClick={() => decide(actions.primary.choice)}
                                disabled={locked || !!blocker}
                                title={blocker ?? (disabled ? heldCaption : undefined)}
                                className="flex-none whitespace-nowrap"
                                style={{ padding: '3px 8px' }}
                            >
                                {actions.primary.label}
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default TableCard;
