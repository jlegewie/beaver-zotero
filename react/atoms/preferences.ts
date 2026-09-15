import { atom } from "jotai";
import { getPref, setPref } from "../../src/utils/prefs";
/** Invalidates derived preference reads after the instance observer publishes a change. */
export const preferencesRevisionAtom = atom(0);

export const CHAT_LINE_SPACING = {
    standard: { label: 'Standard', lineHeight: 1.5 },
    relaxed: { label: 'Relaxed', lineHeight: 1.75 },
    spacious: { label: 'Spacious', lineHeight: 2 },
} as const;

export type ChatLineSpacing = keyof typeof CHAT_LINE_SPACING;

/** Local display preference, projected into each window by the native observer. */
export const chatLineSpacingAtom = atom(
    (get): ChatLineSpacing => {
        get(preferencesRevisionAtom);
        const value = getPref('chatLineSpacing');
        return value === 'relaxed' || value === 'spacious' ? value : 'standard';
    },
    (_get, _set, value: ChatLineSpacing) => setPref('chatLineSpacing', value),
);
