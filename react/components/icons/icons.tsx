// The Zotero client's icon barrel: the shared icon set merged with the icons
// that only exist in a Zotero window. The icon components themselves live in
// @beaver/agent-ui; this file stays because merging the two sets is a client
// concern, and because ~100 files across the plugin import their icons from
// here.
export * from '@beaver/agent-ui/icons';

// Zotero's own CSS icons: `<span class="icon icon-css icon-...">` elements
// styled by Zotero's stylesheets, which no other client has.
export { CSSItemTypeIcon, CSSIcon } from './zotero';

// Status icons for the database-sync surface, which is Zotero-only.
export { default as DatabaseStatusIcon } from './DatabaseStatusIcon';
export { default as CircleStatusIcon } from './CircleStatusIcon';
