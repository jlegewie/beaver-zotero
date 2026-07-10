/**
 * Archived built-in actions — deprecated tombstones for actions that SHIPPED
 * in a released build and were later removed from the default set.
 */

import { Action } from './actions';

export const ARCHIVED_ACTIONS: Action[] = [

    // ── Removed after v0.21.2 ───────────────────────────────────────────

    // Overlapped with skim/color-code.
    {
        id: 'builtin-key-findings',
        name: 'key-findings',
        title: 'Highlight key findings',
        text: 'Read this paper and identify the key findings. For each one, create a highlight annotation with 1-3 specific sentences that states the finding, with a brief comment explaining its significance. Focus on empirical results and novel contributions, not background or literature review. Aim for 3-6 highlights covering the most important findings. After completing the highlights, provide a short summary with citations to the new annotations.',
        targets: ['attachment'],
        sortOrder: 210,
        deprecated: true,
    },

    // Superseded by builtin-fit-research, which now accepts attachments too.
    {
        id: 'builtin-attachment-fit-research',
        name: 'fit-into-library-pdf',
        title: 'How does this fit into my library?',
        text: 'How does this paper connect to the rest of my library? Does it support, challenge, or extend ideas in papers I already have? Write a short report that directly compares the paper to other research in my library including a comparison table. Use a Zotero note attached to the item.',
        targets: ['attachment'],
        sortOrder: 220,
        deprecated: true,
    },

    // Verifying a note's claims against library sources is a distinctive
    // workflow and a strong candidate to return once note editing is robust
    // across the full range of real-world notes.
    {
        id: 'builtin-note-check-citations',
        name: 'check-citations',
        title: 'Check and strengthen citations',
        text: 'Check every claim and citation in this note against my library, then strengthen the citations.\n\nSteps:\n1. Read the note and list its substantive claims.\n2. Verify each existing citation against its source. The extract tool (if available) is ideal for this — ask it whether the source supports the specific claim; otherwise read the cited passages.\n3. For claims with no citation, search my library for supporting work and confirm the support (with the extract tool or a targeted read) before citing anything.\n4. Update the note: add the new citations and fix miscitations. Do not rewrite my prose beyond what the citation changes require, and do not delete claims.\n\nFinish with a report: claims verified, citations added, citations corrected, and — most importantly — claims for which you found no support in my library, so I know what currently rests on my own authority.',
        targets: ['note'],
        sortOrder: 320,
        deprecated: true,
    },

    // Generic writing aids that do not showcase anything library-specific.
    {
        id: 'builtin-review-note',
        name: 'review-note',
        title: 'Review and give feedback on this note',
        text: 'Review this note and give me feedback — do not rewrite it.\n\nAssess the note as a piece of thinking: identify where arguments are unclear or underdeveloped, claims that lack supporting evidence or citations, logical gaps or inconsistencies, and places where more detail would strengthen it.\n\nFormat the feedback so I can act on it:\n1. A 2-3 sentence overall assessment: what the note does well and its biggest weakness.\n2. Specific comments, each quoting the passage in question and explaining the problem and a concrete way to fix it. Group them: unclear arguments, unsupported claims, gaps and inconsistencies.\n3. Close with the 2-3 revisions that would improve the note most.\n\nIf the note is a short fragment or a collection of clippings rather than developed prose, skip the detailed critique and instead suggest how to develop it. Do not edit the note itself.',
        argumentHint: 'Optional: what kind of feedback you want',
        targets: ['note'],
        sortOrder: 300,
        deprecated: true,
    },

    {
        id: 'builtin-edit-note',
        name: 'edit-note',
        title: 'Edit this note for clarity and structure',
        text: 'Edit this note to improve clarity, structure, and flow — without changing what it says.\n\nSteps:\n1. Read the whole note first.\n2. Edit it: tighten the prose, fix awkward phrasing and grammar, and improve the logical order of ideas. Preserve my arguments, conclusions, terminology, and voice — do not add new claims or delete substance. Keep every citation attached to the claim it supports.\n3. If the note is mostly fragments or bullets, improve the grouping and ordering, but do not inflate fragments into padded prose.\n\nWhen done, summarize what you changed in a few bullets and list any spots where the evidence seemed thin or a citation is needed — leave those passages for me to fix.',
        argumentHint: 'Optional: editing focus, e.g. tighten, restructure, or fix flow',
        targets: ['note'],
        sortOrder: 310,
        deprecated: true,
    },

    // Overlapped with stronger built-ins: literature-review covers collection
    // synthesis; auto-tag covers tagging; tidy-up covers recurring maintenance.
    {
        id: 'builtin-collection-summarize',
        name: 'summarize-collection',
        title: 'Summarize this collection',
        text: 'Write a concise narrative summary of this collection so I can recall at a glance what it contains and what it says.\n\nCover: the topics the collection spans, the main findings across papers, where the authors agree and disagree, and the methodological approaches represented. Cite the specific papers behind every substantive statement — the citations are what make the summary navigable.\n\nFormat: under 500 words of flowing prose with no bullet points or numbered lists, organized around themes rather than individual papers. Save it as a Zotero note in this collection.\n\nFor large collections, work from metadata and abstracts and read closely only the papers that anchor the main themes.',
        targets: ['collection'],
        sortOrder: 420,
        deprecated: true,
    },

    {
        id: 'builtin-collection-tag-all',
        name: 'tag-collection',
        title: 'Tag all items in this collection',
        text: 'Tag every item in this collection with a consistent vocabulary.\n\nSteps:\n1. Review my existing tags and the collection\'s contents, then settle on the small set of tags this collection needs — reuse my existing tags wherever they fit.\n2. Tag every item: 2-5 subject tags each, applied consistently, so items on the same subtopic share the same tags. Create a new tag only when nothing existing fits, and keep new tags lowercase and 1-3 words.\n\nWhen done, report the tag vocabulary you used (marking newly created tags) and a table of items with their assigned tags.',
        targets: ['collection'],
        sortOrder: 440,
        deprecated: true,
    },

    // Superseded by builtin-tidy-up.
    {
        id: 'builtin-organize-recent',
        name: 'organize-recent',
        title: 'Organize my recent additions',
        text: 'Look at items I\'ve added in the last 7 days. For each one, assign appropriate tags and add them to the appropriate collection. If no existing collection fits, suggest creating a new one.{{recent_items}}',
        targets: ['global'],
        sortOrder: 500,
        deprecated: true,
    },

    {
        id: 'builtin-fix-metadata-recent',
        name: 'fix-metadata',
        title: 'Fix metadata for my recent additions',
        text: 'Look at items I\'ve added in the last 7 days. For each one, fix missing or incomplete metadata (DOI, title, abstract, authors).{{recent_items}}',
        targets: ['global'],
        sortOrder: 530,
        deprecated: true,
    },

    // Duplicate of auto-tag applied to a fixed scope.
    {
        id: 'builtin-tag-untagged',
        name: 'tag-untagged',
        title: 'Tag all untagged items',
        text: 'Find the items in my library that have no tags and tag them.\n\nSteps:\n1. Search my library for untagged items and count them. If there are more than about 25, tell me how many there are and ask whether to do all of them now or start with the most recent ones.\n2. Review my existing tags and reuse them wherever they fit.\n3. Tag each item with 2-5 subject tags, applied consistently so similar items share the same tags. Create a new tag (lowercase, 1-3 words) only when nothing existing fits.\n\nWhen done, show a table of items and their assigned tags, marking newly created tags.',
        targets: ['global'],
        sortOrder: 550,
        deprecated: true,
    },

];
