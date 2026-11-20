// @vitest-environment jsdom

import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LexicalEditorInputHandle, SlashCommandDescriptor } from '@beaver/agent-ui/composer/LexicalEditorInput';

vi.mock('@beaver/agent-ui/composer/SlashCommandHoverCardPlugin', () => ({
    SlashCommandHoverCardPlugin: () => null,
}));

type SavedDescriptor = { target: object; key: PropertyKey; descriptor: PropertyDescriptor | undefined };

const annotate: SlashCommandDescriptor = { actionId: 'builtin-annotate', commandName: 'annotate', title: 'Annotate', targetType: 'global' };
const summarize: SlashCommandDescriptor = { actionId: 'builtin-summarize', commandName: 'summarize', title: 'Summarize' };

describe('LexicalEditorInputHandle.setCommandArgument', () => {
    let container: HTMLDivElement | null = null;
    let reactRoot: ReturnType<typeof createRoot> | null = null;
    let saved: SavedDescriptor[] = [];
    // What the parent holds, as published by the editor.
    let published = { value: '', pills: [] as SlashCommandDescriptor[] };
    // Clears the parent's text and pills, as a programmatic composer reset does.
    let clear = () => {};

    const patch = (target: object, key: PropertyKey, value: unknown) => {
        saved.push({ target, key, descriptor: Object.getOwnPropertyDescriptor(target, key) });
        Object.defineProperty(target, key, { configurable: true, value });
    };

    beforeEach(() => {
        published = { value: '', pills: [] };
        patch(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
        patch(InputEvent.prototype, 'getTargetRanges', () => []);
        patch(Node.prototype, 'getBoundingClientRect', () => new DOMRect());
        patch(Range.prototype, 'getBoundingClientRect', () => new DOMRect());
        patch(Document.prototype, 'hasFocus', () => true);
    });

    afterEach(async () => {
        if (reactRoot) await act(async () => reactRoot?.unmount());
        container?.remove();
        container = null;
        reactRoot = null;
        for (const { target, key, descriptor } of saved.reverse()) {
            if (descriptor) Object.defineProperty(target, key, descriptor);
            else Reflect.deleteProperty(target, key);
        }
        saved = [];
    });

    const mount = async () => {
        const { LexicalEditorInput } = await import('@beaver/agent-ui/composer/LexicalEditorInput');
        const handle = React.createRef<LexicalEditorInputHandle>();
        container = document.createElement('div');
        document.body.append(container);
        reactRoot = createRoot(container);

        function Harness() {
            const [value, setValue] = useState('');
            const [pills, setPills] = useState<SlashCommandDescriptor[]>([]);
            clear = () => { published = { value: '', pills: [] }; setValue(''); setPills([]); };
            return React.createElement(LexicalEditorInput, {
                ref: handle,
                value,
                pills,
                onChange: (text: string) => { published.value = text; setValue(text); },
                onPillsChange: (next: SlashCommandDescriptor[]) => { published.pills = next; setPills(next); },
                onSubmit: () => {},
            });
        }

        await act(async () => reactRoot?.render(React.createElement(Harness)));
        const editable = container.querySelector<HTMLElement>('.beaver-lexical-content')!;
        editable.focus();
        return { handle, editable };
    };

    it('sets the text after a freshly staged pill and publishes it', async () => {
        const { handle } = await mount();
        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        let found = false;
        await act(async () => { found = handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });

        expect(found).toBe(true);
        expect(published.value).toBe('/annotate the methods');
        expect(published.pills.map(p => p.actionId)).toEqual(['builtin-annotate']);
        expect(handle.current!.getSelectionOffset()).toBe('/annotate the methods'.length);
    });

    it('finds a pill inserted in the same tick, as a staged insert with text does', async () => {
        const { handle } = await mount();
        await act(async () => {
            handle.current!.insertSlashCommand(annotate, null);
            expect(handle.current!.setCommandArgument('builtin-annotate', 'the methods')).toBe(true);
        });
        expect(published.value).toBe('/annotate the methods');
    });

    it('replaces the text already after the pill, including later lines', async () => {
        const { handle } = await mount();
        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'old words'); });
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'every definition of social capital'); });

        expect(published.value).toBe('/annotate every definition of social capital');
        expect(handle.current!.getSlashCommands().map(p => p.actionId)).toEqual(['builtin-annotate']);

        // A pill typed in front of more lines: those lines go too.
        await act(async () => handle.current!.setText('/ann more\nthe rest'));
        await act(async () => handle.current!.insertSlashCommand(annotate, 3, ' more\nthe rest'.length));
        expect(published.value).toBe('/annotate more\nthe rest');
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });
        expect(published.value).toBe('/annotate the methods');
    });

    it('keeps the text before the pill, and later commands with their text', async () => {
        const { handle } = await mount();
        await act(async () => handle.current!.setText('please'));
        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        await act(async () => handle.current!.insertSlashCommand(summarize, null));
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the results'); });

        expect(published.value.trimEnd()).toBe('please /annotate the results /summarize');
        expect(published.pills.map(p => p.actionId)).toEqual(['builtin-annotate', 'builtin-summarize']);

        // Replacing it again replaces only its own text.
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });
        expect(published.value.trimEnd()).toBe('please /annotate the methods /summarize');
    });

    it('leaves the caret after an argument a later command follows', async () => {
        const { handle, editable } = await mount();
        // Each staged insert pins the caret to the end of the content.
        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        await act(async () => handle.current!.insertSlashCommand(summarize, null));
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });
        editable.focus();
        await act(async () => { document.dispatchEvent(new Event('selectionchange')); });

        expect(handle.current!.getSelectionOffset()).toBe('/annotate the methods'.length);
    });

    it('collapses line breaks in the text to spaces', async () => {
        const { handle } = await mount();
        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        await act(async () => { handle.current!.setCommandArgument('builtin-annotate', '  methods\nand   results '); });
        expect(published.value).toBe('/annotate methods and results');
    });

    it('changes nothing and returns false when the action has no pill', async () => {
        const { handle } = await mount();
        await act(async () => handle.current!.setText('hello'));
        let found = true;
        await act(async () => { found = handle.current!.setCommandArgument('builtin-annotate', 'x'); });
        expect(found).toBe(false);
        expect(published.value).toBe('hello');
    });

    describe('removeCommandsWithArguments', () => {
        it('removes the pill and the text after it, keeping what comes before', async () => {
            const { handle } = await mount();
            await act(async () => handle.current!.setText('please'));
            await act(async () => handle.current!.insertSlashCommand(annotate, null));
            await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });
            let removed = 0;
            await act(async () => { removed = handle.current!.removeCommandsWithArguments('builtin-annotate'); });

            expect(removed).toBe(1);
            expect(published.value).toBe('please');
            expect(published.pills).toEqual([]);
        });

        it('keeps later commands and their text', async () => {
            const { handle } = await mount();
            await act(async () => handle.current!.insertSlashCommand(annotate, null));
            await act(async () => handle.current!.insertSlashCommand(summarize, null));
            await act(async () => { handle.current!.setCommandArgument('builtin-summarize', 'focus on methods'); });
            await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });
            expect(published.value).toBe('/annotate the methods /summarize focus on methods');

            await act(async () => { handle.current!.removeCommandsWithArguments('builtin-annotate'); });
            expect(published.value.trim()).toBe('/summarize focus on methods');
            expect(published.pills.map(p => p.actionId)).toEqual(['builtin-summarize']);
        });

        it('keeps a space between the text before it and a command after it', async () => {
            const { handle } = await mount();
            await act(async () => handle.current!.setText('please'));
            await act(async () => handle.current!.insertSlashCommand(annotate, null));
            await act(async () => handle.current!.insertSlashCommand(summarize, null));
            await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'the methods'); });
            await act(async () => { handle.current!.removeCommandsWithArguments('builtin-annotate'); });
            expect(published.value.trimEnd()).toBe('please /summarize');
        });

        it('makes room for the pill that replaces it', async () => {
            const { handle } = await mount();
            await act(async () => handle.current!.insertSlashCommand(annotate, null));
            await act(async () => { handle.current!.setCommandArgument('builtin-annotate', 'old words'); });
            await act(async () => {
                handle.current!.removeCommandsWithArguments('builtin-annotate');
                handle.current!.insertSlashCommand(summarize, null);
            });

            expect(published.value.trim()).toBe('/summarize');
            expect(published.pills.map(p => p.actionId)).toEqual(['builtin-summarize']);
        });

        it('removes every pill of the action, keeping other commands', async () => {
            const { handle } = await mount();
            await act(async () => handle.current!.insertSlashCommand(annotate, null));
            await act(async () => handle.current!.insertSlashCommand(summarize, null));
            await act(async () => handle.current!.insertSlashCommand(annotate, null));
            let removed = 0;
            await act(async () => { removed = handle.current!.removeCommandsWithArguments('builtin-annotate'); });

            expect(removed).toBe(2);
            expect(published.value.trim()).toBe('/summarize');
            expect(published.pills.map(p => p.actionId)).toEqual(['builtin-summarize']);
        });

        it('changes nothing and returns 0 when the action has no pill', async () => {
            const { handle } = await mount();
            await act(async () => handle.current!.setText('hello'));
            let removed = -1;
            await act(async () => { removed = handle.current!.removeCommandsWithArguments('builtin-annotate'); });
            expect(removed).toBe(0);
            expect(published.value).toBe('hello');
        });
    });

    it('publishes a pill inserted again after the parent cleared it', async () => {
        const { handle } = await mount();
        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        await act(async () => clear());
        expect(handle.current!.getSlashCommands()).toEqual([]);

        await act(async () => handle.current!.insertSlashCommand(annotate, null));
        expect(published.value).toBe('/annotate ');
        expect(published.pills.map(p => p.actionId)).toEqual(['builtin-annotate']);
    });
});
