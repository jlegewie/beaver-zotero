import type React from 'react';
import type { ChipPopupContent } from './ChipPopup';
import type { ActionCategory } from '../../../types/actions';
import { ZapIcon, BookSearchIcon, LayersIcon, HighlighterIcon, QuillWriteIcon } from '../../icons/icons';
import { truncateText } from '../../../utils/stringUtils';

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

/** Category icons, mirroring the homepage launcher (Zap = uncategorized). */
const CATEGORY_ICONS: Record<ActionCategory, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
    research: BookSearchIcon,
    write: QuillWriteIcon,
    organize: LayersIcon,
    annotate: HighlighterIcon,
};

/** Same cap as chip labels (MAX_CHIP_TEXT_LENGTH in RequestChipPrimitives). */
const MAX_ACTION_TITLE_LENGTH = 30;
/** Max length of the prompt preview in the action popup. */
const MAX_PROMPT_PREVIEW_LENGTH = 120;

export interface ActionPopupSource {
    /** Action title; falls back to the /command token when unset. */
    title?: string | null;
    /** Slash token (without the leading '/'), used as the title fallback. */
    command?: string | null;
    /** Action prompt text (resolved or raw template); null/absent when the action definition no longer exists. */
    prompt?: string | null;
    /** Skill category, drives the footer icon. */
    category?: ActionCategory;
}

export function buildActionPopup(source: ActionPopupSource): ChipPopupContent {
    const title = source.title || (source.command ? `/${source.command}` : 'Action');
    const promptPreview = source.prompt
        ? truncateText(source.prompt.replace(/\s+/g, ' ').trim(), MAX_PROMPT_PREVIEW_LENGTH)
        : '';
    return {
        title: truncateText(title, MAX_ACTION_TITLE_LENGTH),
        subtitle: promptPreview ? { text: promptPreview } : null,
        action: {
            icon: (source.category && CATEGORY_ICONS[source.category]) || ZapIcon,
            label: 'Click to edit in preferences',
        },
    };
}
