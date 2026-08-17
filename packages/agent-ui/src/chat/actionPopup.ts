import type React from 'react';
import type { ChipPopupContent } from './ChipPopup';
import type { ActionCategory, KnownActionCategory } from '@beaver/agent-core/types/actions';
import { ZapIcon, BookSearchIcon, LayersIcon, HighlighterIcon, QuillWriteIcon } from '../icons';
import { truncateText } from '../utils/stringUtils';

/**
 * Hover-card content for /command action pills — both the live pill in the
 * chat input and the read-only pills rendered in chat history.
 *
 * Built entirely from self-contained action data (title, prompt text,
 * category): the input side supplies the live action definition, while
 * history rendering supplies the send-time `PromptAction`, which persists
 * everything the card needs. No host access, so rendering stays
 * client-agnostic.
 */

/** Category icons matching the homepage launcher. Zap for missing/unknown categories. */
const CATEGORY_ICON_ENTRIES = {
    research: BookSearchIcon,
    write: QuillWriteIcon,
    organize: LayersIcon,
    annotate: HighlighterIcon,
} satisfies Record<KnownActionCategory, React.ComponentType<React.SVGProps<SVGSVGElement>>>;

/** Map so Object.prototype names (`constructor`, …) don't inherit a function. */
const CATEGORY_ICONS = new Map<string, React.ComponentType<React.SVGProps<SVGSVGElement>>>(Object.entries(CATEGORY_ICON_ENTRIES));

/** Same cap as chip labels (MAX_CHIP_TEXT_LENGTH in RequestChipPrimitives). */
const MAX_ACTION_TITLE_LENGTH = 30;
/** Max length of the description / prompt preview in the action popup. */
const MAX_PROMPT_PREVIEW_LENGTH = 120;

export interface ActionPopupSource {
    /** Action title; falls back to the /command token when unset. */
    title?: string | null;
    /** Slash token (without the leading '/'), used as the title fallback. */
    command?: string | null;
    /** Short human-facing description; preferred over the prompt for the subtitle. */
    description?: string | null;
    /** Action prompt text (resolved or raw template); null/absent when the action definition no longer exists. */
    prompt?: string | null;
    /** Skill category, drives the footer icon. */
    category?: ActionCategory;
    /** Footer icon. Pass this when the client has a glyph this package doesn't know. */
    icon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
}

export function buildActionPopup(source: ActionPopupSource): ChipPopupContent {
    const title = source.title || (source.command ? `/${source.command}` : 'Action');
    // Prefer the user-authored description; fall back to a preview of the prompt.
    const subtitleSource = source.description?.trim() || source.prompt || '';
    const subtitleText = subtitleSource
        ? truncateText(subtitleSource.replace(/\s+/g, ' ').trim(), MAX_PROMPT_PREVIEW_LENGTH)
        : '';
    return {
        title: truncateText(title, MAX_ACTION_TITLE_LENGTH),
        subtitle: subtitleText ? { text: subtitleText } : null,
        action: {
            icon:
                source.icon ??
                ((source.category && CATEGORY_ICONS.get(source.category)) || ZapIcon),
            label: 'Click to edit in preferences',
        },
    };
}
