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

export { default as MenuButton } from './MenuButton';

export { default as ContextMenu } from './ContextMenu';
export type { ContextMenuProps, MenuItem, MenuPosition } from './ContextMenu';

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
