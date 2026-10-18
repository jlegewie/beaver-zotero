/**
 * Application-state builder.
 *
 * Assembles the `application_state` sent with each agent run (current view,
 * reader/note state, library/collection context, embedding-index status). This
 * is the Zotero implementation; it is exposed through an injectable provider so
 * a different host can supply its own document state via
 * `setApplicationStateProvider` without changing the run-start path.
 */
import { serializeCollectionReadIdentity } from '../../src/services/collections/collectionIdentity';
import { getContextWindow } from '../runtime/windowRuntime';

import { Getter } from 'jotai';
import { NoteState, ReaderState } from '@beaver/agent-core/types/attachments/apiTypes';
import { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import {
    ApplicationStateInput,
    CurrentCollection,
    CurrentLibrary,
    CurrentSavedSearch,
    CurrentSpecialCollection,
    IndexingStatus,
    SpecialCollectionType,
} from '@beaver/agent-core/protocol/agentProtocol';
import { currentReaderAttachmentAtom, readerTextSelectionAtom, stagedReaderActionContextAtom } from './messageComposition';
import { currentNoteItemAtom } from './zoteroContext';
import { getCurrentPage, getCurrentReader, getEpubReaderPage } from '../utils/readerUtils';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import {
    getCollectionTreeRows,
    getSelectedLibraryIds,
    getSelectedCollections,
    getSelectedSavedSearches,
} from '../../src/utils/zoteroSelection';
import {
    countsFor,
    getCollectionItemCounts,
    getSubcollectionCounts,
} from '../../src/services/agentDataProvider/collectionCounts';
import { getSpecialCollectionItemCounts } from '../../src/services/agentDataProvider/specialCollectionCounts';
import { excludedLibraryIdsAtom, searchableLibraryIdsAtom, processingModeAtom } from './profile';
import { ProcessingMode } from '@beaver/agent-core/types/profile';
import { isLibraryTabAtom } from './ui';
import { embeddingIndexStateAtom } from './embeddingIndex';
import { BeaverDB } from '../../src/services/database';
import { EmbeddingIndexer } from '../../src/services/embeddingIndexer';
import { getLibrarySummaries } from '../../src/services/agentDataProvider/libraryCounts';
import { logger } from '@beaver/agent-core/platform/logger';

/**
 * Maximum number of selected library items included in `library_selection`.
 * The selection is low-signal context (users often have items selected without
 * asking about them), so large selections (e.g. select-all) are truncated.
 * `library_selection_total_count` reports the untruncated size so the model can
 * tell the user what it is missing.
 */
const MAX_LIBRARY_SELECTION = 30;

/**
 * Collections-tree row types reported as `current_special_collections`. Only
 * views the agent knows how to handle are listed: Duplicate Items maps onto
 * duplicate discovery and merging; Unfiled Items, My Publications and
 * Retracted Items onto listing and search filters; the Trash is reported so
 * the agent can explain that it cannot read it.
 */
const REPORTED_SPECIAL_COLLECTION_TYPES: ReadonlySet<string> = new Set<SpecialCollectionType>([
    'duplicates',
    'unfiled',
    'publications',
    'retracted',
    'trash',
]);

/**
 * Build reader state for the current reader attachment.
 *
 * EPUB pages come from the open reader so the reported coordinate matches the
 * visible reader position.
 *
 * Excluded libraries are never shared: if the open attachment lives in a
 * non-searchable library, no reader state is emitted.
 */
export function getReaderState(get: Getter, searchableLibraryIds: Set<number>): ReaderState | null {
    const staged = get(stagedReaderActionContextAtom);
    const readerAttachment = staged?.item ?? get(currentReaderAttachmentAtom);
    if (!readerAttachment) return null;
    if (!searchableLibraryIds.has(readerAttachment.libraryID)) return null;

    const activeReader = getCurrentReader();
    const reader = !staged && activeReader?.itemID === readerAttachment.id ? activeReader : undefined;
    const contentKind = staged?.location?.contentKind ?? (reader?.type === 'pdf' || reader?.type === 'epub' || reader?.type === 'snapshot'
        ? reader.type
        : undefined);
    let currentTextSelection = staged ? staged.selection : get(readerTextSelectionAtom);

    let currentPage = staged
        ? staged.selection?.page ?? staged.location?.currentPage ?? null
        : reader ? getCurrentPage(reader) : null;
    if (contentKind === 'epub') {
        if (!staged) currentPage = getEpubReaderPage(reader);
        if (currentTextSelection) {
            // EPUB selection locations are section-based; keep page context at
            // the reader level.
            currentTextSelection = { text: currentTextSelection.text };
        }
    }

    return {
        library_id: readerAttachment.libraryID,
        zotero_key: readerAttachment.key,
        library_ref: libraryRefForLibraryID(readerAttachment.libraryID) ?? undefined,
        current_page: currentPage,
        ...(contentKind && { content_kind: contentKind }),
        ...(currentTextSelection && { text_selection: currentTextSelection })
    } as ReaderState;
}

/**
 * Build note state for the current note tab item.
 *
 * Note state for an item in an excluded (non-searchable) library is never
 * shared, so its id and title cannot reach the backend or seed a `read_note`.
 */
export function getNoteState(get: Getter, searchableLibraryIds: Set<number>): NoteState | null {
    const noteItem = get(currentNoteItemAtom);
    if (!noteItem) return null;
    if (!searchableLibraryIds.has(noteItem.libraryID)) return null;
    return {
        library_id: noteItem.libraryID,
        zotero_key: noteItem.key,
        library_ref: libraryRefForLibraryID(noteItem.libraryID) ?? undefined,
        ...(noteItem.parentKey && { parent_key: noteItem.parentKey }),
        ...(noteItem.getNoteTitle?.() && { title: noteItem.getNoteTitle() }),
    };
}

/**
 * Assemble the full `application_state` for an agent run from the current
 * Zotero UI context (reader/note/library views, current library/collection,
 * embedding-index status, and per-library summaries).
 */
export async function buildZoteroApplicationState(get: Getter): Promise<ApplicationStateInput> {
    // Nothing identifying an excluded library (name, id, contents) may appear
    // in application state; only flags saying that one is open or selected.
    const contextWindow = getContextWindow();
    const pane = contextWindow?.closed ? undefined : contextWindow?.ZoteroPane;
    const searchableLibraryIds = get(searchableLibraryIdsAtom);
    const searchableLibrarySet = new Set(searchableLibraryIds);
    // Only libraries the user explicitly excluded are flagged, never their
    // identity. Feeds and libraries pending profile load are not "excluded".
    const excludedLibrarySet = new Set(get(excludedLibraryIdsAtom));
    const isExcluded = (libraryID: unknown) => typeof libraryID === 'number' && excludedLibrarySet.has(libraryID);

    const readerState = getReaderState(get, searchableLibrarySet);
    const stagedReaderAction = get(stagedReaderActionContextAtom);
    const noteState = stagedReaderAction ? null : getNoteState(get, searchableLibrarySet);

    // Get current library and collection context
    let currentLibrary: CurrentLibrary | undefined = undefined;
    let currentCollections: CurrentCollection[] = [];
    let currentLibraries: CurrentLibrary[] = [];
    let currentSearches: CurrentSavedSearch[] = [];
    let currentSpecialCollections: CurrentSpecialCollection[] = [];
    let librarySelection: ZoteroItemReference[] | undefined = undefined;
    let librarySelectionTotalCount: number | undefined = undefined;
    let currentLibraryExcluded = false;
    let selectionPartiallyExcluded = false;

    // Detect the note-editor view from the raw tab context, NOT from the
    // exclusion-filtered noteState
    const isNoteTabActive = !!get(currentNoteItemAtom);
    const currentView: 'library' | 'file_reader' | 'note_editor' = stagedReaderAction ? 'file_reader' : get(isLibraryTabAtom) ? 'library' : isNoteTabActive ? 'note_editor' : 'file_reader';

    if (currentView === 'file_reader') {
        // currentReaderAttachmentAtom never holds an attachment from an excluded
        // library, so resolve the open reader's library from its item id.
        const reader = stagedReaderAction ? null : getCurrentReader();
        const libraryID = stagedReaderAction
            ? stagedReaderAction.item?.libraryID
            : reader ? (Zotero.Items.getLibraryAndKeyFromID(reader.itemID) || undefined)?.libraryID : undefined;
        currentLibraryExcluded = isExcluded(libraryID);
    } else if (currentView === 'note_editor') {
        currentLibraryExcluded = isExcluded(get(currentNoteItemAtom)?.libraryID);
    }

    if (currentView === 'file_reader' && readerState) {
        // In reader view, use the library from the reader attachment
        const library = Zotero.Libraries.get(readerState.library_id);
        if (library) {
            currentLibrary = {
                library_id: library.libraryID,
                library_ref: libraryRefForLibraryID(library.libraryID) ?? undefined,
                name: library.name,
                is_group: library.isGroup,
                read_only: !library.editable,
                is_synced: searchableLibraryIds.includes(library.libraryID),
            };
        }
    } else if (currentView === 'note_editor' && noteState) {
        // In note editor view, use the library from the note item
        const library = Zotero.Libraries.get(noteState.library_id);
        if (library) {
            currentLibrary = {
                library_id: library.libraryID,
                library_ref: libraryRefForLibraryID(library.libraryID) ?? undefined,
                name: library.name,
                is_group: library.isGroup,
                read_only: !library.editable,
                is_synced: searchableLibraryIds.includes(library.libraryID),
            };
        }
    } else if (currentView === 'library') {
        // In library view, get from ZoteroPane
        if (pane) {
            const selectedSearches = getSelectedSavedSearches(pane);
            const selectedTreeRows = getCollectionTreeRows(pane);
            const selectedPaneItems = pane.getSelectedItems() ?? [];
            // Rows carry their library on `ref.libraryID` (library, collection,
            // saved-search and special rows alike).
            const rowLibraryIds = selectedTreeRows
                .map((row: any) => row?.ref?.libraryID)
                .filter((id: unknown): id is number => typeof id === 'number');
            const selectedLibraryIds = rowLibraryIds.length > 0 ? rowLibraryIds : getSelectedLibraryIds(pane);
            // The library the user is working in: the first selected library
            // Beaver may use. A selection can span libraries, so each entry in
            // the selection lists carries its own library identity.
            const libraryId = selectedLibraryIds.find(id => !isExcluded(id)) ?? null;
            const library = libraryId !== null ? Zotero.Libraries.get(libraryId) : null;
            // The open library counts as excluded only when every selected row
            // is in an excluded library; otherwise the excluded rows are a
            // partial exclusion of the selection. Neither reports the excluded
            // library itself.
            const reachesExcluded = selectedLibraryIds.some(isExcluded);
            currentLibraryExcluded = libraryId === null && reachesExcluded;
            selectionPartiallyExcluded = !currentLibraryExcluded && (
                reachesExcluded
                || selectedPaneItems.some((item: Zotero.Item) => isExcluded(item.libraryID))
            );
            if (library && searchableLibrarySet.has(library.libraryID)) {
                currentLibrary = {
                    library_id: library.libraryID,
                    library_ref: libraryRefForLibraryID(library.libraryID) ?? undefined,
                    name: library.name,
                    is_group: library.isGroup,
                    read_only: !library.editable,
                    is_synced: true,
                };
            }

            currentLibraries = selectedTreeRows
                .filter((row: any) => (row?.type === 'library' || row?.type === 'group')
                    && typeof row.ref?.libraryID === 'number'
                    && searchableLibrarySet.has(row.ref.libraryID))
                .map((row: any) => Zotero.Libraries.get(row.ref.libraryID))
                .filter((selected: any): selected is Zotero.Library => !!selected)
                .map((selected: Zotero.Library) => ({
                    library_id: selected.libraryID,
                    library_ref: libraryRefForLibraryID(selected.libraryID) ?? undefined,
                    name: selected.name,
                    is_group: selected.isGroup,
                    read_only: !selected.editable,
                    is_synced: true,
                }));

            // The collections pane allows several rows to be selected at once,
            // and a selection can mix collections with saved searches and span
            // libraries. Report each kind as its own list, dropping rows in
            // excluded libraries.
            const selectedCollections = getSelectedCollections(pane)
                .filter((collection: Zotero.Collection) => searchableLibrarySet.has(collection.libraryID));

            // Counts come from the same queries the list_collections tool uses,
            // so the model sees consistent numbers for a given collection. Both
            // are batched, so this is a fixed cost regardless of how many rows
            // are selected.
            const collectionIds = selectedCollections.map((collection: Zotero.Collection) => collection.id);
            const [itemCounts, subcollectionCounts] = await Promise.all([
                getCollectionItemCounts(collectionIds),
                getSubcollectionCounts(collectionIds),
            ]);

            currentCollections = selectedCollections.map((collection: Zotero.Collection) => {
                const counts = countsFor(itemCounts, collection.id);
                return {
                    collection_key: collection.key,
                    ...serializeCollectionReadIdentity(collection),
                    library_id: collection.libraryID,
                    parent_key: collection.parentKey || null,
                    item_count: counts.itemCount,
                    standalone_attachment_count: counts.standaloneAttachmentCount,
                    note_count: counts.standaloneNoteCount,
                    subcollection_count: subcollectionCounts.get(collection.id) ?? 0,
                };
            });

            currentSearches = selectedSearches
                .filter((search: Zotero.Search) => searchableLibrarySet.has(search.libraryID))
                .map((search: Zotero.Search) => ({
                    search_key: search.key,
                    name: search.name,
                    library_id: search.libraryID,
                    library_ref: libraryRefForLibraryID(search.libraryID) ?? undefined,
                }));

            // Special-collection rows carry their library on `ref.libraryID`
            // (a Zotero.Duplicates, a Zotero.Search, or a plain `{ libraryID }`
            // for My Publications and the Trash). Counts are left out for
            // Duplicate Items, which Zotero computes with a full-library scan.
            const specialRows = selectedTreeRows
                .filter((row: any) => REPORTED_SPECIAL_COLLECTION_TYPES.has(row?.type)
                    && typeof row.ref?.libraryID === 'number'
                    && searchableLibrarySet.has(row.ref.libraryID));
            currentSpecialCollections = await Promise.all(specialRows.map(async (row: any) => {
                const type = row.type as SpecialCollectionType;
                const libraryID: number = row.ref.libraryID;
                const counts = await getSpecialCollectionItemCounts(type, libraryID);
                return {
                    type,
                    library_id: libraryID,
                    library_ref: libraryRefForLibraryID(libraryID) ?? undefined,
                    ...(counts ? {
                        item_count: counts.itemCount,
                        standalone_attachment_count: counts.standaloneAttachmentCount,
                        note_count: counts.standaloneNoteCount,
                    } : {}),
                };
            }));

            // Drop any selected items that belong to an excluded library.
            const selectedItems = selectedPaneItems
                .filter((item: Zotero.Item) => searchableLibrarySet.has(item.libraryID));
            if (selectedItems.length > 0) {
                librarySelection = selectedItems
                    .slice(0, MAX_LIBRARY_SELECTION)
                    .map((item: Zotero.Item) => ({
                        library_id: item.libraryID,
                        zotero_key: item.key,
                        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
                    }));
                // Count after the exclusion filter: an excluded library must not
                // be inferable from a selection count the model cannot reconcile.
                librarySelectionTotalCount = selectedItems.length;
            }
        }
    }

    // Frontend embedding index status
    const processingMode = get(processingModeAtom);
    const localIndexingActive = processingMode !== ProcessingMode.BACKEND;
    let indexingStatus: IndexingStatus | undefined;
    if (localIndexingActive && searchableLibraryIds.length > 0) {
        const indexState = get(embeddingIndexStateAtom);

        let isComplete: boolean;
        if (indexState.phase === 'incremental') {
            isComplete = true;
        } else {
            try {
                const db = Zotero.Beaver?.db as BeaverDB | undefined;
                if (db) {
                    const indexer = new EmbeddingIndexer(db);
                    let allUpToDate = true;
                    for (const libId of searchableLibraryIds) {
                        const diffCheck = await indexer.shouldRunFullDiff(libId);
                        if (diffCheck.needsDiff) {
                            logger(`indexing_status: library ${libId} not complete: ${diffCheck.reason}`, 4);
                            allUpToDate = false;
                            break;
                        }
                    }
                    isComplete = allUpToDate;
                } else {
                    isComplete = false;
                }
            } catch (err) {
                logger(`indexing_status: state probe failed: ${err}`, 2);
                isComplete = false;
            }
        }

        let percentComplete: number | undefined;
        let totalItems: number | undefined;
        let itemsPending: number | undefined;
        if (!isComplete && indexState.totalItems > 0) {
            percentComplete = Math.min(100, Math.max(0, Math.round((indexState.indexedItems / indexState.totalItems) * 100)));
            totalItems = indexState.totalItems;
            itemsPending = Math.max(0, indexState.totalItems - indexState.indexedItems);
        }

        indexingStatus = {
            is_complete: isComplete,
            ...(!isComplete && percentComplete !== undefined ? { percent_complete: percentComplete } : {}),
            ...(!isComplete && totalItems !== undefined ? { total_items: totalItems } : {}),
            ...(!isComplete && itemsPending !== undefined && itemsPending > 0 ? { items_pending: itemsPending } : {}),
            ...(indexState.failedItems > 0 ? { items_failed: indexState.failedItems } : {}),
        };
    }

    const libraries = searchableLibraryIds.length > 0
        ? await getLibrarySummaries(searchableLibraryIds)
        : undefined;

    // Resolved by Zotero from the requested and available UI locales.
    const interfaceLanguage = typeof Zotero.locale === 'string' && Zotero.locale ? Zotero.locale : undefined;

    return {
        current_view: currentView,
        ...(readerState ? { reader_state: readerState } : {}),
        ...(noteState ? { note_state: noteState } : {}),
        ...(currentLibrary ? { current_library: currentLibrary } : {}),
        ...(currentLibraryExcluded ? { current_library_excluded: true } : {}),
        ...(selectionPartiallyExcluded ? { selection_partially_excluded: true } : {}),
        // `current_collection` (first selected) is emitted alongside the full
        // list so a server that only reads the single-collection field still
        // understands a multi-row selection.
        ...(currentCollections.length > 0
            ? { current_collection: currentCollections[0], current_collections: currentCollections }
            : {}),
        ...(currentLibraries.length > 0 ? { current_libraries: currentLibraries } : {}),
        ...(currentSearches.length > 0 ? { current_searches: currentSearches } : {}),
        ...(currentSpecialCollections.length > 0
            ? { current_special_collections: currentSpecialCollections }
            : {}),
        ...(librarySelection
            ? {
                library_selection: librarySelection,
                library_selection_total_count: librarySelectionTotalCount,
            }
            : {}),
        ...(indexingStatus ? { indexing_status: indexingStatus } : {}),
        ...(libraries ? { libraries } : {}),
        ...(interfaceLanguage ? { interface_language: interfaceLanguage } : {}),
    };
}

/** Builds the `application_state` for an agent run from host UI context. */
export type ApplicationStateProvider = (get: Getter) => Promise<ApplicationStateInput>;

let applicationStateProvider: ApplicationStateProvider = buildZoteroApplicationState;

/** Replace the application-state provider (e.g. a Word add-in injects its own). */
export function setApplicationStateProvider(provider: ApplicationStateProvider): void {
    applicationStateProvider = provider;
}

/** The active application-state provider. */
export function getApplicationStateProvider(): ApplicationStateProvider {
    return applicationStateProvider;
}
