import { atom } from 'jotai';
import { Attachment } from '../types/attachments';
import { attachmentsAtom } from './attachments';

export const isSidebarVisibleAtom = atom(false);
export const isLibraryTabAtom = atom(false);
export const previewedAttachmentAtom = atom(
  (get) => {
    const previewAttachmentId = get(previewedAttachmentIdAtom);
    const attachments = get(attachmentsAtom);
    
    if (!previewAttachmentId) return null;
    
    // Find the attachment with the latest data from attachmentsAtom
    return attachments.find(att => att.id === previewAttachmentId) || null;
  },
  (get, set, attachment: Attachment | null) => {
    // When setting a new attachment to preview, just store its ID
    set(previewedAttachmentIdAtom, attachment?.id || null);
  }
);

// Simple atom to just store the ID of the attachment being previewed
export const previewedAttachmentIdAtom = atom<string | null>(null);
