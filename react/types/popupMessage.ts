export const POPUP_MESSAGE_DURATION = 4000; // 4 seconds

export type PopupMessageType = 'info' | 'warning' | 'error';

export interface PopupMessage {
    id: string;
    type: PopupMessageType;
    title?: string;
    text?: string;
    customContent?: React.ReactNode;
    icon?: React.ReactNode;
    expire?: boolean; // Defaults to true
}
