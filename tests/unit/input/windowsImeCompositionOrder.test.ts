// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/composer/SlashCommandHoverCardPlugin', () => ({
    SlashCommandHoverCardPlugin: () => null,
}));

/**
 * The composition-order workaround itself is covered by imeComposition.test.ts;
 * here it is a spy, so the only thing under test is when the editor installs it.
 */
const deferral = vi.hoisted(() => ({
    register: vi.fn(),
    dispose: vi.fn(),
}));

vi.mock('@beaver/agent-ui/composer/imeComposition', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@beaver/agent-ui/composer/imeComposition')
    >();
    return { ...actual, registerCompositionEndDeferral: deferral.register };
});

type SavedDescriptor = {
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
};

/**
 * The Windows IME composition-order workaround is gated on the platform of the
 * window the editor renders in, so mounting the real editor is the only way to
 * exercise the gate.
 */
describe('windows IME composition-order gate', () => {
    let container: HTMLDivElement | null = null;
    let reactRoot: ReturnType<typeof createRoot> | null = null;
    let savedDescriptors: SavedDescriptor[] = [];

    const patchProperty = (target: object, key: PropertyKey, value: unknown) => {
        savedDescriptors.push({
            target,
            key,
            descriptor: Object.getOwnPropertyDescriptor(target, key),
        });
        Object.defineProperty(target, key, { configurable: true, value });
    };

    /** Shadows jsdom's `Navigator.prototype.platform` getter for one test. */
    const patchPlatform = (platform: string) => {
        patchProperty(globalThis.window.navigator, 'platform', platform);
    };

    beforeEach(() => {
        deferral.register.mockReset();
        deferral.dispose.mockReset();
        deferral.register.mockReturnValue(deferral.dispose);
        patchProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        patchProperty(InputEvent.prototype, 'getTargetRanges', () => []);
        patchProperty(Node.prototype, 'getBoundingClientRect', () => new DOMRect());
        patchProperty(Range.prototype, 'getBoundingClientRect', () => new DOMRect());
        patchProperty(Document.prototype, 'hasFocus', () => true);
    });

    afterEach(async () => {
        if (reactRoot) {
            await act(async () => reactRoot?.unmount());
        }
        container?.remove();
        container = null;
        reactRoot = null;
        for (const { target, key, descriptor } of savedDescriptors.reverse()) {
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else Reflect.deleteProperty(target, key);
        }
        savedDescriptors = [];
    });

    const mountEditor = async () => {
        const { LexicalEditorInput } = await import(
            '@beaver/agent-ui/composer/LexicalEditorInput'
        );
        container = globalThis.document.createElement('div');
        globalThis.document.body.append(container);
        reactRoot = createRoot(container);

        function Harness() {
            const [value, setValue] = useState('');
            return React.createElement(LexicalEditorInput, {
                value,
                onChange: setValue,
                onSubmit: () => {},
                placeholder: 'Message Beaver',
            });
        }

        await act(async () => reactRoot?.render(React.createElement(Harness)));
    };

    const unmount = async () => {
        await act(async () => reactRoot?.unmount());
        reactRoot = null;
    };

    it('installs the composition-order workaround once on Windows', async () => {
        patchPlatform('Win32');
        await mountEditor();

        expect(deferral.register).toHaveBeenCalledTimes(1);
        expect(deferral.dispose).not.toHaveBeenCalled();
    });

    it('disposes the workaround when the editor unmounts', async () => {
        patchPlatform('Win32');
        await mountEditor();
        await unmount();

        expect(deferral.register).toHaveBeenCalledTimes(1);
        expect(deferral.dispose).toHaveBeenCalledTimes(1);
    });

    it('leaves the workaround off every other platform', async () => {
        patchPlatform('MacIntel');
        await mountEditor();
        await unmount();

        expect(deferral.register).not.toHaveBeenCalled();
        expect(deferral.dispose).not.toHaveBeenCalled();
    });
});
