import { atom } from "jotai";
/** Eligibility provenance follows the shared draft across its mounted editors. */
export const voiceDraftSourcesAtom = atom<{
    resetToken: number;
    libraryIds: number[];
} | null>(null);

/** A completed result blocks every composer until its owner inserts or discards it. */
export const voiceClaimedResultAtom = atom<string | null>(null);
