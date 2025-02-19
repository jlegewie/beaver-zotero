import { atom } from "jotai";
import { Attachment } from "../types/attachments";
import { ChatMessage } from "../types/messages";


export const userAttachmentsAtom = atom<Attachment[]>([]);