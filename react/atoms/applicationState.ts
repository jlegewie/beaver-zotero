/**
 * Application-state builder.
 *
 * Assembles the `application_state` sent with each agent run (current view,
 * reader/note state, library/collection context, embedding-index status). This
 * is the Zotero implementation; it is exposed through an injectable provider so
 * a different host can supply its own document state via
 * `setApplicationStateProvider` without changing the run-start path.
 */

import { Getter } from 'jotai';
import { NoteState, ReaderState } from '../types/attachments/apiTypes';
import { ZoteroItemReference } from '../types/zotero';
import {
    ApplicationStateInput,
    CurrentCollection,
    CurrentLibrary,
    CurrentSavedSearch,
    IndexingStatus,
} from '../../src/services/agentProtocol';
import { currentReaderAttachmentAtom, readerTextSelectionAtom } from './messageComposition';
import { currentNoteItemAtom } from './zoteroContext';
import { getCurrentPage, getCurrentReader, getEpubReaderPage } from '../utils/readerUtils';
import { libraryRefForLibraryID } from '../../src/utils/libraryIdentity';
import {
    getSelectedLibraryId,
    getSelectedCollections,
    getSelectedSavedSearches,
} from '../../src/utils/zoteroSelection';
import {
    countsFor,
    getCollectionItemCounts,
    getSubcollectionCounts,
} from '../../src/services/agentDataProvider/collectionCounts';
import { searchableLibraryIdsAtom, processingModeAtom } from './profile';
import { ProcessingMode } from '../types/profile';
import { isLibraryTabAtom } from './ui';
import { embeddingIndexStateAtom } from './embeddingIndex';
import { BeaverDB } from '../../src/services/database';
import { EmbeddingIndexer } from '../../src/services/embeddingIndexer';
import { getLibrarySummaries } from '../../src/services/agentDataProvider/libraryCounts';
import { logger } from '../../src/utils/logger';

/**
 * Maximum number of selected library items included in `library_selection`.
 * The selection is low-signal context (users often have items selected without
 * asking about them), so large selections (e.g. select-all) are truncated.
 */
const MAX_LIBRARY_SELECTION = 5;

/**
 * Build reader state for the current reader attachment.
 *
 * EPUB pages come from the open reader so the reported coordinate matches the
 * visible reader position.
 *
 * Excluded libraries are never shared: if the open attachment lives in a
 * non-searchable library, no reader state is emitted.
 */
export async function getReaderState(get: Getter, searchableLibraryIds: Set<number>): Promise<ReaderState | null> {
    const readerAttachment = get(currentReaderAttachmentAtom);
    if (!readerAttachment) return null;
    if (!searchableLibraryIds.has(readerAttachment.libraryID)) return null;

    const reader = getCurrentReader();
    const contentKind = reader?.type === 'pdf' || reader?.type === 'epub' || reader?.type === 'snapshot'
        ? reader.type
        : undefined;
    let currentTextSelection = get(readerTextSelectionAtom);

    let currentPage = getCurrentPage(reader) || null;
    if (contentKind === 'epub') {
        currentPage = getEpubReaderPage(reader);
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
    // Excluded libraries must never appear in application state
    const searchableLibraryIds = get(searchableLibraryIdsAtom);
    const searchableLibrarySet = new Set(searchableLibraryIds);

    const readerState = await getReaderState(get, searchableLibrarySet);
    const noteState = getNoteState(get, searchableLibrarySet);

    // Get current library and collection context
    let currentLibrary: CurrentLibrary | undefined = undefined;
    let currentCollections: CurrentCollection[] = [];
    let currentSearches: CurrentSavedSearch[] = [];
    let librarySelection: ZoteroItemReference[] | undefined = undefined;

    // Detect the note-editor view from the raw tab context, NOT from the
    // exclusion-filtered noteState
    const isNoteTabActive = !!get(currentNoteItemAtom);
    const currentView: 'library' | 'file_reader' | 'note_editor' = get(isLibraryTabAtom) ? 'library' : isNoteTabActive ? 'note_editor' : 'file_reader';

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
        const zp = Zotero.getActiveZoteroPane();
        if (zp) {
            // The primary (first) selected library. A selection can span
            // libraries, so this is deliberately not "the only library in
            // play" — it answers "where is the user working", while each
            // entry in current_collections carries its own library identity
            // for anything that needs to be addressed precisely.
            const libraryId = getSelectedLibraryId(zp);
            const library = libraryId !== null ? Zotero.Libraries.get(libraryId) : null;
            // Omit the current library entirely when it is excluded, rather than
            // reporting it with is_synced=false — excluded libraries are not
            // shared at all.
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

            // The collections pane allows several rows to be selected at once,
            // and a selection can mix collections with saved searches and span
            // libraries. Report each kind as its own list, dropping rows in
            // excluded libraries.
            const selectedCollections = getSelectedCollections(zp)
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
                    name: collection.name,
                    library_id: collection.libraryID,
                    library_ref: libraryRefForLibraryID(collection.libraryID) ?? undefined,
                    parent_key: collection.parentKey || null,
                    item_count: counts.itemCount,
                    standalone_attachment_count: counts.standaloneAttachmentCount,
                    note_count: counts.standaloneNoteCount,
                    subcollection_count: subcollectionCounts.get(collection.id) ?? 0,
                };
            });

            currentSearches = getSelectedSavedSearches(zp)
                .filter((search: Zotero.Search) => searchableLibrarySet.has(search.libraryID))
                .map((search: Zotero.Search) => ({
                    search_key: search.key,
                    name: search.name,
                    library_id: search.libraryID,
                    library_ref: libraryRefForLibraryID(search.libraryID) ?? undefined,
                }));

            // Drop any selected items that belong to an excluded library.
            const selectedItems = zp.getSelectedItems()
                .filter((item: Zotero.Item) => searchableLibrarySet.has(item.libraryID));
            if (selectedItems.length > 0) {
                librarySelection = selectedItems
                    .slice(0, MAX_LIBRARY_SELECTION)
                    .map((item: Zotero.Item) => ({
                        library_id: item.libraryID,
                        zotero_key: item.key,
                        library_ref: libraryRefForLibraryID(item.libraryID) ?? undefined,
                    }));
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

    return {
        current_view: currentView,
        ...(readerState ? { reader_state: readerState } : {}),
        ...(noteState ? { note_state: noteState } : {}),
        ...(currentLibrary ? { current_library: currentLibrary } : {}),
        // `current_collection` (first selected) is emitted alongside the full
        // list so a server that only reads the single-collection field still
        // understands a multi-row selection.
        ...(currentCollections.length > 0
            ? { current_collection: currentCollections[0], current_collections: currentCollections }
            : {}),
        ...(currentSearches.length > 0 ? { current_searches: currentSearches } : {}),
        ...(librarySelection ? { library_selection: librarySelection } : {}),
        ...(indexingStatus ? { indexing_status: indexingStatus } : {}),
        ...(libraries ? { libraries } : {}),
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
