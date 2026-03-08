/**
 * Built-in actions — always shipped with the plugin.
 *
 * These are defined in code so they can be improved across updates without
 * being frozen by user edits. User overrides are stored separately in the
 * `beaver.actions` preference via ActionCustomizations.
 */

import { Action } from './actions';

export const BUILTIN_ACTIONS: Action[] = [
    {
        id: 'builtin-fit-research',
        title: 'How does this paper fit into my library?',

        text: 'How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.{{active_item}}',
        targetType: 'items',
        sortOrder: 100,
    },
    {
        id: 'builtin-discover-missing',
        title: 'What recent research am I missing?',

        text: 'Based on the topics of these recently added papers, search for external references that I might be missing. Focus on papers from the last two years that are relevant to my main research areas.{{recent_items}}',
        targetType: 'items',
        sortOrder: 200,
    },
    {
        id: 'builtin-organize-collections',
        title: 'Organize my recent additions',

        text: 'Review the papers I added in the last two weeks. Check what collections I have, then help me file these items into the appropriate existing collections based on their topics.',
        targetType: 'global',
        sortOrder: 300,
    },
    {
        id: 'builtin-review-metadata',
        title: 'Review and fix metadata',

        text: 'Check my 10 most recently added items for missing or incomplete metadata — especially DOIs for journal articles, publication info, and abstracts. Look up the correct information and help me fix any issues.',
        targetType: 'global',
        sortOrder: 400,
    },
];
