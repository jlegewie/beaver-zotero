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
import type { ZoteroItemReference } from '@beaver/agent-core/types/zotero';
import {
    modelObjectIdFromReference,
    UNRESOLVED_LIBRARY_ID,
} from '@beaver/agent-core/identity/libraryRef';
import { MentionPill } from './MentionPill';

/**
 * Everything a mention pill needs to render and to be activated, resolved once
 * by the client that creates it.
 *
 * The node carries display data rather than an identifier to look up, so the
 * pill renders without reaching into any client's data layer. `ref` is the
 * optional item the pill points at: with one, the pill can be revealed in the
 * library and its plain-text form is the portable model-facing object id;
 * without one (a "Selection" or "Whole document" chip in a document-hosted
 * client) the pill is inert but still renders.
 */
export interface MentionDescriptor {
    /** Primary text shown in the pill, already truncated by the builder. */
    label: string;
    /** Optional secondary text (e.g. an item's title next to "Smith 2020"). */
    sublabel?: string;
    /**
     * Client-agnostic item-type icon name, as taken by
     * `ComponentsHost.itemTypeIcon` — an item type (`journalArticle`) or an
     * attachment kind (`attachmentPDF`).
     */
    iconName?: string;
    /** Library item the mention points at, when it points at one. */
    ref?: ZoteroItemReference;
}

/** Current payload: the whole descriptor. */
export type SerializedMentionNodeV2 = Spread<
    {
        descriptor: MentionDescriptor;
    },
    SerializedLexicalNode
>;

/**
 * Legacy (version 1) payload: a device-local item pair, from before the node
 * stored display data. Upgraded to a descriptor on import.
 */
export type SerializedLegacyMentionNode = Spread<
    {
        libraryID: number;
        itemKey: string;
    },
    SerializedLexicalNode
>;

export type SerializedMentionNode = SerializedMentionNodeV2 | SerializedLegacyMentionNode;

/** Marker attribute `importDOM` keys on to recognize an exported pill. */
const MENTION_ATTRIBUTE = 'data-lexical-mention';

/**
 * Reads a serialized payload of either shape as a descriptor. The legacy branch
 * has no display data, so the label falls back to the object id built from the
 * ids it does carry.
 */
function descriptorFromSerialized(serialized: SerializedMentionNode): MentionDescriptor {
    if ('descriptor' in serialized && serialized.descriptor) {
        return serialized.descriptor;
    }
    const { libraryID, itemKey } = serialized as SerializedLegacyMentionNode;
    return {
        label: `${libraryID}-${itemKey}`,
        ref: { library_id: libraryID, zotero_key: itemKey },
    };
}

/**
 * Inline decorator node that renders a library item (or another client-supplied
 * context target) as a pill.
 *
 * Intentionally kept independent of the existing atom system - the pill's
 * content lives in the editor state as a self-contained descriptor, so
 * rendering needs no data lookup. This lets us demonstrate rich pills without
 * changing how message composition currently handles attachments.
 */
export class MentionNode extends DecoratorNode<React.ReactElement> {
    __descriptor: MentionDescriptor;

    static getType(): string {
        return 'beaver-mention';
    }

    static clone(node: MentionNode): MentionNode {
        return new MentionNode(node.__descriptor, node.__key);
    }

    constructor(descriptor: MentionDescriptor, key?: NodeKey) {
        super(key);
        this.__descriptor = descriptor;
    }

    // --- Serialization ------------------------------------------------------

    static importJSON(serializedNode: SerializedMentionNode): MentionNode {
        return $createMentionNode(descriptorFromSerialized(serializedNode));
    }

    exportJSON(): SerializedMentionNodeV2 {
        return {
            ...super.exportJSON(),
            type: MentionNode.getType(),
            // 2: the descriptor payload; version 1 was { libraryID, itemKey }.
            version: 2,
            descriptor: this.__descriptor,
        };
    }

