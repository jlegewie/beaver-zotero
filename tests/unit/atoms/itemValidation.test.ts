import { beforeEach, describe, expect, it, vi } from 'vitest';
import { atom, createStore } from 'jotai';

const mocks = vi.hoisted(() => ({
    validateItem: vi.fn(),
    validateRegularItem: vi.fn(),
}));

vi.mock('../../../react/atoms/profile', () => ({
    searchableLibraryIdsAtom: atom<number[]>([]),
    isLibraryAccessReadyAtom: atom<boolean>(false),
}));

vi.mock('../../../react/atoms/models', () => ({
    selectedModelAtom: atom(null),
}));

vi.mock('../../../src/utils/prefs', () => ({
    getPref: vi.fn(() => false),
}));

vi.mock('../../../src/services/itemValidationManager', () => ({
    itemValidationManager: {
        validateItem: mocks.validateItem,
        validateRegularItem: mocks.validateRegularItem,
    },
}));

import {
    itemValidationResultsAtom,
    isHardBlockedValidation,
    isRejectedItemValidation,
    type ItemValidationState,
    validateItemAtom,
    validateRegularItemAtom,
} from '../../../react/atoms/itemValidation';
import {
    isLibraryAccessReadyAtom,
    searchableLibraryIdsAtom,
} from '../../../react/atoms/profile';

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
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('defers validation while library access is still hydrating', async () => {
        const store = createStore();
        const attachment = {
            key: 'ATTACH01',
            libraryID: 1,
            isAttachment: () => true,
        } as unknown as Zotero.Item;

        await store.set(validateItemAtom, { item: attachment });

        expect(mocks.validateItem).not.toHaveBeenCalled();
        expect(store.get(itemValidationResultsAtom).has('1-ATTACH01')).toBe(false);
    });

    it('defers regular-item batch validation while library access is still hydrating', async () => {
        const store = createStore();
        const regularItem = {
            key: 'REGULAR1',
            libraryID: 1,
            isRegularItem: () => true,
        } as unknown as Zotero.Item;

        await store.set(validateRegularItemAtom, regularItem);

        expect(mocks.validateRegularItem).not.toHaveBeenCalled();
        expect(store.get(itemValidationResultsAtom).has('1-REGULAR1')).toBe(false);
    });

    it('validates normally once library access is ready', async () => {
        const store = createStore();
        const attachment = {
            key: 'ATTACH02',
            libraryID: 1,
            isAttachment: () => true,
        } as unknown as Zotero.Item;
        mocks.validateItem.mockResolvedValueOnce({ state: 'readable' });
        store.set(searchableLibraryIdsAtom, [1]);
        store.set(isLibraryAccessReadyAtom, true);

        await store.set(validateItemAtom, { item: attachment });

        expect(mocks.validateItem).toHaveBeenCalledWith(attachment, expect.objectContaining({
            searchableLibraryIds: [1],
        }));
        expect(store.get(itemValidationResultsAtom).get('1-ATTACH02')).toMatchObject({
            state: 'readable',
            isValidating: false,
        });
    });

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
