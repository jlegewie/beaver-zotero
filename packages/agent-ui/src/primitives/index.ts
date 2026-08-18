// The shared UI primitives. Consumers usually import one by its own subpath
// (`@beaver/agent-ui/primitives/Button`), which is how the Zotero client imports
// them; this barrel exists so the whole set has a single root the closure check
// can start from, the same reason the icon barrel does. Without it, primitives
// that happen to be imported by a sibling (Button by IconButton, ContextMenu and
// Tooltip by MenuButton) would only be reachable by accident, and one of those
// sibling imports going away would read as an orphan rather than as a change.

export { default as Button } from './Button';
export type { ButtonVariant } from './Button';

export { default as IconButton } from './IconButton';

export { default as Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';

export { default as DocsLink } from './DocsLink';
export type { DocsLinkProps } from './DocsLink';

export { default as MenuButton } from './MenuButton';

export { default as ContextMenu } from './ContextMenu';
export type { ContextMenuProps, MenuItem, MenuPosition } from './ContextMenu';

export { default as SearchMenu } from './SearchMenu';
// `MenuPosition` is deliberately not re-exported here: SearchMenu declares its
// own, structurally identical to ContextMenu's, and the barrel can only carry
// one under that name. Import it from './SearchMenu' directly, which is how
// consumers take the rest of this component's types anyway.
export type { SearchMenuProps, SearchMenuItem, SearchMenuCloseReason } from './SearchMenu';

// The IME predicate SearchMenu and the composer both gate their key handling
// on. Not a component, but it belongs to the same layer: every shared surface
// that reads a key event has to yield to an active composition.
export { isImeKeyEvent } from './ime';

export {
    TagRoot,
    TagLabel,
    TagStartElement,
    TagEndElement,
    TagCloseTrigger,
} from './Tag';
export type {
    TagRootProps,
    TagLabelProps,
    TagStartElementProps,
    TagEndElementProps,
    TagCloseTriggerProps,
} from './Tag';