    // Plain text representation used by $getRoot().getTextContent(), which
    // flows into the outgoing message text the model reads. A pill that points
    // at an item uses the portable model-facing id format so the reference
    // resolves the same way as every other object id the model sees; one that
    // points at nothing falls back to its label.
    getTextContent(): string {
        const { ref, label } = this.__descriptor;
        return `@${ref ? modelObjectIdFromReference(ref) : label}`;
    }

    // --- DOM ---------------------------------------------------------------

    createDOM(config: EditorConfig): HTMLElement {
        // Lexical hands no element to derive a document from here, so the
        // bundle's global `document` is what creates the node. That is safe even
        // when the editor lives in another document: Lexical inserts the element
        // into the editor's own document, and Gecko adopts a foreign node on
        // insertion rather than rejecting it.
        const span = document.createElement('span');
        span.className = 'beaver-mention';
        // Keep the pill from being split by the browser during selection
        span.setAttribute(MENTION_ATTRIBUTE, 'true');
        return span;
    }

    updateDOM(): false {
        return false;
    }

    exportDOM(): DOMExportOutput {
        const { label, sublabel, iconName, ref } = this.__descriptor;
        // Same as createDOM: the export target is a detached span the caller
        // serializes or adopts, so the bundle's global document is the right
        // owner.
        const span = document.createElement('span');
        span.setAttribute(MENTION_ATTRIBUTE, 'true');
        span.setAttribute('data-mention-label', label);
        if (sublabel) span.setAttribute('data-mention-sublabel', sublabel);
        if (iconName) span.setAttribute('data-mention-icon', iconName);
        if (ref) {
            span.setAttribute('data-library-id', String(ref.library_id));
            span.setAttribute('data-item-key', ref.zotero_key);
            if (ref.library_ref) span.setAttribute('data-library-ref', ref.library_ref);
        }
        span.textContent = this.getTextContent();
        return { element: span };
    }

    static importDOM(): DOMConversionMap | null {
        return {
            span: (domNode: HTMLElement) => {
                if (!domNode.hasAttribute(MENTION_ATTRIBUTE)) return null;
                return {
                    conversion: (node: HTMLElement): DOMConversionOutput => {
                        const zoteroKey = node.getAttribute('data-item-key') ?? '';
                        const libraryRef = node.getAttribute('data-library-ref');
                        const libraryID = Number(node.getAttribute('data-library-id'));
                        const ref: ZoteroItemReference | undefined = zoteroKey
                            ? {
                                library_id: Number.isFinite(libraryID)
                                    ? libraryID
                                    : UNRESOLVED_LIBRARY_ID,
                                zotero_key: zoteroKey,
                                ...(libraryRef ? { library_ref: libraryRef } : {}),
                            }
                            : undefined;
                        // A pill exported before the descriptor existed carries
                        // only the ids; rebuild the same fallback label the
                        // legacy JSON branch uses.
                        const label =
                            node.getAttribute('data-mention-label') ||
                            (ref ? `${ref.library_id}-${ref.zotero_key}` : '');
                        if (!label) return { node: null };
                        const sublabel = node.getAttribute('data-mention-sublabel');
                        const iconName = node.getAttribute('data-mention-icon');
                        return {
                            node: $createMentionNode({
                                label,
                                ...(sublabel ? { sublabel } : {}),
                                ...(iconName ? { iconName } : {}),
                                ...(ref ? { ref } : {}),
                            }),
                        };
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

    getDescriptor(): MentionDescriptor {
        return this.__descriptor;
    }

    // --- Decoration --------------------------------------------------------

    decorate(_editor: LexicalEditor, _config: EditorConfig): React.ReactElement {
        return <MentionPill nodeKey={this.__key} descriptor={this.__descriptor} />;
    }
}

export function $createMentionNode(descriptor: MentionDescriptor): MentionNode {
    return $applyNodeReplacement(new MentionNode(descriptor));
}

export function $isMentionNode(
    node: LexicalNode | null | undefined,
): node is MentionNode {
    return node instanceof MentionNode;
}
