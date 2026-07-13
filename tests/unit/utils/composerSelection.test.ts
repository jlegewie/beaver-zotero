import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    captureComposerSelection,
    getComposerWindowToken,
    registerComposerSelectionProvider,
} from '../../../react/utils/composerSelection';

describe('composer selection providers', () => {
    let element: HTMLElement;

    beforeEach(() => {
        vi.clearAllMocks();
        element = {} as HTMLElement;
    });

    it('captures the selection supplied by the mounted editor', () => {
        registerComposerSelectionProvider(element, () => ({
            anchor: 4,
            focus: 4,
        }));

        expect(captureComposerSelection(element)).toEqual({
            anchor: 4,
            focus: 4,
        });
    });

    it('preserves selection direction', () => {
        registerComposerSelectionProvider(element, () => ({
            anchor: 9,
            focus: 3,
        }));

        expect(captureComposerSelection(element)).toEqual({
            anchor: 9,
            focus: 3,
        });
    });

    it('removes a provider only through its matching cleanup', () => {
        const cleanupFirst = registerComposerSelectionProvider(element, () => ({
            anchor: 1,
            focus: 1,
        }));
        const cleanupSecond = registerComposerSelectionProvider(
            element,
            () => ({
                anchor: 2,
                focus: 2,
            }),
        );

        cleanupFirst();
        expect(captureComposerSelection(element)).toEqual({
            anchor: 2,
            focus: 2,
        });

        cleanupSecond();
        expect(captureComposerSelection(element)).toBeNull();
    });

    it('uses stable opaque tokens instead of retaining windows in transfers', () => {
        const firstWindow = {} as Window;
        const secondWindow = {} as Window;

        const firstToken = getComposerWindowToken(firstWindow);
        expect(getComposerWindowToken(firstWindow)).toBe(firstToken);
        expect(getComposerWindowToken(secondWindow)).not.toBe(firstToken);
        expect(firstToken).not.toBe(firstWindow);
    });
});
