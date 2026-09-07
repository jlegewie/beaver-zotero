/**
 * The one-time feature tips: what each says, how it looks, and where it goes.
 *
 * A tip is a registry entry here plus a trigger (see `useRunStatusTip`) that
 * asks `showFeatureTipAtom` for it at the right moment. Showing, pacing and
 * rendering are shared — see `react/atoms/featureTips.ts` and
 * `FeatureTipContent` — so a new tip is an entry, a trigger, and at most a
 * showcase of its own.
 */
import React from 'react';
import { BubbleChatQuestionIcon } from '../components/icons/icons';
import RunStatusTipShowcase, { RunStatusTipActions } from '../components/ui/popup/featureTips/RunStatusTipShowcase';

export type FeatureTipId = 'run-status-popup';

export interface FeatureTipActionsProps {
    /** Retires the tip. */
    dismiss: () => void;
}

export interface FeatureTipDefinition {
    id: FeatureTipId;
    /** One line, the feature's promise. Truncates, so keep it short. */
    title: string;
    /** One or two sentences under it. */
    text: string;
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    /**
     * Inside the sidebar, above the composer, like in-panel release notes;
     * otherwise the floating card in the main window's corner.
     */
    inPanel: boolean;
    /** A visual between the text and the buttons — a taste of the feature. */
    Showcase?: React.ComponentType;
    /** The button row. Defaults to a single "Got it". */
    Actions?: React.ComponentType<FeatureTipActionsProps>;
}

export const FEATURE_TIPS: Record<FeatureTipId, FeatureTipDefinition> = {
    'run-status-popup': {
        id: 'run-status-popup',
        title: 'Beaver keeps going when closed',
        text: 'Close the sidebar while Beaver works. A small card in the corner keeps you posted and lets you approve changes.',
        icon: BubbleChatQuestionIcon,
        inPanel: true,
        Showcase: RunStatusTipShowcase,
        Actions: RunStatusTipActions,
    },
};
