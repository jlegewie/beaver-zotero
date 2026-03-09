/**
 * Built-in actions — always shipped with the plugin.
 *
 * These are defined in code so they can be improved across updates without
 * being frozen by user edits. User overrides are stored separately in the
 * `beaver.actions` preference via ActionCustomizations.
 */

import { Action } from './actions';

// export const BUILTIN_ACTIONS: Action[] = [
//     {
//         id: 'builtin-fit-research',
//         title: 'How does this paper fit into my library?',

//         text: 'How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.{{active_item}}',
//         targetType: 'items',
//         sortOrder: 100,
//     },
//     {
//         id: 'builtin-discover-missing',
//         title: 'What recent research am I missing?',

//         text: 'Based on the topics of these recently added papers, search for external references that I might be missing. Focus on papers from the last two years that are relevant to my main research areas.{{recent_items}}',
//         targetType: 'items',
//         sortOrder: 200,
//     },
//     {
//         id: 'builtin-organize-collections',
//         title: 'Organize my recent additions',

//         text: 'Review the papers I added in the last two weeks. Check what collections I have, then help me file these items into the appropriate existing collections based on their topics.',
//         targetType: 'global',
//         sortOrder: 300,
//     },
//     {
//         id: 'builtin-review-metadata',
//         title: 'Review and fix metadata',

//         text: 'Check my 10 most recently added items for missing or incomplete metadata — especially DOIs for journal articles, publication info, and abstracts. Look up the correct information and help me fix any issues.',
//         targetType: 'global',
//         sortOrder: 400,
//     },
// ];

/**
 * Default built-in actions for Beaver.
 *
 * Design principles:
 * - Each action showcases a distinct Beaver capability (external search, library search,
 *   organization, metadata, annotation, synthesis).
 * - Prompts are specific and instruct the agent on format and output location.
 * - Titles are verb-first, sentence case, max 45 chars, no period.
 * - sortOrder groups by target type and ranks by expected frequency of use.
 *   items: 100–199, attachment: 200–299, note: 300–399, collection: 400–499, global: 500–599
 */

