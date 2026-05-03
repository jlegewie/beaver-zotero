import React from 'react';

/**
 * Renders a string with a trailing inline node (e.g. an arrow icon) glued to
 * the last word so the trailing node never wraps onto its own line. The text
 * before the last word wraps normally.
 */
export const textWithTrailingNoWrap = (
    text: string,
    trailing: React.ReactNode,
): React.ReactNode => {
    const trimmed = text.trimEnd();
    const lastSpaceIndex = trimmed.search(/\s+\S+$/);

    if (lastSpaceIndex === -1) {
        return (
            <span className="whitespace-nowrap">
                {trimmed}
                {trailing}
            </span>
        );
    }

    return (
        <>
            {trimmed.slice(0, lastSpaceIndex)}
            <span className="whitespace-nowrap">
                {trimmed.slice(lastSpaceIndex)}
                {trailing}
            </span>
        </>
    );
};
