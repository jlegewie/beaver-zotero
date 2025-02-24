import { atom } from 'jotai';
import { Attachment } from '../types/attachments';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const previewedAttachmentAtom = atom<Attachment | null>(null);
