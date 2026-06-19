import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: Symbol('searchableLibraryIdsAtom'),
}));

vi.mock('../../../react/atoms/models', () => ({
    selectedModelAtom: Symbol('selectedModelAtom'),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => false),
}));

vi.mock('../../../src/services/itemValidationManager', () => ({
    itemValidationManager: {
        validateItem: vi.fn(),
        validateRegularItem: vi.fn(),
    },
}));

import {
    isHardBlockedValidation,
    isRejectedItemValidation,
    type ItemValidationState,
} from '../../../react/atoms/itemValidation';

function item(kind: 'attachment' | 'regular'): Zotero.Item {
    return {
        isAttachment: () => kind === 'attachment',
    } as unknown as Zotero.Item;
}

function validation(overrides: Partial<ItemValidationState>): ItemValidationState {
    return {
        state: 'readable',
        isValidating: false,
        ...overrides,
    } as ItemValidationState;
}

describe('item validation gates', () => {
    it('treats completed blocked validation as a hard block', () => {
        expect(isHardBlockedValidation(validation({ state: 'blocked' }))).toBe(true);
        expect(isHardBlockedValidation(validation({ state: 'blocked', isValidating: true }))).toBe(false);
    });

    it('removes hard-unreadable standalone attachments', () => {
        expect(isRejectedItemValidation(item('attachment'), validation({
            state: 'unreadable',
            severity: 'error',
        }))).toBe(true);
    });

    it('keeps soft-unreadable standalone attachments attached with a hint', () => {
        expect(isRejectedItemValidation(item('attachment'), validation({
            state: 'unreadable',
            severity: 'info',
        }))).toBe(false);
    });

    it('keeps regular items even when attachment readability is informational', () => {
        expect(isRejectedItemValidation(item('regular'), validation({
            state: 'unreadable',
            severity: 'error',
        }))).toBe(false);
    });

    it('does not reject while validation is still running', () => {
        expect(isRejectedItemValidation(item('attachment'), validation({
            state: 'blocked',
            isValidating: true,
        }))).toBe(false);
    });
});
