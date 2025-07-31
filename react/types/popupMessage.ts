import { FileStatusSummary } from "./fileStatus";

export const POPUP_MESSAGE_DURATION = 4000; // 4 seconds

export type PopupMessageType = 'info' | 'warning' | 'error' | 'plan_change' | 'indexing_complete';

export interface PopupMessage {
    id: string;
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
    count?: number;   // Count message occurrences
    duration?: number; // Duration in milliseconds, defaults to POPUP_MESSAGE_DURATION
    showGoToFileStatusButton?: boolean;
}
