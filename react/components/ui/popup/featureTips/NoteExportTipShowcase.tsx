import React, { useLayoutEffect, useRef, useState } from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import {
    ArrowRightIcon,
    ArrowUpRightIcon,
    CheckmarkCircleIcon,
    CopyIcon,
    DownloadIcon,
    Icon,
    MoreHorizontalIcon,
    RepeatIcon,
    Spinner,
} from '../../../icons/icons';
import { FILE_EXPORT_FORMATS } from '../../../../utils/fileExportFeedback';
import { useShowcaseTimeline, type ShowcaseBeat } from '../showcases/useShowcaseTimeline';

/** The note the showcase exports, and how it reads in Word. */
const NOTE_TITLE = 'Key findings';
const FILE_NAME = 'Key findings.docx';
const SENTENCE_BEFORE = 'Neighborhood disadvantage persists across generations';
const SENTENCE_AFTER = '.';
const WORD_CITATION = '(Sampson 2012, 31)';

/** Where the pointer is headed: a marked element, or a resting spot. */
type PointerTarget = 'rest' | 'export' | 'word' | 'citation';

interface Frame {
    /** The note card in the chat, or the exported document in Word. */
    scene: 'note' | 'document';
    pointer: PointerTarget;
    /** The pointer is out of the picture (between loops). */
    pointerHidden?: boolean;
    /** The pointer is down. */
    pressed?: boolean;
    /** The export menu is open. */
    menu?: boolean;
    /** The Word item is highlighted. */
    hovered?: boolean;
    /** The export is running: the button spins. */
    exporting?: boolean;
    /** The citation shows Word's field shading — it is a live Zotero citation. */
    field?: boolean;
}

type Beat = ShowcaseBeat<Frame>;

/**
 * The story, beat by beat: the pointer goes to the note row's export button,
 * opens the menu, picks Word, and the chat gives way to the document in Word,
 * where clicking the citation shows it is a Zotero field. Then it starts over.
 */
const TIMELINE: Beat[] = [
    { frame: { scene: 'note', pointer: 'rest', pointerHidden: true }, holdMs: 450 },
    { frame: { scene: 'note', pointer: 'rest' }, holdMs: 650 },
    { frame: { scene: 'note', pointer: 'export' }, holdMs: 750 },
    { frame: { scene: 'note', pointer: 'export', pressed: true }, holdMs: 160 },
    { frame: { scene: 'note', pointer: 'export', menu: true }, holdMs: 650 },
    { frame: { scene: 'note', pointer: 'word', menu: true, hovered: true }, holdMs: 800 },
    { frame: { scene: 'note', pointer: 'word', menu: true, hovered: true, pressed: true }, holdMs: 180 },
    { frame: { scene: 'note', pointer: 'word', exporting: true }, holdMs: 900 },
    { frame: { scene: 'document', pointer: 'rest' }, holdMs: 1000 },
    { frame: { scene: 'document', pointer: 'citation' }, holdMs: 750 },
    { frame: { scene: 'document', pointer: 'citation', pressed: true, field: true }, holdMs: 160 },
    { frame: { scene: 'document', pointer: 'citation', field: true }, holdMs: 2800 },
];

/** The same story as stills, for a user who asked for less motion. */
const STILL_TIMELINE: Beat[] = [
    { frame: { scene: 'note', pointer: 'word', menu: true, hovered: true }, holdMs: 3500 },
    { frame: { scene: 'document', pointer: 'citation', field: true }, holdMs: 4500 },
];

/**
 * Moves the pointer to the frame's target, measured from the drawn elements
 * (`data-pointer-target`) so it lands on them however wide the tip is. A
 * target that is gone — the menu closed under it — leaves the pointer where
 * it was.
 */
