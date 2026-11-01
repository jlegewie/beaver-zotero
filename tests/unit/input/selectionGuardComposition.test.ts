// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@beaver/agent-ui/composer/SlashCommandHoverCardPlugin', () => ({
    SlashCommandHoverCardPlugin: () => null,
}));

type SavedDescriptor = {
    target: object;
    key: PropertyKey;
    descriptor: PropertyDescriptor | undefined;
};

/**
 * Zotero's chrome document resets a contenteditable's selection offsets to 0
 * on any DOM mutation elsewhere in the document. jsdom does not, so each test
 * applies that reset by hand right before the unrelated mutation and checks
 * how the composer's selection guard answers it mid-composition.
 */
describe('selection guard during an IME composition', () => {
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

    beforeEach(() => {
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

    /** Mounts the composer with `text`, focuses it, and returns its text node. */
    const mountComposer = async (text: string) => {
        const { LexicalEditorInput } = await import(
            '@beaver/agent-ui/composer/LexicalEditorInput'
        );
        container = document.createElement('div');
        document.body.append(container);
        reactRoot = createRoot(container);

        function Harness() {
            const [value, setValue] = useState(text);
            return React.createElement(LexicalEditorInput, {
                value,
                onChange: setValue,
                onSubmit: () => {},
                placeholder: 'Message Beaver',
            });
        }

        await act(async () => reactRoot?.render(React.createElement(Harness)));
        const root = container.querySelector<HTMLElement>('[contenteditable="true"]');
        if (!root) throw new Error('composer root not mounted');
        patchProperty(document, 'activeElement', root);
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const textNode = walker.nextNode() as Text | null;
        if (!textNode) throw new Error('composer text not rendered');
        return { root, textNode };
    };

    const caretOffset = () => window.getSelection()?.anchorOffset;

    /** Chrome-document reset followed by an unrelated mutation, then its observer microtask. */
    const resetByUnrelatedMutation = async (textNode: Text) => {
        window.getSelection()?.collapse(textNode, 0);
        const unrelated = document.createElement('span');
        document.documentElement.append(unrelated);
        unrelated.remove();
        await act(async () => { await Promise.resolve(); });
    };

    const startComposingAt = (root: HTMLElement, textNode: Text, offset: number) => {
        root.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
        window.getSelection()?.collapse(textNode, offset);
        root.dispatchEvent(new InputEvent('input', {
            bubbles: true,
            data: 'n',
            inputType: 'insertCompositionText',
            isComposing: true,
        }));
    };

    it('undoes a reset to the start of the input mid-composition', async () => {
        const { root, textNode } = await mountComposer('hello world');
        startComposingAt(root, textNode, 5);

        await resetByUnrelatedMutation(textNode);

        expect(caretOffset()).toBe(5);
    });

    it('restores the caret the IME last moved to, not the one from its last input', async () => {
        const { root, textNode } = await mountComposer('hello world');
        startComposingAt(root, textNode, 5);
        // Clause navigation: the IME moves the caret without an input event.
        window.getSelection()?.collapse(textNode, 3);
        document.dispatchEvent(new Event('selectionchange'));

        await resetByUnrelatedMutation(textNode);

        expect(caretOffset()).toBe(3);
    });

    it('leaves a caret that is not at the reset position alone', async () => {
        const { root, textNode } = await mountComposer('hello world');
        startComposingAt(root, textNode, 5);
        // The IME moved the caret and its selectionchange has not run yet.
        window.getSelection()?.collapse(textNode, 2);
        const unrelated = document.createElement('span');
        document.documentElement.append(unrelated);
        unrelated.remove();
        await act(async () => { await Promise.resolve(); });

        expect(caretOffset()).toBe(2);
    });
});
