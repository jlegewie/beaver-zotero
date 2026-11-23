import React, { useLayoutEffect, useState } from 'react';

/** Where a showcase's pointer is drawn, relative to its stage. */
export interface PointerPosition {
    x: number;
    y: number;
}

/**
 * Moves a showcase's pointer to `target`, measured from the drawn elements
 * (`data-pointer-target`) so it lands on them however wide the slot is.
 * `'rest'` is a resting spot left of center. A target that is gone (a menu
 * closed under it) leaves the pointer where it was. `frame` re-measures on
 * every beat, since the elements under the pointer move with the story.
 */
export function usePointerPosition(
    stageRef: React.RefObject<HTMLElement>,
    target: string,
    frame: unknown,
): PointerPosition | null {
    const [position, setPosition] = useState<PointerPosition | null>(null);
    useLayoutEffect(() => {
        const stage = stageRef.current;
        if (!stage) return;
        const stageRect = stage.getBoundingClientRect();
        if (target === 'rest') {
            setPosition({ x: stageRect.width * 0.45, y: stageRect.height * 0.3 });
            return;
        }
        const element = stage.querySelector<HTMLElement>(`[data-pointer-target="${target}"]`);
        if (!element) return;
        const rect = element.getBoundingClientRect();
        // Off-center, the way a hand lands on a control.
        setPosition({
            x: rect.left - stageRect.left + Math.min(rect.width * 0.5, 40),
            y: rect.top - stageRect.top + rect.height * 0.45,
        });
    }, [stageRef, target, frame]);
    return position;
}

const ArrowGlyph: React.FC = () => (
    <svg width="14" height="20" viewBox="0 0 14 20">
        <path
            d="M1 1 L1 16 L4.6 12.6 L7.2 18.6 L9.6 17.6 L7 11.6 L12 11.6 Z"
            fill="#fff"
            stroke="#000"
            strokeWidth="1.1"
            strokeLinejoin="round"
        />
    </svg>
);

const TEXT_GLYPH_PATH = 'M2 1.5 H4 Q5 1.5 5 3 V15 Q5 16.5 4 16.5 H2 M8 1.5 H6 Q5 1.5 5 3 M5 15 Q5 16.5 6 16.5 H8';

const TextGlyph: React.FC = () => (
    <svg width="10" height="18" viewBox="0 0 10 18">
        <path d={TEXT_GLYPH_PATH} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
        <path d={TEXT_GLYPH_PATH} fill="none" stroke="#000" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
);

/**
 * A showcase's mouse pointer: an arrow, or an I-beam over text, gliding to
 * `position` and shrinking a little while pressed. Drawn over the stage,
 * which must be positioned.
 */
export const ShowcasePointer: React.FC<{
    position: PointerPosition | null;
    hidden?: boolean;
    pressed?: boolean;
    text?: boolean;
}> = ({ position, hidden, pressed, text }) => {
    if (!position) return null;
    return (
        <div
            className={`beaver-showcase__pointer ${hidden ? 'beaver-showcase__pointer--hidden' : ''}`}
            style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
        >
            <div
                className={`beaver-showcase__pointer-glyph ${text ? 'beaver-showcase__pointer-glyph--text' : ''} ${pressed ? 'beaver-showcase__pointer-glyph--pressed' : ''}`}
            >
                {text ? <TextGlyph /> : <ArrowGlyph />}
            </div>
        </div>
    );
};
