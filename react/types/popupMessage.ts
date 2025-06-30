import { FileStatusStats } from "./fileStatus";

export const POPUP_MESSAGE_DURATION = 2000; // 2 seconds

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
    fileStats?: FileStatusStats;
    planName?: string;
    count?: number;   // Count message occurrences
    duration?: number; // Duration in milliseconds, defaults to POPUP_MESSAGE_DURATION
}
