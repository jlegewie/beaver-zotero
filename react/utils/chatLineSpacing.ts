export const CHAT_LINE_SPACING_VALUES = [
    "compact",
    "default",
    "relaxed",
] as const;

export type ChatLineSpacing = (typeof CHAT_LINE_SPACING_VALUES)[number];

export const DEFAULT_CHAT_LINE_SPACING: ChatLineSpacing = "compact";

export function normalizeChatLineSpacing(value: unknown): ChatLineSpacing {
    return typeof value === "string" &&
        CHAT_LINE_SPACING_VALUES.includes(value as ChatLineSpacing)
        ? (value as ChatLineSpacing)
        : DEFAULT_CHAT_LINE_SPACING;
}
