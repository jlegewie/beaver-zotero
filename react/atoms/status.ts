import { atom } from "jotai";
import { AttachmentUploadStatistics } from "../../src/services/database";

// Upload status
export const uploadStatsAtom = atom<AttachmentUploadStatistics | null>(null);
export const uploadErrorAtom = atom<Error | null>(null);
export const uploadProgressAtom = atom<number>(0);
export const isUploadCompleteAtom = atom<boolean>(false);