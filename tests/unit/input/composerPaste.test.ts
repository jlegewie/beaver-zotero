// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComposerPasteHandlers } from '../../../react/components/input/lexical/LexicalEditorInput';

vi.mock('../../../react/components/input/lexical/SlashCommandHoverCardPlugin', () => ({
    SlashCommandHoverCardPlugin: () => null,
}));

type SavedDescriptor = {
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
};

/**
 * jsdom implements no ClipboardEvent, and Lexical identifies paste events by
 * constructor name, so the stand-in has to carry that name.
 */
class TestClipboardEvent extends Event {
    readonly clipboardData: DataTransfer | null;
    constructor(type: string, init: EventInit & { clipboardData?: unknown } = {}) {
        super(type, init);
        this.clipboardData = (init.clipboardData ?? null) as DataTransfer | null;
    }
}
Object.defineProperty(TestClipboardEvent, 'name', { value: 'ClipboardEvent' });

/**
 * Both routes an attachable paste can take: a paste event carrying files, and
 * the paste key for a clipboard that fires no paste event.
 */
describe('composer paste handling', () => {
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

    /**
     * The accelerator key is derived from the navigator of the window the editor
     * renders in, so the platform is stubbed there. An own data property shadows
     * jsdom's `Navigator.prototype.platform` getter and is removed again by the
     * descriptor restore in `afterEach`.
     */
    const patchPlatform = (platform: string) => {
        patchProperty(globalThis.window.navigator, 'platform', platform);
    };

    beforeEach(() => {
        patchProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        patchProperty(InputEvent.prototype, 'getTargetRanges', () => []);
        patchProperty(Node.prototype, 'getBoundingClientRect', () => new DOMRect());
        patchProperty(Range.prototype, 'getBoundingClientRect', () => new DOMRect());
        patchProperty(Document.prototype, 'hasFocus', () => true);
        patchProperty(globalThis, 'ClipboardEvent', TestClipboardEvent);
        patchProperty(globalThis.window, 'ClipboardEvent', TestClipboardEvent);
        patchPlatform('MacIntel');
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

    const mountEditor = async (pasteHandlers: ComposerPasteHandlers) => {
        const { LexicalEditorInput } = await import(
            '../../../react/components/input/lexical/LexicalEditorInput'
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
                pasteHandlers,
            });
        }

        await act(async () => reactRoot?.render(React.createElement(Harness)));
        const editable = container.querySelector<HTMLElement>('.beaver-lexical-content');
        expect(editable).not.toBeNull();
        editable!.focus();
        return editable!;
    };

    /** A paste event whose clipboardData reports the given files and text. */
    const pasteEvent = (files: File[], text = '') =>
        new TestClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: {
                files,
                items: [],
                types: files.length ? ['Files'] : ['text/plain'],
                getData: () => text,
            },
        });

    const pasteKeyEvent = (init: KeyboardEventInit = {}) =>
        new KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true, ...init });

    const imageFile = () =>
        new File([new Uint8Array([1, 2, 3])], 'image.png', { type: 'image/png' });

    describe('paste event', () => {
        it('hands pasted files to the host and consumes the event', async () => {
            const onPasteFiles = vi.fn();
            const editable = await mountEditor({ onPasteFiles });

            const file = imageFile();
            const event = pasteEvent([file]);
            await act(async () => {
                editable.dispatchEvent(event);
            });

            expect(onPasteFiles).toHaveBeenCalledTimes(1);
            expect(onPasteFiles.mock.calls[0][0]).toEqual([file]);
            expect(event.defaultPrevented).toBe(true);
            // The attachment paste must not also drop text into the composer.
            expect(editable.textContent).toBe('');
        });

        it('ignores a text-only paste', async () => {
            const onPasteFiles = vi.fn();
            const editable = await mountEditor({ onPasteFiles });

            await act(async () => {
                editable.dispatchEvent(pasteEvent([], 'hello'));
            });

            expect(onPasteFiles).not.toHaveBeenCalled();
        });

        it('ignores a file paste when the host cannot attach files', async () => {
            const editable = await mountEditor({});

            const event = pasteEvent([imageFile()]);
            await act(async () => {
                editable.dispatchEvent(event);
            });

            // Nothing to do — the paste falls through to the default handling.
            expect(editable.textContent).toBe('');
        });

        it('reads the clipboard when a paste arrives without the image', async () => {
            // Some platforms dispatch the paste for a clipboard image but leave
            // the image out of the payload; the paste must still attach.
            const onPasteFiles = vi.fn();
            const hasClipboardImage = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ onPasteFiles, hasClipboardImage, onPasteFromClipboard });

            const event = pasteEvent([]);
            await act(async () => {
                editable.dispatchEvent(event);
            });

            expect(onPasteFromClipboard).toHaveBeenCalledTimes(1);
            expect(onPasteFiles).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(true);
        });

        it('does not read the clipboard when a text paste arrives', async () => {
            const hasClipboardImage = vi.fn(() => false);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardImage, onPasteFromClipboard });

            await act(async () => {
                editable.dispatchEvent(pasteEvent([], 'hello'));
            });

            expect(onPasteFromClipboard).not.toHaveBeenCalled();
        });

        it('prefers the event payload over the clipboard when both are present', async () => {
            const onPasteFiles = vi.fn();
            const hasClipboardImage = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ onPasteFiles, hasClipboardImage, onPasteFromClipboard });

            await act(async () => {
                editable.dispatchEvent(pasteEvent([imageFile()]));
            });

            expect(onPasteFiles).toHaveBeenCalledTimes(1);
            expect(onPasteFromClipboard).not.toHaveBeenCalled();
        });
    });

    describe('paste key', () => {
        it('attaches the clipboard file and consumes the key', async () => {
            const hasClipboardFile = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardFile, onPasteFromClipboard });

            const event = pasteKeyEvent();
            await act(async () => {
                editable.dispatchEvent(event);
            });

            expect(onPasteFromClipboard).toHaveBeenCalledTimes(1);
            expect(event.defaultPrevented).toBe(true);
        });

        it('leaves an ordinary text paste alone', async () => {
            const hasClipboardFile = vi.fn(() => false);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardFile, onPasteFromClipboard });

            const event = pasteKeyEvent();
            await act(async () => {
                editable.dispatchEvent(event);
            });

            expect(hasClipboardFile).toHaveBeenCalled();
            expect(onPasteFromClipboard).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        });

        it('leaves a clipboard image to the paste event it fires', async () => {
            const hasClipboardFile = vi.fn(() => false);
            const hasClipboardImage = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardFile, hasClipboardImage, onPasteFromClipboard });

            const event = pasteKeyEvent();
            await act(async () => {
                editable.dispatchEvent(event);
            });

            // Claiming the key here would suppress the paste event, which is
            // the better route when the platform does deliver the image.
            expect(onPasteFromClipboard).not.toHaveBeenCalled();
            expect(event.defaultPrevented).toBe(false);
        });

        it('does not check the clipboard for other keys or modifiers', async () => {
            const hasClipboardFile = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardFile, onPasteFromClipboard });

            await act(async () => {
                // Wrong key, then the accelerator for a different platform,
                // then paste-with-a-modifier (a different command).
                editable.dispatchEvent(pasteKeyEvent({ key: 'c' }));
                editable.dispatchEvent(pasteKeyEvent({ metaKey: false, ctrlKey: true }));
                editable.dispatchEvent(pasteKeyEvent({ shiftKey: true }));
                editable.dispatchEvent(pasteKeyEvent({ altKey: true }));
            });

            expect(hasClipboardFile).not.toHaveBeenCalled();
            expect(onPasteFromClipboard).not.toHaveBeenCalled();
        });

        it('uses Ctrl as the accelerator off macOS', async () => {
            patchPlatform('Linux x86_64');
            const hasClipboardFile = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardFile, onPasteFromClipboard });

            await act(async () => {
                editable.dispatchEvent(pasteKeyEvent({ metaKey: false, ctrlKey: true }));
            });

            expect(onPasteFromClipboard).toHaveBeenCalledTimes(1);
        });

        it('leaves the key to an active input method', async () => {
            const hasClipboardFile = vi.fn(() => true);
            const onPasteFromClipboard = vi.fn();
            const editable = await mountEditor({ hasClipboardFile, onPasteFromClipboard });

            await act(async () => {
                // keyCode 229 is the "composing" key event every IME sends.
                editable.dispatchEvent(pasteKeyEvent({ keyCode: 229 } as KeyboardEventInit));
            });

            expect(onPasteFromClipboard).not.toHaveBeenCalled();
        });
    });
});
