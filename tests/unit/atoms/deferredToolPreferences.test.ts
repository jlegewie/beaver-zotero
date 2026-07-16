import { createStore } from 'jotai';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getPref: vi.fn(() => JSON.stringify({
        toolToGroup: {
            edit_note: 'custom_note_edits',
            zotero_note: 'note_creation',
            highlight_annotation: 'annotations',
            note_annotation: 'annotations',
        },
        groupPreferences: {
            custom_note_edits: 'always_apply',
        },
    })),
    setPref: vi.fn(),
}));

vi.mock('../../../src/utils/prefs', () => mocks);
vi.mock('../../../src/utils/logger', () => ({ logger: vi.fn() }));

import { deferredToolPreferencesAtom } from '../../../react/atoms/deferredToolPreferences';

describe('deferredToolPreferences', () => {
    it('loads real tool remaps but strips authorization-only action aliases', () => {
        const preferences = createStore().get(deferredToolPreferencesAtom);

        expect(preferences.toolToGroup.edit_note).toBe('custom_note_edits');
        expect(preferences.groupPreferences.custom_note_edits).toBe('always_apply');
        expect(preferences.toolToGroup).not.toHaveProperty('zotero_note');
        expect(preferences.toolToGroup).not.toHaveProperty('highlight_annotation');
        expect(preferences.toolToGroup).not.toHaveProperty('note_annotation');
    });
});