export const BUILTIN_ACTIONS: Action[] = [

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: items (single or multiple selected items)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-summarize',
        title: 'Summarize',
        text: 'Write a concise summary of this paper covering the research question, methodology, key findings, and main conclusions. Save the summary as a Zotero note attached to the item.',
        targetType: 'items',
        sortOrder: 100,
    },

    {
        id: 'builtin-fit-research',
        title: 'How does this fit into my library?',
        text: 'How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.',
        targetType: 'items',
        sortOrder: 110,
    },

    {
        id: 'builtin-find-similar',
        title: 'Find similar papers',
        text: 'Use external search to find papers that are closely related to this item. Focus on papers that use similar methods, study the same phenomenon, or are frequently co-cited with it. Return 10 results ranked by relevance with a one-sentence explanation of why each is relevant.',
        targetType: 'items',
        sortOrder: 120,
    },

    {
        id: 'builtin-find-citing',
        title: 'Find papers that cite this',
        text: 'Search for papers that cite this item. Prioritize recent papers (last 2 years) and highly-cited ones. Return up to 10 results with publication year and a one-sentence summary of how each paper uses or builds on this work.',
        targetType: 'items',
        sortOrder: 130,
    },

    {
        id: 'builtin-tag-items',
        title: 'Auto-tag',
        text: 'Analyze these items and suggest appropriate subject tags for each one. Use tags that already exist in my library when they fit. For new tags, keep them concise (1–3 words), lowercase, and consistent with my existing tagging style. Show me all proposed tags for approval before applying them.',
        targetType: 'items',
        sortOrder: 140,
    },

    {
        id: 'builtin-sort-into-collections',
        title: 'Sort into collections',
        text: 'Look at these items and suggest which of my existing collections each one belongs in. If an item doesn\'t fit any existing collection, say so and suggest a new collection name. Show me all proposed moves for approval before making changes.',
        targetType: 'items',
        minItems: 2,
        sortOrder: 150,
    },

    {
        id: 'builtin-fix-metadata',
        title: 'Check and fix metadata',
        text: 'Review the metadata for these items. Check for: missing DOIs, incomplete author names, missing abstracts, incorrect publication dates, missing journal/publisher info. For each issue found, propose a correction. Show all proposed changes for approval.',
        targetType: 'items',
        sortOrder: 160,
    },

    {
        id: 'builtin-compare-papers',
        title: 'Compare these papers',
        text: 'Compare these papers side by side. Create a structured comparison covering: research questions, methodology, key findings, limitations, and how they relate to each other. Present the comparison as a table where possible. Save as a Zotero note.',
        targetType: 'items',
        minItems: 2,
        sortOrder: 170,
    },

    {
        id: 'builtin-critique',
        title: 'Critique methodology',
        text: 'Provide a critical analysis of this paper\'s methodology. Assess the research design, sample/data selection, analytical approach, and validity of conclusions. Identify specific strengths and weaknesses. Note any potential confounders, biases, or limitations the authors may have underaddressed.',
        targetType: 'items',
        sortOrder: 180,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: attachment (PDF open in reader)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-key-findings',
        title: 'Extract key findings',
        text: 'Read this paper and extract the key findings as a numbered list. For each finding, include the page number where it appears. Focus on empirical results and novel contributions, not background or literature review. Save as a Zotero note attached to this item.',
        targetType: 'attachment',
        sortOrder: 200,
    },

    {
        id: 'builtin-explain-selection',
        title: 'Explain selected text',
        text: 'Explain the following passage from this paper in plain language. Provide context for any technical terms, statistical methods, or domain-specific concepts. If it references other work, briefly explain that context too.{{selected_text}}',
        targetType: 'attachment',
        sortOrder: 210,
    },

    {
        id: 'builtin-extract-references',
        title: 'Find key references from this paper',
        text: 'Identify the 5–8 most important references cited in this paper — the ones that are foundational to its argument or method. For each, explain why it matters to this paper and search my library to check if I already have it. For any I\'m missing, offer to search for them.',
        targetType: 'attachment',
        sortOrder: 220,
    },

    {
        id: 'builtin-annotate-methods',
        title: 'Annotate the methods section',
        text: 'Find the methods/methodology section of this paper. Create Zotero annotations that highlight and explain: the research design, data sources, sample details, key variables, analytical techniques, and any robustness checks. Each annotation should be a brief explanatory note.',
        targetType: 'attachment',
        sortOrder: 230,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: note (a Zotero note is selected)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-expand-note',
        title: 'Expand and improve this note',
        text: 'Review this note and expand it. Add more detail where the writing is thin, improve clarity, and fill in any gaps using information from the parent item and related papers in my library. Preserve my original points and voice. Show me a diff of changes.',
        targetType: 'note',
        sortOrder: 300,
    },

    {
        id: 'builtin-note-to-outline',
        title: 'Turn this note into a structured outline',
        text: 'Take this note and reorganize its contents into a structured outline suitable for a literature review or paper section. Group related points under thematic headings, add connections between ideas, and flag any gaps in the argument. Save as a new note.',
        targetType: 'note',
        sortOrder: 310,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: collection (a collection is selected in sidebar)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-collection-gaps',
        title: 'What am I missing in this collection?',
        text: 'Analyze the papers in this collection and identify gaps in coverage. What subtopics, methods, or perspectives are underrepresented? Search for specific papers that would fill those gaps and suggest up to 8 additions.',
        targetType: 'collection',
        sortOrder: 400,
    },

    {
        id: 'builtin-collection-review',
        title: 'Literature review outline',
        text: 'Create a literature review outline based on the papers in this collection. Organize the papers thematically (not chronologically), identify the key debates, areas of consensus, and open questions. For each section of the outline, list which papers from the collection belong there. Save as a Zotero note in this collection.',
        targetType: 'collection',
        sortOrder: 410,
    },

    {
        id: 'builtin-collection-summarize',
        title: 'Summarize this collection',
        text: 'Write a concise narrative summary of this collection: what topics it covers, the main findings across papers, where authors agree and disagree, and what methodological approaches are represented. Keep it under 500 words. Save as a Zotero note in this collection.',
        targetType: 'collection',
        sortOrder: 420,
    },

    {
        id: 'builtin-collection-tag-all',
        title: 'Tag all items in this collection',
        text: 'Analyze every item in this collection and suggest subject tags. Use my existing tags where they fit. Be consistent across items — papers on similar subtopics should share tags. Show me all proposed tags grouped by item for approval before applying.',
        targetType: 'collection',
        sortOrder: 430,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: global (no specific context, library-wide)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-organize-recent',
        title: 'Organize my recent additions',
        text: 'Look at items I\'ve added in the last 7 days. For each one, suggest appropriate tags and which collection it belongs in. If no existing collection fits, suggest creating a new one. Show all proposed changes for approval.{{recent_items}}',
        targetType: 'global',
        sortOrder: 500,
    },

    {
        id: 'builtin-whats-new',
        title: 'What\'s new in my research areas?',
        text: 'Based on my library, identify my main research areas. Search for notable recent papers (last 3 months) in each area. Return up to 5 papers per area, prioritizing highly-cited and highly-relevant results. Indicate which ones I already have.{{library_topics}}',
        targetType: 'global',
        sortOrder: 510,
    },

    {
        id: 'builtin-library-health',
        title: 'Library health check',
        text: 'Audit my library and report on: number of items with missing metadata (DOI, abstract, authors), potential duplicates, items without tags, items not in any collection, and any other organizational issues. For each category, tell me the count and offer to fix them.{{library_stats}}',
        targetType: 'global',
        sortOrder: 520,
    },

    {
        id: 'builtin-find-duplicates',
        title: 'Find and merge duplicates',
        text: 'Search my library for duplicate entries. Check for matching DOIs, very similar titles, and same-author/same-year matches. For each set of duplicates, show me both entries and recommend which to keep (prefer the one with more complete metadata). Show all proposed merges for approval.{{library_stats}}',
        targetType: 'global',
        sortOrder: 530,
    },

    {
        id: 'builtin-tag-untagged',
        title: 'Tag all untagged items',
        text: 'Find all items in my library that have no tags. Analyze each one and suggest appropriate subject tags. Use existing tags from my library when they fit. Be consistent — similar papers should get similar tags. Process in batches of 10 and show each batch for approval.{{untagged_items}}',
        targetType: 'global',
        sortOrder: 540,
    },

];