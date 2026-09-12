import {
    DEFAULT_CHAT_LINE_SPACING,
    normalizeChatLineSpacing,
} from "../../../react/utils/chatLineSpacing";

describe("normalizeChatLineSpacing", () => {
    it.each(["compact", "default", "relaxed"] as const)(
        "accepts the %s preset",
        (value) => {
            expect(normalizeChatLineSpacing(value)).toBe(value);
        },
    );

    it.each([undefined, null, "", "wide", 1.7])(
        "falls back for invalid stored value %s",
        (value) => {
            expect(normalizeChatLineSpacing(value)).toBe(
                DEFAULT_CHAT_LINE_SPACING,
            );
        },
    );
});
