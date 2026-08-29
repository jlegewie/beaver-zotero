import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import type { MessageSearchFilters } from '@beaver/agent-core/agents/types';
import type { ZoteroCollection } from '@beaver/agent-core/types/zotero';
import {
    messageAttachmentIdentity,
    messageAttachmentIdentityKeys,
    zoteroItemIdentityKeys,
} from '@beaver/agent-core/types/attachments/apiTypes';
import type { RequestSourcesMenuProps } from '@beaver/agent-ui/host/types';
import { logger } from '@beaver/agent-core/platform/logger';
import AddSourcesMenu, { type AddSourcesTarget } from './AddSourcesMenu';
import type { MessageFiltersState } from '../../../atoms/messageComposition';
import { searchableLibraryIdsAtom } from '../../../atoms/profile';
import { useAttachExternalFiles } from '../../../hooks/useAttachExternalFiles';
import { externalFileRecordToAttachment, toMessageAttachment } from '../../../types/attachments/converters';
import { libraryRefForLibraryID } from '../../../../src/utils/libraryIdentity';
import { serializeCollection, serializeZoteroLibrary } from '../../../../src/utils/zoteroSerializers';
import { loadFullItemData } from '../../../../src/utils/zoteroUtils';

/**
 * "+" picker on a user message being edited: the composer's Add Sources menu,
 * writing to that message's edit session instead of the composer.
 *
 * Registered as the host's `requestSourcesMenu` so the shared overlay never
 * imports the Zotero-coupled machinery below. Open/query state is the caller's,
 * since a typed `@` searches from the editor.
 */
