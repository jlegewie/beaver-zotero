import type { PopupMessage } from '../types/popupMessage';
import type { VersionUpdateMessageConfig } from '../constants/versionUpdateMessages';
import { quickPromptShortcutLabel } from './quickPromptShortcut';

/**
 * Placeholders a release note's copy may use for what differs per machine.
 * Filled here, where the note is built, so the version list stays static text.
 */
const PLACEHOLDERS: Record<string, () => string> = {
    '{{quickPromptShortcut}}': quickPromptShortcutLabel,
};

function fillPlaceholders<T extends string | undefined>(text: T): T {
    if (!text) return text;
    let filled: string = text;
    for (const [token, value] of Object.entries(PLACEHOLDERS)) {
        if (filled.includes(token)) filled = filled.split(token).join(value());
    }
    return filled as T;
}

/** The popup message for a release note, the same whether it floats or sits in the panel. */
export function versionUpdatePopupMessage(config: VersionUpdateMessageConfig): Omit<PopupMessage, 'id'> {
    return {
        type: 'version_update',
        version: config.version,
        title: config.title,
        text: fillPlaceholders(config.text),
        featureList: config.featureList?.map((feature) => ({ ...feature, description: fillPlaceholders(feature.description) })),
        learnMoreUrl: config.learnMoreUrl,
        learnMoreLabel: config.learnMoreLabel,
        footer: config.footer,
        steps: config.steps?.map((step) => ({ ...step, description: fillPlaceholders(step.description) })),
        subtitle: fillPlaceholders(config.subtitle),
        showcase: config.showcase,
        expire: false,
    };
}
