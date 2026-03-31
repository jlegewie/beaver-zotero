/**
 * Built-in actions — always shipped with the plugin.
 *
 * These are defined in code so they can be improved across updates without
 * being frozen by user edits. User overrides are stored separately in the
 * `beaver.actions` preference via ActionCustomizations.
 */

import { Action } from './actions';



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
        text: 'Use external search to find papers that are closely related to this item. Focus on papers that use similar methods or study the same phenomenon. Return 10 results ranked by relevance with a one-sentence explanation of why each is relevant.',
        targetType: 'items',
        sortOrder: 120,
    },

    // {
    //     id: 'builtin-find-citing',
    //     title: 'Find papers that cite this',
    //     text: 'Search for papers that cite this item. Prioritize recent papers (last 2 years) and highly-cited ones. Return up to 10 results with publication year and a one-sentence summary of how each paper uses or builds on this work.',
    //     targetType: 'items',
    //     sortOrder: 130,
    // },

    {
        id: 'builtin-tag-items',
        title: 'Auto-tag',
        text: 'Analyze these items and assign appropriate tags to them. Use tags that already exist in my library when they fit. For new tags, keep them concise (1-3 words), lowercase, and consistent with my existing tagging style.',
        targetType: 'items',
        sortOrder: 140,
    },

    {
        id: 'builtin-sort-into-collections',
        title: 'Sort into collections',
        text: 'Look at these items and add them to my existing collections if they fit. If an item doesn\'t fit any existing collection, say so and suggest a new collection name.',
        targetType: 'items',
        sortOrder: 150,
    },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: attachment (PDF open in reader)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-skim-paper',
        title: 'Skim this paper',
        text: 'Skim this document and create a structured skim note so I can quickly decide what to read closely. Start with a 2–3 sentence overview stating what the document is about, its central argument or contribution, and the main conclusion. Then provide a section-by-section walkthrough: for each major section or chapter, write one sentence summarizing its key point with a page citation (e.g., p. 12). Finish with 3–5 key takeaways. Save as a Zotero note attached to the parent item.',
        targetType: 'attachment',
        sortOrder: 200,
    },

    {
        id: 'builtin-key-findings',
        title: 'Extract key findings',
        text: 'Read this paper and extract the key findings as a numbered list. For each finding, include a citation with page number where it appears. Focus on empirical results and novel contributions, not background or literature review. Save as a Zotero note attached to the parent item.',
        targetType: 'attachment',
        sortOrder: 210,
    },

    {
        id: 'builtin-attachment-fit-research',
        title: 'How does this fit into my library?',
        text: 'How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.',
        targetType: 'attachment',
        sortOrder: 220,
    },

    // {
    //     id: 'builtin-explain-selection',
    //     title: 'Explain selected text',
    //     text: 'Explain the following passage from this paper in plain language. Provide context for any technical terms, statistical methods, or domain-specific concepts. If it references other work, briefly explain that context too.{{selected_text}}',
    //     targetType: 'attachment',
    //     sortOrder: 220,
    // },

    {
        id: 'builtin-extract-references',
        title: 'Find key references from this paper',
        text: 'Identify the 3-4 most important references cited in this paper. Focus on the ones that are foundational to its argument or method. For each, explain why it matters to this paper and search my library to check if I already have it. For any I am missing, search for them outside of my library and cite them as external references.',
        targetType: 'attachment',
        sortOrder: 230,
    },

    // {
    //     id: 'builtin-annotate-methods',
    //     title: 'Annotate the methods section',
    //     text: 'Find the methods/methodology section of this paper. Create Zotero annotations that highlight and explain: the research design, data sources, sample details, key variables, analytical techniques, and any robustness checks. Each annotation should be a brief explanatory note.',
    //     targetType: 'attachment',
    //     sortOrder: 230,
    // },

    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: note (a Zotero note is selected)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-expand-note',
        title: 'Expand and improve this note',
        text: 'Review this note and expand it. Add more detail where the writing is thin, improve clarity, and fill in any gaps using information from the parent item and related papers in my library. Preserve my original points and voice.',
        targetType: 'note',
        sortOrder: 300,
    },

    {
        id: 'builtin-note-check-citations',
        title: 'Review and strengthen citations',
        text: 'Review this note and check every claim and citation. For unsupported claims, search my library for papers that could back them up and add citations. For existing citations, verify they actually support the point being made. Flag any claims you cannot find support for in my library. Update the note with improved citations.',
        targetType: 'note',
        sortOrder: 320,
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
        text: 'Analyze the papers in this collection and identify gaps in coverage. What subtopics, methods, or perspectives are underrepresented? Use external search for papers in these areas to fill the gaps and suggest up to 8 additions with a short explanation of why each is relevant. Always cite the most relevant papers as external references.',
        targetType: 'collection',
        sortOrder: 400,
    },

    // {
    //     id: 'builtin-collection-review',
    //     title: 'Literature review outline',
    //     text: 'Create a literature review outline based on the papers in this collection. Organize the papers thematically (not chronologically), identify the key debates, areas of consensus, and open questions. Avoid bullet points and numbered lists. For each section of the outline, cite relevant papers from the collection that belong there. Use a note for the literature review outline.',
    //     // Save as a Zotero note in this collection.
    //     targetType: 'collection',
    //     sortOrder: 410,
    // },

    {
        id: 'builtin-collection-summarize',
        title: 'Summarize this collection',
        text: 'Write a concise narrative summary of this collection: what topics it covers, the main findings across papers, where authors agree and disagree, and what methodological approaches are represented. Keep it under 500 words. Avoid bullet points and numbered lists. Use a note for the summary and assign it to this collection. Cite all relevant papers in the note.',
        // Save as a Zotero note in this collection.
        targetType: 'collection',
        sortOrder: 420,
    },

    
    {
        id: 'builtin-collection-organize-sub-collections',
        title: 'Organize into thematic sub-collections',
        text: 'Organize every item in this collection into thematic sub-collections. Make sure to check for existing sub-collections first. Only create new sub-collections if necessary.',
        targetType: 'collection',
        sortOrder: 430,
    },

    {
        id: 'builtin-collection-tag-all',
        title: 'Tag all items in this collection',
        text: 'Analyze every item in this collection and assign appropriate tags to each item. Use my existing tags where they fit. Be consistent across items. Papers on similar subtopics should share tags.',
        targetType: 'collection',
        sortOrder: 440,
    },
    
    // ═══════════════════════════════════════════════════════════════════
    // TARGET TYPE: global (no specific context, library-wide)
    // ═══════════════════════════════════════════════════════════════════

    {
        id: 'builtin-organize-recent',
        title: 'Organize my recent additions',
        text: 'Look at items I\'ve added in the last 7 days. For each one, assign appropriate tags and add them to the appropriate collection. If no existing collection fits, suggest creating a new one.{{recent_items}}',
        targetType: 'global',
        sortOrder: 500,
    },

    {
        id: 'builtin-whats-new',
        title: 'What\'s new in my research areas?',
        text: 'Look at my recent additions to identify what I\'m currently working on. Search for notable recent papers in these areas, prioritizing highly-cited and relevant results. Return up to 10 papers. Indicate which ones I already have.{{recent_items}}',
        targetType: 'global',
        sortOrder: 510,
    },

    // {
    //     id: 'builtin-library-health',
    //     title: 'Library health check',
    //     text: 'Audit my library and report on: number of items with missing metadata (DOI, abstract, authors), items without tags, items not in any collection, and any other organizational issues. For each category, tell me the count and offer to fix them.',
    //     // {{library_stats}}
    //     targetType: 'global',
    //     sortOrder: 520,
    // },

    {
        id: 'builtin-fix-metadata-recent',
        title: 'Fix metadata for my recent additions',
        text: 'Look at items I\'ve added in the last 7 days. For each one, fix missing or incomplete metadata (DOI, title, abstract, authors).{{recent_items}}',
        targetType: 'global',
        sortOrder: 530,
    },

    {
        id: 'builtin-tag-untagged',
        title: 'Tag all untagged items',
        text: 'Find all items in my library that have no tags. Analyze each one and assign appropriate subject tags. Use existing tags from my library when they fit. Be consistent: similar papers should get similar tags.',
        // {{untagged_items}}
        targetType: 'global',
        sortOrder: 550,
    },

];