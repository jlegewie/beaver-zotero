/**
 * The visuals a release note can carry: what each `showcase` id in
 * `versionUpdateMessages.ts` draws.
 *
 * Kept apart from the version list because the plugin bundle reads that list
 * at startup to queue the notifications, and must not pull React in with it.
 */
import type React from 'react';
import type { VersionShowcaseId } from './versionUpdateMessages';
import QuickPromptShowcase from '../components/ui/popup/showcases/QuickPromptShowcase';

export const VERSION_SHOWCASES: Record<VersionShowcaseId, React.ComponentType> = {
    'quick-prompt': QuickPromptShowcase,
};

export function getVersionShowcase(id: VersionShowcaseId | undefined): React.ComponentType | undefined {
    return id ? VERSION_SHOWCASES[id] : undefined;
}
