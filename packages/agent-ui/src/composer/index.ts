// The shared message composer. Like the icon, primitive, chat and auth barrels,
// this exists so the family has a single root the closure check can start from:
// consumers import a module by its own subpath
// (`@beaver/agent-ui/composer/LexicalEditorInput`), and the members that are only
// reached by a sibling — the pill component, the editor's plugins, the caret and
// IME helpers — would otherwise be reachable by accident rather than on purpose.
//
// Three of these are roots in the real sense, imported by a client and by
// nothing inside the package: the editor itself, the mention node (a client
// builds its own mention descriptors and inserts them through its own typeahead
// plugin), and the Add Sources menu hook.

export { LexicalEditorInput } from './LexicalEditorInput';
export type {
    LexicalEditorInputHandle,
    LexicalEditorInputProps,
    ComposerPasteHandlers,
} from './LexicalEditorInput';

export { MentionNode, $createMentionNode, $isMentionNode } from './MentionNode';
export type {
    MentionDescriptor,
    SerializedMentionNode,
    SerializedMentionNodeV2,
    SerializedLegacyMentionNode,
} from './MentionNode';

export { MentionPill } from './MentionPill';

export { SlashCommandNode, $createSlashCommandNode, $isSlashCommandNode } from './SlashCommandNode';
export type { SerializedSlashCommandNode } from './SlashCommandNode';

export { SlashCommandsPlugin } from './SlashCommandsPlugin';
export { SlashCommandHoverCardPlugin } from './SlashCommandHoverCardPlugin';
export type { SlashCommandHoverCardPluginProps } from './SlashCommandHoverCardPlugin';

export { useAddSourcesMenu, matchSourcesTrigger, queryForOpenTrigger } from './useAddSourcesMenu';
export type {
    AddSourcesMenuHandle,
    AddSourcesQuerySource,
    OpenTrigger,
} from './useAddSourcesMenu';

export {
    toSlashToken,
    getActionCommand,
    splitContentByCommandTokens,
    splitContentBySlashTokens,
    slashDescriptorsEqual,
    hasSlashToken,
    ensurePromptActionTokens,
    promptActionsToDescriptors,
    filterPromptActionsForContent,
} from './slashCommands';
export type {
    SlashCommandDescriptor,
    CommandTokenSegment,
    SlashContentSegment,
} from './slashCommands';
