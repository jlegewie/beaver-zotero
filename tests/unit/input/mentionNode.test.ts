// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createEditor, type LexicalEditor } from 'lexical';
import {
    $createMentionNode,
    MentionNode,
    type MentionDescriptor,
    type SerializedLegacyMentionNode,
    type SerializedMentionNodeV2,
} from '../../../react/components/input/lexical/MentionNode';

/**
 * Node work has to run inside an editor: `$createMentionNode` applies node
 * replacement, which needs an active editor with the node registered.
 */
function withEditor<T>(fn: (editor: LexicalEditor) => T): T {
    const editor = createEditor({
        nodes: [MentionNode],
        onError: (error) => {
            throw error;
        },
    });
    let result!: T;
    editor.update(
        () => {
            result = fn(editor);
        },
        { discrete: true },
    );
    return result;
}

const itemDescriptor: MentionDescriptor = {
    label: 'Smith 2020',
    sublabel: 'On the origin of pills',
    iconName: 'journalArticle',
    ref: { library_id: 1, zotero_key: 'ABCD1234', library_ref: 'u' },
};

const refLessDescriptor: MentionDescriptor = { label: 'Selection' };

describe('MentionNode serialization', () => {
    it('round-trips a descriptor through exportJSON/importJSON', () => {
        const restored = withEditor(() => {
            const json = $createMentionNode(itemDescriptor).exportJSON();
            return MentionNode.importJSON(json).getDescriptor();
        });

        expect(restored).toEqual(itemDescriptor);
    });

    it('round-trips a descriptor that points at nothing', () => {
        const restored = withEditor(() => {
            const json = $createMentionNode(refLessDescriptor).exportJSON();
            return MentionNode.importJSON(json).getDescriptor();
        });

        expect(restored).toEqual(refLessDescriptor);
    });

    it('exports the descriptor payload under the current version', () => {
        const json = withEditor(
            () => $createMentionNode(itemDescriptor).exportJSON() as SerializedMentionNodeV2,
        );

        expect(json.type).toBe('beaver-mention');
        expect(json.version).toBe(2);
        expect(json.descriptor).toEqual(itemDescriptor);
    });

    it('upgrades a legacy libraryID/itemKey payload into a descriptor', () => {
        const legacy: SerializedLegacyMentionNode = {
            type: 'beaver-mention',
            version: 1,
            libraryID: 3,
            itemKey: 'LEGACY99',
        };

        const restored = withEditor(() => MentionNode.importJSON(legacy).getDescriptor());

        expect(restored).toEqual({
            label: '3-LEGACY99',
            ref: { library_id: 3, zotero_key: 'LEGACY99' },
        });
    });
});

describe('MentionNode text content', () => {
    it('uses the portable object id when the descriptor points at an item', () => {
        const text = withEditor(() => $createMentionNode(itemDescriptor).getTextContent());

        expect(text).toBe('@u-ABCD1234');
    });

    it('falls back to the device-local library id when there is no portable ref', () => {
        const text = withEditor(() =>
            $createMentionNode({
                label: 'Doe 1999',
                ref: { library_id: 7, zotero_key: 'KEY7' },
            }).getTextContent(),
        );

        expect(text).toBe('@7-KEY7');
    });

    it('falls back to the label when the descriptor points at nothing', () => {
        const text = withEditor(() => $createMentionNode(refLessDescriptor).getTextContent());

        expect(text).toBe('@Selection');
    });
});

describe('MentionNode DOM conversion', () => {
    /** Runs the node's own importDOM conversion over an element. */
    function importElement(element: HTMLElement): MentionNode | null {
        return withEditor(() => {
            const conversion = MentionNode.importDOM()?.span?.(element);
            if (!conversion) return null;
            return (conversion.conversion(element)?.node ?? null) as MentionNode | null;
        });
    }

    it('round-trips a descriptor through exportDOM/importDOM', () => {
        const element = withEditor(
            () => $createMentionNode(itemDescriptor).exportDOM().element as HTMLElement,
        );

        expect(element.textContent).toBe('@u-ABCD1234');
        expect(importElement(element)?.getDescriptor()).toEqual(itemDescriptor);
    });

    it('round-trips a descriptor that points at nothing', () => {
        const element = withEditor(
            () => $createMentionNode(refLessDescriptor).exportDOM().element as HTMLElement,
        );

        expect(importElement(element)?.getDescriptor()).toEqual(refLessDescriptor);
    });

    it('upgrades a legacy id-only element into a descriptor', () => {
        const element = document.createElement('span');
        element.setAttribute('data-lexical-mention', 'true');
        element.setAttribute('data-library-id', '3');
        element.setAttribute('data-item-key', 'LEGACY99');

        expect(importElement(element)?.getDescriptor()).toEqual({
            label: '3-LEGACY99',
            ref: { library_id: 3, zotero_key: 'LEGACY99' },
        });
    });

    it('ignores a span that is not a mention', () => {
        const element = document.createElement('span');
        element.textContent = '@u-ABCD1234';

        expect(importElement(element)).toBeNull();
    });
});