function usePointerPosition(stageRef: React.RefObject<HTMLElement>, target: PointerTarget, frame: Frame) {
    const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
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

const ArrowPointer: React.FC = () => (
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

const TextPointer: React.FC = () => (
    <svg width="10" height="18" viewBox="0 0 10 18">
        <path
            d="M2 1.5 H4 Q5 1.5 5 3 V15 Q5 16.5 4 16.5 H2 M8 1.5 H6 Q5 1.5 5 3 M5 15 Q5 16.5 6 16.5 H8"
            fill="none"
            stroke="#fff"
            strokeWidth="3"
            strokeLinecap="round"
        />
        <path
            d="M2 1.5 H4 Q5 1.5 5 3 V15 Q5 16.5 4 16.5 H2 M8 1.5 H6 Q5 1.5 5 3 M5 15 Q5 16.5 6 16.5 H8"
            fill="none"
            stroke="#000"
            strokeWidth="1.2"
            strokeLinecap="round"
        />
    </svg>
);

/** A ghost icon button as the chat draws it, inert. */
const GhostIcon: React.FC<{ icon: React.ComponentType<React.SVGProps<SVGSVGElement>>; className?: string }> = ({ icon, className = '' }) => (
    <button type="button" className={`variant-ghost icon-only ${className}`} tabIndex={-1}>
        <Icon icon={icon} />
    </button>
);

/**
 * The end of a finished response, from the real classes: its last line, the
 * footer with its sources and actions, and the created note's artifact row
 * with the export button and the open link. The row sits at the bottom, as
 * it does above the composer, so the export menu opens upward over the
 * response.
 */
const RunEnd: React.FC<{ frame: Frame }> = ({ frame }) => {
    const exportActive = frame.pointer === 'export' && !frame.pointerHidden;
    return (
        <div className="display-flex flex-col gap-3 beaver-export-tip__run-end">
            <div className="markdown beaver-export-tip__response">
                <p>
                    Across the three studies, neighborhood disadvantage persists across generations and
                    shapes trust and collective efficacy<span className="zotero-citation">1</span>. Police
                    stops near schools lower test scores<span className="zotero-citation">2</span>, and the
                    effect is concentrated among students who live closest to campus
                    <span className="zotero-citation">3</span>. I saved these findings as a note.
                </p>
            </div>
            <div className="display-flex flex-row items-center">
                <div className="flex-1">
                    <Button variant="ghost" icon={ArrowRightIcon} iconClassName="mr-0 scale-12 -ml-1" tabIndex={-1}>
                        <span>3 Sources</span>
                    </Button>
                </div>
                <div className="display-flex gap-4 mr-2">
                    <GhostIcon icon={MoreHorizontalIcon} className="scale-11" />
                    <GhostIcon icon={RepeatIcon} className="scale-11" />
                    <GhostIcon icon={CopyIcon} className="scale-11" />
                </div>
            </div>
            <div className="border-card rounded-card display-flex flex-col min-w-0 beaver-export-tip__row">
                <div className="display-flex flex-row items-center py-15 gap-1 bg-senary">
                    <div className="display-flex flex-row items-start ml-3 gap-2 min-w-0" style={{ fontSize: '0.95rem' }}>
                        <div className="display-flex items-center scale-11 mt-010 flex-shrink-0">
                            <Icon icon={CheckmarkCircleIcon} className="font-color-green" />
                        </div>
                        <div className="min-w-0 truncate">
                            <span className="font-color-primary font-medium">Created Note</span>
                            <span className="font-color-secondary ml-15">{NOTE_TITLE}</span>
                        </div>
                    </div>
                    <div className="flex-1" />
                    <div className="display-flex flex-row items-center gap-2 mr-3 mt-010 flex-shrink-0">
                        <div className="beaver-export-tip__anchor">
                            <button
                                type="button"
                                className={`variant-ghost-secondary icon-only beaver-export-tip__button ${exportActive || frame.menu ? 'beaver-export-tip__button--active' : ''} ${exportActive && frame.pressed ? 'beaver-export-tip__button--pressed' : ''}`}
                                tabIndex={-1}
                                data-pointer-target="export"
                            >
                                <Icon icon={frame.exporting ? Spinner : DownloadIcon} className="font-color-secondary scale-10" />
                            </button>
                            {frame.menu && <ExportMenu frame={frame} />}
                        </div>
                        <button type="button" className="variant-ghost-secondary icon-only" tabIndex={-1}>
                            <Icon icon={ArrowUpRightIcon} className="font-color-secondary scale-10" />
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

/** The export menu, from the real menu's classes and its list of formats. */
const ExportMenu: React.FC<{ frame: Frame }> = ({ frame }) => (
    <div className="bg-overlay border-popup rounded-md p-1 shadow-md beaver-export-tip__menu">
        {FILE_EXPORT_FORMATS.map(({ format, name, icon }) => {
            const isWord = format === 'docx';
            return (
                <div
                    key={format}
                    className={`beaver-menu-item display-flex items-center gap-2 px-2 py-15 rounded-md ${isWord && frame.hovered ? 'bg-quinary' : ''} ${isWord && frame.pressed ? 'beaver-export-tip__item--pressed' : ''}`}
                    data-pointer-target={isWord ? 'word' : undefined}
                >
                    <Icon icon={icon} size={14} className="font-color-secondary flex-shrink-0" />
                    <span className="flex-1 text-base font-color-secondary truncate">{name}…</span>
                </div>
            );
        })}
    </div>
);

/**
 * The exported note open in Word: the window's title bar and ribbon with
 * Zotero's tab, and the page with the citation formatted in the citation
 * style and a bibliography. Drawn in Word's colors in either theme — it is a
 * picture of another app.
 */
const WordDocument: React.FC<{ frame: Frame }> = ({ frame }) => (
    <div className="beaver-export-tip__word">
        <div className="beaver-export-tip__word-titlebar">
            <span className="beaver-export-tip__word-logo">W</span>
            <span className="truncate">{FILE_NAME}</span>
        </div>
        <div className="beaver-export-tip__word-ribbon">
            <span>Home</span>
            <span>Insert</span>
            <span>References</span>
            <span className="beaver-export-tip__word-tab--zotero">Zotero</span>
        </div>
        <div className="beaver-export-tip__word-canvas">
            <div className="beaver-export-tip__word-page">
                <div className="beaver-export-tip__word-heading">Key findings</div>
                <p>
                    {SENTENCE_BEFORE}{' '}
                    <span
                        className={`beaver-export-tip__word-citation ${frame.field ? 'beaver-export-tip__word-citation--field' : ''}`}
                        data-pointer-target="citation"
                    >
                        {WORD_CITATION}
                    </span>
                    {SENTENCE_AFTER}
                </p>
                <div className="beaver-export-tip__word-heading beaver-export-tip__word-heading--minor">References</div>
                <p className="beaver-export-tip__word-bibliography">
                    Sampson, Robert J. 2012. <i>Great American City: Chicago and the Enduring Neighborhood Effect</i>.
                    Chicago: University of Chicago Press.
                </p>
            </div>
        </div>
    </div>
);

/**
 * The export tip's visual: a note Beaver created, exported to Word from its
 * row at the end of the response, then open in Word with its citation as a
 * live Zotero field. The row and menu are drawn from the real ones' classes,
 * so they look like what the user will click. Purely decorative: nothing in it takes the pointer or
 * focus.
 */
const NoteExportTipShowcase: React.FC = () => {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const frame = useShowcaseTimeline(rootRef, TIMELINE, STILL_TIMELINE);
    const position = usePointerPosition(stageRef, frame.pointer, frame);
    const isDocument = frame.scene === 'document';

    return (
        <div ref={rootRef} className="beaver-export-tip" data-scene={frame.scene} aria-hidden="true">
            <div ref={stageRef} className="beaver-export-tip__stage">
                <div className={`beaver-export-tip__layer ${isDocument ? 'beaver-export-tip__layer--hidden' : ''}`}>
                    <RunEnd frame={frame} />
                </div>
                <div className={`beaver-export-tip__layer beaver-export-tip__layer--document ${isDocument ? '' : 'beaver-export-tip__layer--hidden'}`}>
                    <WordDocument frame={frame} />
                </div>
                {position && (
                    <div
                        className={`beaver-export-tip__pointer ${frame.pointerHidden ? 'beaver-export-tip__pointer--hidden' : ''}`}
                        style={{ transform: `translate(${position.x}px, ${position.y}px)` }}
                    >
                        <div className={`beaver-export-tip__pointer-glyph ${isDocument ? 'beaver-export-tip__pointer-glyph--text' : ''} ${frame.pressed ? 'beaver-export-tip__pointer-glyph--pressed' : ''}`}>
                            {isDocument ? <TextPointer /> : <ArrowPointer />}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default NoteExportTipShowcase;
