import { FileStatusSummary } from "./fileStatus";
import { FeatureStep } from "../constants/versionUpdateMessages";

export const POPUP_MESSAGE_DURATION = 4000; // 4 seconds

export type PopupMessageType = 'info' | 'warning' | 'error' | 'plan_change' | 'indexing_complete' | 'version_update' | 'items_summary' | 'embedding_indexing';

export interface PopupMessageFeature {
    title: string;
    description?: string;
}

export interface PopupMessage {
    id: string;
    cancelable?: boolean; // Defaults to true
    type: PopupMessageType;
    title?: string;
    text?: string;
    customContent?: React.ReactNode;
    icon?: React.ReactNode;
    expire?: boolean; // Defaults to true
    buttonIcon?: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    buttonOnClick?: () => void
    fileStatusSummary?: FileStatusSummary;
    planName?: string;
    showProgress?: boolean;
    progress?: number; // 0-100 for progress bar
    count?: number;   // Count message occurrences
    duration?: number; // Duration in milliseconds, defaults to POPUP_MESSAGE_DURATION
    showGoToFileStatusButton?: boolean;
    showSettingsButton?: boolean;
    /** @deprecated Use steps for new version messages */
    featureList?: PopupMessageFeature[];
    learnMoreUrl?: string;
    learnMoreLabel?: string;
    footer?: string;
    /** Feature steps for guided tour (new format for version updates) */
    steps?: FeatureStep[];
    /** Subtitle shown below the title in step-based tours */
    subtitle?: string;
}
