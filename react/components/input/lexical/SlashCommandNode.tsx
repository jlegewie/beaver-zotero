import {
    $applyNodeReplacement,
    EditorConfig,
    LexicalNode,
    NodeKey,
    SerializedTextNode,
    Spread,
    TextNode,
} from 'lexical';
import { ActionTargetType } from '../../../types/actions';

export type SerializedSlashCommandNode = Spread<
    {
        commandName: string;
        actionId: string;
        targetType?: ActionTargetType;
        title?: string;
        argumentHint?: string;
    },
    SerializedTextNode
>;

/**
 * Inline TextNode subclass used to render /slash commands as colored pills.
 *
 * Implemented as a token-mode TextNode (like a mention) rather than a
 * DecoratorNode so that:
 *   - the displayed text is exactly what is stored in the editor (WYSIWYG),
 *   - keyboard users and screen readers still see/hear the command text.
 *
 * Token mode makes the pill atomic for editing: backspace/delete removes the
 * whole pill in one keystroke, and typing with the caret inside it replaces
 * the pill rather than editing it per character. (Arrow keys skipping over
 * the pill as a unit is handled separately by CaretNavigationPlugin, which
 * drives the native Selection API.)
 *
 * `canInsertTextBefore`/`canInsertTextAfter` return false so that typing at
 * the pill's boundaries spills into a sibling plain text node (the pill keeps
 * its color). A node transform (SlashCommandRevertPlugin in
 * LexicalEditorInput) remains as a safety net: if the node's text is ever
 * mutated programmatically so it no longer reads "/<commandName>", the node
 * reverts to plain text.
 *
 * The visual (background color, padding, etc.) is applied via the CSS class
 * "beaver-slash-command" below - kept purely visual on purpose.
 */
export class SlashCommandNode extends TextNode {
    __commandName: string;
    __actionId: string;
    __targetType?: ActionTargetType;
    // Human-readable action title, surfaced in the pill's hover card
    // (SlashCommandHoverCardPlugin) via the data-title attribute.
    __title?: string;
    // Ghost text rendered after the pill while it awaits an argument
    // (see ArgumentHintPlugin in LexicalEditorInput).
    __argumentHint?: string;

    static getType(): string {
        return 'beaver-slash-command';
    }

    static clone(node: SlashCommandNode): SlashCommandNode {
        return new SlashCommandNode(
            node.__commandName,
            node.__actionId,
            node.__targetType,
            node.__title,
            node.__argumentHint,
            node.__text,
            node.__key,
        );
    }

    constructor(
        commandName: string,
        actionId = '',
        targetType?: ActionTargetType,
        title?: string,
        argumentHint?: string,
        text?: string,
        key?: NodeKey,
    ) {
        // Display the "/name" literal in the text so screen readers still hear it
        super(text ?? `/${commandName}`, key);
        this.__commandName = commandName;
        this.__actionId = actionId;
        this.__targetType = targetType;
        this.__title = title;
        this.__argumentHint = argumentHint;
        // Token mode is applied in $createSlashCommandNode (Lexical copies
        // __mode across clones via afterCloneFrom, so setting it once at
        // creation is enough).
    }

    static importJSON(serializedNode: SerializedSlashCommandNode): SlashCommandNode {
        const node = $createSlashCommandNode(
            serializedNode.commandName,
            serializedNode.actionId,
            serializedNode.targetType,
            serializedNode.title,
            serializedNode.argumentHint,
        );
        node.setFormat(serializedNode.format);
        node.setDetail(serializedNode.detail);
        node.setMode(serializedNode.mode);
        node.setStyle(serializedNode.style);
        return node;
    }

    exportJSON(): SerializedSlashCommandNode {
        return {
            ...super.exportJSON(),
            type: SlashCommandNode.getType(),
            version: 1,
            commandName: this.__commandName,
            actionId: this.__actionId,
            targetType: this.__targetType,
            title: this.__title,
            argumentHint: this.__argumentHint,
        };
    }

    createDOM(config: EditorConfig): HTMLElement {
        const dom = super.createDOM(config);
        // "-live" marks the editable in-input pill (clickable, opens the
        // action in preferences) as opposed to the read-only pills rendered
        // in chat history, which share the base class only.
        dom.classList.add('beaver-slash-command', 'beaver-slash-command-live');
        dom.setAttribute('data-lexical-slash', 'true');
        dom.setAttribute('data-command', this.__commandName);
        if (this.__actionId) dom.setAttribute('data-action-id', this.__actionId);
        // Title snapshot for the hover card's fallback when the action has
        // been deleted (a native `title` would double up with the card).
        if (this.__title) dom.setAttribute('data-title', this.__title);
        return dom;
    }

    updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
        const updated = super.updateDOM(prevNode, dom, config);
        if (prevNode.__commandName !== this.__commandName) {
            dom.setAttribute('data-command', this.__commandName);
        }
        if (prevNode.__actionId !== this.__actionId) {
            if (this.__actionId) dom.setAttribute('data-action-id', this.__actionId);
            else dom.removeAttribute('data-action-id');
        }
        if (prevNode.__title !== this.__title) {
            if (this.__title) dom.setAttribute('data-title', this.__title);
            else dom.removeAttribute('data-title');
        }
        return updated;
    }

    getCommandName(): string {
        return this.__commandName;
    }

    getActionId(): string {
        return this.__actionId;
    }

    getTargetType(): ActionTargetType | undefined {
        return this.__targetType;
    }

    getTitle(): string | undefined {
        return this.__title;
    }

    getArgumentHint(): string | undefined {
        return this.__argumentHint;
    }

    // Slash pills should never split into two text nodes on typing
    canInsertTextBefore(): boolean {
        return false;
    }

    canInsertTextAfter(): boolean {
        return false;
    }

    isTextEntity(): true {
        return true;
    }
}

export function $createSlashCommandNode(
    commandName: string,
    actionId = '',
    targetType?: ActionTargetType,
    title?: string,
    argumentHint?: string,
): SlashCommandNode {
    const node = new SlashCommandNode(commandName, actionId, targetType, title, argumentHint);
    // Atomic editing: delete removes the whole pill, typing inside replaces it.
    node.setMode('token');
    return $applyNodeReplacement(node);
}

export function $isSlashCommandNode(
    node: LexicalNode | null | undefined,
): node is SlashCommandNode {
    return node instanceof SlashCommandNode;
}
