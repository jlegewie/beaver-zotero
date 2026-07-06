import { atom } from 'jotai';
import { accountService } from '../../src/services/accountService';
import { addPopupMessageAtom } from '../utils/popupMessageUtils';
import { ZoteroLibrary } from '../types/zotero';
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

        set(profileWithPlanAtom, {
            ...profile,
            excluded_libraries: next,
        });
        set(isUpdatingExcludedLibrariesAtom, true);

        try {
            await accountService.updateExcludedLibraries(next);
        } catch (error) {
            set(profileWithPlanAtom, latestProfile => latestProfile ? {
                ...latestProfile,
                excluded_libraries: current,
            } : latestProfile);
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
