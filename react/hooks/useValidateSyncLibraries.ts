import { useAtom, useAtomValue } from 'jotai';
import { useCallback, useEffect, useRef } from 'react';
import { syncedLibraryIdsAtom, profileWithPlanAtom } from '../atoms/profile';
import { accountService } from '../../src/services/accountService';
import { useLibraryDeletions } from './useLibraryDeletions';
import { ZoteroLibrary } from '../types/zotero';
import { logger } from '../../src/utils/logger';

/**
 * Validates that libraries in syncedLibraryIds exist in Zotero.
 * For missing libraries, prompts the user once per session to remove them
 * and, if confirmed, updates backend/profile and schedules deletion.
 */
export function useValidateSyncLibraries() {
    const syncedLibraryIds = useAtomValue(syncedLibraryIdsAtom);
    const [profileWithPlan, setProfileWithPlan] = useAtom(profileWithPlanAtom);
    const { startDeletion, activeDeletionIds } = useLibraryDeletions();
    const askedRef = useRef<Set<number>>(new Set());

    const removeLibraries = useCallback(async (idsToRemove: number[]) => {
        if (!profileWithPlan || !profileWithPlan.libraries) return;

        const remaining: ZoteroLibrary[] = profileWithPlan.libraries
            .filter(l => !idsToRemove.includes(l.library_id))
            .map(l => ({
                library_id: l.library_id,
                group_id: l.group_id,
                name: l.name,
                is_group: l.is_group,
                type: l.type,
                type_id: l.type_id,
                read_only: l.read_only,
            }));

        try {
            await accountService.updateSyncLibraries(remaining);
            setProfileWithPlan({ ...profileWithPlan, libraries: remaining });
        } catch (e) {
            logger(`useValidateSyncLibraries: failed to update libraries: ${String(e)}`, 1);
        }
    }, [profileWithPlan, setProfileWithPlan]);

    useEffect(() => {
        const run = async () => {
            if (!profileWithPlan?.libraries || syncedLibraryIds.length === 0) return;

            const missing = syncedLibraryIds.filter((id) => {
                const exists = !!Zotero.Libraries.get(id);
                const asked = askedRef.current.has(id);
                const deleting = activeDeletionIds.has(id);
                return !exists && !asked && !deleting;
            });

            if (missing.length === 0) return;

            const accepted: number[] = [];
            for (const id of missing) {
                const libMeta = profileWithPlan.libraries.find(l => l.library_id === id);
                const name = libMeta?.name || `Library ${id}`;
                const isGroup = !!libMeta?.is_group;

                const buttonIndex = Zotero.Prompt.confirm({
                    window: Zotero.getMainWindow(),
                    title: 'Remove Library from Syncing?',
                    text: `The library "${name}" is no longer available in Zotero.\n\nDo you want to remove it from Beaver? This will delete all associated data from Beaver.`,
                    button0: Zotero.Prompt.BUTTON_TITLE_YES,
                    button1: Zotero.Prompt.BUTTON_TITLE_NO,
                    defaultButton: 1,
                });

                askedRef.current.add(id);

                if (buttonIndex === 0) {
                    try {
                        await startDeletion({ libraryID: id, name, isGroup });
                    } catch (e) {
                        logger(`useValidateSyncLibraries: failed to start deletion for ${id}: ${String(e)}`, 1);
                    }
                    accepted.push(id);
                }
            }

            if (accepted.length > 0) {
                await removeLibraries(accepted);
            }
        };

        void run();
    }, [syncedLibraryIds, profileWithPlan, activeDeletionIds, removeLibraries]);
}