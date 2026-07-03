import React from 'react';
import {
    $applyNodeReplacement,
    DecoratorNode,
    DOMConversionMap,
    DOMConversionOutput,
    DOMExportOutput,
    EditorConfig,
    LexicalEditor,
    LexicalNode,
    NodeKey,
    SerializedLexicalNode,
    Spread,
} from 'lexical';
import { MentionPill } from './MentionPill';

export type SerializedMentionNode = Spread<
    {
        libraryID: number;
        itemKey: string;
    },
    SerializedLexicalNode
>;

/**
 * Inline decorator node that renders a Zotero item as a pill.
 *
 * Intentionally kept independent of the existing atom system - the pill's
 * identity lives in the editor state (libraryID + itemKey) and rendering is
 * done by looking up the Zotero item directly. This lets us demonstrate rich
 * pills without changing how message composition currently handles attachments.
 */
export class MentionNode extends DecoratorNode<React.ReactElement> {
    __libraryID: number;
    __itemKey: string;

    static getType(): string {
        return 'beaver-mention';
    }

    static clone(node: MentionNode): MentionNode {
        return new MentionNode(node.__libraryID, node.__itemKey, node.__key);
    }

    constructor(libraryID: number, itemKey: string, key?: NodeKey) {
        super(key);
        this.__libraryID = libraryID;
        this.__itemKey = itemKey;
    }

    // --- Serialization ------------------------------------------------------

    static importJSON(serializedNode: SerializedMentionNode): MentionNode {
        return $createMentionNode(serializedNode.libraryID, serializedNode.itemKey);
    }

    exportJSON(): SerializedMentionNode {
        return {
            ...super.exportJSON(),
            type: MentionNode.getType(),
            version: 1,
            libraryID: this.__libraryID,
            itemKey: this.__itemKey,
        };
    }

    // Plain text representation used by $getRoot().getTextContent().
    // We use the Zotero-style "libraryID-itemKey" compact form so consumers
    // downstream can still reason about the reference in plain text.
    getTextContent(): string {
        return `@${this.__libraryID}-${this.__itemKey}`;
    }

    // --- DOM ---------------------------------------------------------------

    createDOM(config: EditorConfig): HTMLElement {
        const span = document.createElement('span');
        span.className = 'beaver-mention';
        // Keep the pill from being split by the browser during selection
        span.setAttribute('data-lexical-mention', 'true');
        return span;
    }

    updateDOM(): false {
        return false;
    }

    exportDOM(): DOMExportOutput {
        const span = document.createElement('span');
        span.setAttribute('data-lexical-mention', 'true');
        span.setAttribute('data-library-id', String(this.__libraryID));
        span.setAttribute('data-item-key', this.__itemKey);
        span.textContent = this.getTextContent();
        return { element: span };
    }

    static importDOM(): DOMConversionMap | null {
        return {
            span: (domNode: HTMLElement) => {
                if (!domNode.hasAttribute('data-lexical-mention')) return null;
                return {
                    conversion: (node: HTMLElement): DOMConversionOutput => {
                        const libraryID = Number(node.getAttribute('data-library-id'));
                        const itemKey = node.getAttribute('data-item-key') || '';
                        if (!libraryID || !itemKey) return { node: null };
                        return { node: $createMentionNode(libraryID, itemKey) };
                    },
                    priority: 1,
                };
            },
        };
    }

    // --- Behavior ----------------------------------------------------------

    isInline(): boolean {
        return true;
    }

    isIsolated(): boolean {
        return false;
    }

    isKeyboardSelectable(): boolean {
        // Lets users select the pill with arrow keys before deleting it as one unit.
        return true;
    }

    // --- Accessors ---------------------------------------------------------

    getLibraryID(): number {
        return this.__libraryID;
    }

    getItemKey(): string {
        return this.__itemKey;
    }

    // --- Decoration --------------------------------------------------------

    decorate(_editor: LexicalEditor, _config: EditorConfig): React.ReactElement {
        return (
            <MentionPill
                nodeKey={this.__key}
                libraryID={this.__libraryID}
                itemKey={this.__itemKey}
            />
        );
    }
}

export function $createMentionNode(libraryID: number, itemKey: string): MentionNode {
    return $applyNodeReplacement(new MentionNode(libraryID, itemKey));
}

export function $isMentionNode(
    node: LexicalNode | null | undefined,
): node is MentionNode {
    return node instanceof MentionNode;
}
