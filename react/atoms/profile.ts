import { atom } from "jotai";
import { ProfileWithPlanName } from "../types/profile";
import { accountService } from "../../src/services/accountService";

export const profileAtom = atom<ProfileWithPlanName | null>(null);

export const fetchProfileAtom = atom(
    null,
    async (get, set) => {
        try {
            const profileFetched = await accountService.getProfile();
            set(profileAtom, profileFetched);
        } catch (error: any) {
            Zotero.debug('Error fetching profile:', error, 3);
        }
    }
);