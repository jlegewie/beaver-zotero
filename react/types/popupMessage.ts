export const POPUP_MESSAGE_DURATION = 2000; // 2 seconds

export type PopupMessageType = 'info' | 'warning' | 'error' | 'plan_change';

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
    count?: number;   // Count message occurrences
}
