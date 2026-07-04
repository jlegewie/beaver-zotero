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
    IndexingStatus,
} from '../../src/services/agentProtocol';
import { currentReaderAttachmentAtom, readerTextSelectionAtom } from './messageComposition';
import { currentNoteItemAtom } from './zoteroContext';
import { getCurrentPage, getCurrentReader, getEpubReaderPage } from '../utils/readerUtils';
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
    let currentCollection: CurrentCollection | undefined = undefined;
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
            const libraryId = zp.getSelectedLibraryID();
            const library = Zotero.Libraries.get(libraryId);
            // Omit the current library entirely when it is excluded, rather than
            // reporting it with is_synced=false — excluded libraries are not
            // shared at all.
            if (library && searchableLibrarySet.has(library.libraryID)) {
                currentLibrary = {
                    library_id: library.libraryID,
                    name: library.name,
                    is_group: library.isGroup,
                    read_only: !library.editable,
                    is_synced: true,
                };
            }

            const collection = zp.getSelectedCollection();
            if (collection && searchableLibrarySet.has(collection.libraryID)) {
                currentCollection = {
                    collection_key: collection.key,
                    name: collection.name,
                    library_id: collection.libraryID,
                    parent_key: collection.parentKey || null,
                };
            }

            // Drop any selected items that belong to an excluded library.
            const selectedItems = zp.getSelectedItems()
                .filter((item: Zotero.Item) => searchableLibrarySet.has(item.libraryID));
            if (selectedItems.length > 0) {
                librarySelection = selectedItems
                    .slice(0, MAX_LIBRARY_SELECTION)
                    .map((item: Zotero.Item) => ({
                        library_id: item.libraryID,
                        zotero_key: item.key,
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
        ...(currentCollection ? { current_collection: currentCollection } : {}),
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
