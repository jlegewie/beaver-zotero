import { describe, expect, it } from 'vitest';
import {
    $createParagraphNode,
    $createTextNode,
    $getRoot,
    $getSelection,
    $isRangeSelection,
    $setSelection,
    createEditor,
} from 'lexical';
import {
    $getFlatSelectionOffsets,
    $selectFlatSelection,
} from '../../../react/components/input/lexical/selectionOffsets';
import type { ComposerSelection } from '../../../react/utils/composerSelection';

function createTestEditor() {
    return createEditor({
        namespace: 'selection-offset-test',
        onError: (error) => {
            throw error;
        },
    });
}

describe('Lexical composer selection offsets', () => {
    it('captures and restores a caret in an empty paragraph', () => {
        const editor = createTestEditor();
        let captured: ComposerSelection | null = null;
        let blankParagraphKey = '';

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const first = $createParagraphNode().append($createTextNode('first'));
            const blank = $createParagraphNode();
            const last = $createParagraphNode().append($createTextNode('last'));
            blankParagraphKey = blank.getKey();
            root.append(first, blank, last);
            blank.select(0, 0);
            captured = $getFlatSelectionOffsets();
        }, { discrete: true });

        expect(captured).toEqual({
            anchor: 7,
            focus: 7,
            anchorType: 'element',
            focusType: 'element',
        });

        editor.update(() => {
            $setSelection(null);
            $selectFlatSelection(captured!);
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({
                key: blankParagraphKey,
                offset: 0,
                type: 'element',
            });
            expect(selection.focus).toMatchObject({
                key: blankParagraphKey,
                offset: 0,
                type: 'element',
            });
        }, { discrete: true });
    });

    it('restores a text caret when the destination editor has no selection', () => {
        const editor = createTestEditor();

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            root.append($createParagraphNode().append($createTextNode('hello world')));
            $setSelection(null);

            $selectFlatSelection({
                anchor: 3,
                focus: 3,
                anchorType: 'text',
                focusType: 'text',
            });

            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({
                offset: 3,
                type: 'text',
            });
            expect(selection.focus).toMatchObject({
                offset: 3,
                type: 'text',
            });
        }, { discrete: true });
    });

    it('restores a caret into a trailing empty paragraph', () => {
        const editor = createTestEditor();
        let captured: ComposerSelection | null = null;
        let blankParagraphKey = '';

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const first = $createParagraphNode().append($createTextNode('first'));
            const blank = $createParagraphNode();
            blankParagraphKey = blank.getKey();
            root.append(first, blank);
            blank.select(0, 0);
            captured = $getFlatSelectionOffsets();
        }, { discrete: true });

        expect(captured).toEqual({
            anchor: 7,
            focus: 7,
            anchorType: 'element',
            focusType: 'element',
        });

        editor.update(() => {
            $setSelection(null);
            $selectFlatSelection(captured!);
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({
                key: blankParagraphKey,
                offset: 0,
                type: 'element',
            });
            expect(selection.focus).toMatchObject({
                key: blankParagraphKey,
                offset: 0,
                type: 'element',
            });
        }, { discrete: true });
    });

    it('falls back to the equivalent text offset after a cross-editor rebuild', () => {
        const editor = createTestEditor();
        let captured: ComposerSelection | null = null;
        let textContent = '';

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            const first = $createParagraphNode().append($createTextNode('first'));
            const blank = $createParagraphNode();
            const last = $createParagraphNode().append($createTextNode('last'));
            root.append(first, blank, last);
            blank.select(0, 0);
            captured = $getFlatSelectionOffsets();
            textContent = root.getTextContent();
        }, { discrete: true });

        editor.update(() => {
            const root = $getRoot();
            root.clear();
            root.append($createParagraphNode().append($createTextNode(textContent)));
            $setSelection(null);
            $selectFlatSelection(captured!);
            const selection = $getSelection();
            expect($isRangeSelection(selection)).toBe(true);
            if (!$isRangeSelection(selection)) return;
            expect(selection.anchor).toMatchObject({
                offset: 7,
                type: 'text',
            });
            expect(selection.focus).toMatchObject({
                offset: 7,
                type: 'text',
            });
        }, { discrete: true });
    });
});