export function RequestSourcesMenu({
    attachments,
    filters,
    editSessionId,
    onAddAttachments,
    onRemoveAttachment,
    onFiltersChange,
    onPendingChange,
    isMenuOpen,
    menuPosition,
    searchQuery,
    querySource,
    onQueryChange,
    onOpen,
    onDismiss,
    onCommit,
    onResetQuery,
    menuRef,
    menuPortalContainer,
    disabled = false,
    verticalPosition = 'below',
}: RequestSourcesMenuProps) {
    const searchableLibraryIds = useAtomValue(searchableLibraryIdsAtom);
    const attachExternalFiles = useAttachExternalFiles();

    // Staging a pick is async, so the overlay holds sending until it lands.
    const [pendingCount, setPendingCount] = useState(0);
    useEffect(() => {
        onPendingChange?.(pendingCount > 0);
    }, [onPendingChange, pendingCount]);
    // Clear the hold on unmount so the overlay is not left waiting.
    useEffect(() => () => onPendingChange?.(false), [onPendingChange]);

    const trackPending = useCallback(async (work: () => Promise<void>) => {
        setPendingCount((count) => count + 1);
        try {
            await work();
        } catch (error) {
            logger(`RequestSourcesMenu: staging a pick failed: ${error}`, 1);
        } finally {
            setPendingCount((count) => count - 1);
        }
    }, []);

    // Portable and legacy aliases, qualified by object kind so a collection
    // filter is never mistaken for an item that happens to share its key.
    const attachedKeys = useMemo(() => {
        const keys = new Set<string>();
        for (const attachment of attachments) {
            for (const key of messageAttachmentIdentityKeys(attachment)) keys.add(key);
        }
        return keys;
    }, [attachments]);

    const itemLookupKeys = useCallback((item: Zotero.Item) => zoteroItemIdentityKeys({
        library_id: item.libraryID,
        zotero_key: item.key,
        library_ref: libraryRefForLibraryID(item.libraryID),
    }), []);

    const isAttached = useCallback(
        (item: Zotero.Item) => itemLookupKeys(item).some((key) => attachedKeys.has(key)),
        [attachedKeys, itemLookupKeys],
    );

    const addItem = useCallback((item: Zotero.Item) => {
        // Never stage an item from a library the user excluded from Beaver.
        if (!searchableLibraryIds.includes(item.libraryID)) return;
        // Captured before the await: the overlay can close while this runs, and
        // the caller decides where a pick that outlived its session belongs.
        const session = editSessionId;
        void trackPending(async () => {
            // toMessageAttachment reads fields, creators and note content,
            // which lazy loading may not have populated yet.
            await loadFullItemData([item], {
                includeParents: true,
                includeChildren: false,
                dataTypes: ['primaryData', 'itemData', 'creators', 'note'],
            });
            const attachment = toMessageAttachment(item);
            if (!attachment) return;
            onAddAttachments([attachment], session);
        });
    }, [editSessionId, onAddAttachments, searchableLibraryIds, trackPending]);

    const removeItem = useCallback((item: Zotero.Item) => {
        const key = itemLookupKeys(item).find((candidate) => attachedKeys.has(candidate));
        if (!key) return;
        // Report under the attachment's own identity (the match may be a legacy alias).
        const attachment = attachments.find((candidate) =>
            messageAttachmentIdentityKeys(candidate).includes(key));
        if (attachment) onRemoveAttachment(messageAttachmentIdentity(attachment));
    }, [attachments, attachedKeys, itemLookupKeys, onRemoveAttachment]);

    const attachFiles = useCallback((paths: string[]) => {
        const session = editSessionId;
        void trackPending(async () => {
            await attachExternalFiles(paths, {
                // Bypass the composer: its staging area belongs to the message
                // being typed, not the one being edited.
                onAttached: (records) => {
                    onAddAttachments(records.map(externalFileRecordToAttachment), session);
                },
            });
        });
    }, [attachExternalFiles, editSessionId, onAddAttachments, trackPending]);

    // The picker works in local Zotero ids; the message stores serialized
    // libraries/collections/tags. A collection with no local id (deleted, or in
    // a library this device does not have) cannot round-trip through that id
    // list, so it is kept aside and carried back rather than silently dropped.
    const { filterState, unresolvedCollections } = useMemo(() => {
        const collectionIds: number[] = [];
        const unresolved: ZoteroCollection[] = [];
        for (const collection of filters?.collections ?? []) {
            // getIDFromLibraryAndKey THROWS on a falsy library id (unlike its
            // neighbours here, which return false), and an unresolved portable
            // library ref carries 0.
            const id = collection.library_id
                ? Zotero.Collections.getIDFromLibraryAndKey(collection.library_id, collection.zotero_key)
                : false;
            if (typeof id === 'number') collectionIds.push(id);
            else unresolved.push(collection);
        }
        return {
            filterState: {
                libraryIds: (filters?.libraries ?? []).map((library) => library.library_id),
                collectionIds,
                tagSelections: filters?.tags ?? [],
            } satisfies MessageFiltersState,
            unresolvedCollections: unresolved,
        };
    }, [filters]);

    // Identifies the pick whose serialization may still be published. Each pick
    // resolves a collection per DB query, so two made in quick succession can
    // come back out of order and the staler payload would win.
    const filterSequenceRef = useRef(0);
    // Last filters this component published, so an incoming prop can be told
    // apart from one the caller produced on its own.
    const publishedFiltersRef = useRef<MessageSearchFilters | null>(null);

    // Optimistic filter state so two picks made before the parent re-renders
    // still compose. Replaced only when new filters actually arrive.
    const filtersPropRef = useRef(filters);
    const filterStateRef = useRef(filterState);
    if (filtersPropRef.current !== filters) {
        filtersPropRef.current = filters;
        filterStateRef.current = filterState;
        // Caller-initiated changes (chip "x", Remove all, restored stash)
        // invalidate in-flight serialization — publishing it would put back
        // what the user just removed. A change we published ourselves must not
        // cancel a later pick.
        if (filters !== publishedFiltersRef.current) {
            filterSequenceRef.current += 1;
        }
    }

    const setFilterState = useCallback(
        (updater: (prev: MessageFiltersState) => MessageFiltersState) => {
            const next = updater(filterStateRef.current);
            filterStateRef.current = next;
            const pickId = ++filterSequenceRef.current;
            // See addItem: captured before the await, since the overlay can
            // close while the collections are being serialized.
            const session = editSessionId;
            void trackPending(async () => {
                const libraries = next.libraryIds
                    .map((id) => Zotero.Libraries.get(id))
                    .filter((library): library is Zotero.Library => Boolean(library))
                    .map(serializeZoteroLibrary);
                const resolvedCollections = (await Promise.all(next.collectionIds.map((id) => {
                    const collection = Zotero.Collections.get(id);
                    return collection ? serializeCollection(collection) : null;
                }))).filter((collection) => collection !== null);
                // Carry unresolvable collections back unless the user scoped
                // to a library or tag, which replaces the collection filter
                // wholesale. Untoggling the last resolvable collection must
                // not take them with it: they are not in the submenu, so only
                // their chip's "x" removes them.
                //
                // Relies on the three dimensions being mutually exclusive
                // (every picker path clears the other two), which also makes
                // the empty-sibling test safe the other way: untoggling the
                // last tag or library lands here with nothing to carry back.
                const keepUnresolved = next.libraryIds.length === 0 && next.tagSelections.length === 0;
                const collections = keepUnresolved
                    ? [...resolvedCollections, ...unresolvedCollections]
                    : resolvedCollections;
                const serialized: MessageSearchFilters = {
                    libraries: libraries.length > 0 ? libraries : null,
                    collections: collections.length > 0 ? collections : null,
                    tags: next.tagSelections.length > 0 ? next.tagSelections.map((tag) => ({ ...tag })) : null,
                };
                if (pickId !== filterSequenceRef.current) return;
                publishedFiltersRef.current = serialized;
                onFiltersChange(serialized, session);
            });
        },
        [editSessionId, onFiltersChange, trackPending, unresolvedCollections],
    );

    const target = useMemo<AddSourcesTarget>(() => ({
        isAttached,
        addItem,
        removeItem,
        filters: filterState,
        setFilters: setFilterState,
        attachFiles,
    }), [isAttached, addItem, removeItem, filterState, setFilterState, attachFiles]);

    return (
        <AddSourcesMenu
            ref={menuRef}
            isMenuOpen={isMenuOpen}
            menuPosition={menuPosition}
            searchQuery={searchQuery}
            querySource={querySource}
            onQueryChange={onQueryChange}
            onOpen={onOpen}
            onDismiss={onDismiss}
            onCommit={onCommit}
            onResetQuery={onResetQuery}
            menuPortalContainer={menuPortalContainer}
            disabled={disabled}
            verticalPosition={verticalPosition}
            target={target}
        />
    );
}

export default RequestSourcesMenu;
