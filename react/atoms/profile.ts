import { atom } from "jotai";
import { ProfileWithPlan } from "../types/profile";
import { accountService } from "../../src/services/accountService";

export const profileWithPlanAtom = atom<ProfileWithPlan | null>(null);

export const fetchProfileAtom = atom(
    null,
    async (get, set) => {
        try {
            const profileFetched = await accountService.getProfileWithPlan();
            set(profileWithPlanAtom, profileFetched);
        } catch (error: any) {
            Zotero.debug('Error fetching profile:', error, 3);
        }
    }
);