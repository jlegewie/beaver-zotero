import { atom } from 'jotai';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { ZoteroLibrary } from '@beaver/agent-core/types/zotero';
import {
    excludedEntryFromLibrary,
    excludedEntryKey,
    libraryExclusionKey,
    profileWithPlanAtom,
} from './profile';

export const isUpdatingExcludedLibrariesAtom = atom(false);

export const toggleExcludedLibraryAtom = atom(
    null,
    async (get, set, library: ZoteroLibrary) => {
        const profile = get(profileWithPlanAtom);
        if (!profile) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Unable to update library access',
                text: 'Your profile is not loaded. Try again after Beaver reconnects.',
            });
            return;
        }

        const toggledKey = libraryExclusionKey(library);
        const current = profile.excluded_libraries ?? [];
        const isExcluded = current.some(entry => excludedEntryKey(entry) === toggledKey);
        const next = isExcluded
            ? current.filter(entry => excludedEntryKey(entry) !== toggledKey)
            : [...current, excludedEntryFromLibrary(library)];

        set(isUpdatingExcludedLibrariesAtom, true);

        try {
            await Zotero.Beaver.account!.updateExcludedLibraries(next);
        } catch (error) {
            set(addPopupMessageAtom, {
                type: 'error',
                title: 'Unable to update library access',
                text: 'Your excluded libraries were not saved. Check your connection and try again.',
            });
        } finally {
            set(isUpdatingExcludedLibrariesAtom, false);
        }
    },
);
