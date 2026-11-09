import React, { useRef } from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import { ArrowUpRightIcon, CheckmarkCircleIcon, FileIcon, Icon, PlayIcon, TableIcon } from '../../../icons/icons';
import { useShowcaseTimeline, type ShowcaseBeat } from './useShowcaseTimeline';
import { ShowcasePointer, usePointerPosition } from './ShowcasePointer';

/** The table the showcase fills: a few of its rows, and how many it has in all. */
const TABLE_NAME = 'Neighborhood effects';
const TOTAL_ROWS = 24;

interface ShowcaseRow {
    title: string;
    /** Author and year. */
    byline: string;
    design: { label: string; color: 'green' | 'blue' | 'purple' };
    finding: string;
    page: string;
}

const ROWS: readonly ShowcaseRow[] = [
    {
        title: 'Effects of Exposure to Better Neighborhoods on Children',
        byline: 'Chetty 2016',
        design: { label: 'RCT', color: 'green' },
        finding: 'Moving young raises earnings',
        page: 'p. 855',
    },
    {
        title: 'Great American City',
        byline: 'Sampson 2012',
        design: { label: 'Survey', color: 'blue' },
        finding: 'Inequality persists for decades',
        page: 'p. 6',
    },
    {
        title: 'Stuck in Place',
        byline: 'Sharkey 2013',
        design: { label: 'Panel', color: 'purple' },
        finding: 'Disadvantage spans generations',
        page: 'p. 27',
    },
    {
        title: 'Neighborhood Effects in Temporal Perspective',
        byline: 'Wodtke 2011',
        design: { label: 'Panel', color: 'purple' },
        finding: 'Long exposure lowers graduation',
        page: 'p. 713',
    },
];

/** The passage behind the first row's answer, as its page tag's card shows it. */
const EVIDENCE = {
    where: 'Page 855 · Chetty et al. 2016',
    quote: 'Moving to a lower-poverty neighborhood when young (before age 13) increases college attendance and earnings.',
};

/**
 * How a row's answer cells look, as the real grid draws a running fill:
 * empty before the fill, still lines while it waits its turn, shimmering
 * lines while Beaver reads the item, then the answer fading in over a tint.
 */
type RowLook = 'empty' | 'queued' | 'active' | 'landed' | 'answered';

type PointerTarget = 'rest' | 'fill' | 'tag';

interface Frame {
    rows: readonly RowLook[];
    /** Rows filled so far, of {@link TOTAL_ROWS}. */
    filled: number;
    /** The fill is running. */
    filling?: boolean;
    pointer: PointerTarget;
    /** The pointer is out of the picture (between loops). */
    pointerHidden?: boolean;
    /** The pointer is down. */
    pressed?: boolean;
    /** The first answer's page tag is hovered and its passage card is open. */
    evidence?: boolean;
}

type Beat = ShowcaseBeat<Frame>;

const EMPTY: readonly RowLook[] = ['empty', 'empty', 'empty', 'empty'];
const ANSWERED: readonly RowLook[] = ['answered', 'answered', 'answered', 'answered'];

/**
 * The story, beat by beat: an empty table, the Fill button clicked, the rows
 * read a few at a time and their answers landing, the count running up to
 * the whole table, then the pointer resting on an answer's page tag to show
 * the passage it came from. Then it starts over.
 */
const TIMELINE: readonly Beat[] = [
    { frame: { rows: EMPTY, filled: 0, pointer: 'rest', pointerHidden: true }, holdMs: 500 },
    { frame: { rows: EMPTY, filled: 0, pointer: 'rest' }, holdMs: 450 },
    { frame: { rows: EMPTY, filled: 0, pointer: 'fill' }, holdMs: 700 },
    { frame: { rows: EMPTY, filled: 0, pointer: 'fill', pressed: true }, holdMs: 160 },
    { frame: { rows: ['queued', 'queued', 'queued', 'queued'], filled: 0, filling: true, pointer: 'fill' }, holdMs: 450 },
    // A few items at a time, as the fill reads them.
    { frame: { rows: ['active', 'active', 'queued', 'queued'], filled: 0, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 1100 },
    { frame: { rows: ['landed', 'active', 'active', 'queued'], filled: 1, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 800 },
    { frame: { rows: ['landed', 'landed', 'active', 'active'], filled: 2, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 750 },
    { frame: { rows: ['answered', 'landed', 'landed', 'active'], filled: 3, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 450 },
    { frame: { rows: ['answered', 'landed', 'landed', 'landed'], filled: 9, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 300 },
    { frame: { rows: ['answered', 'answered', 'landed', 'landed'], filled: 16, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 300 },
    // Kept landed until their tint has faded.
    { frame: { rows: ['answered', 'answered', 'landed', 'landed'], filled: 24, pointer: 'rest', pointerHidden: true }, holdMs: 700 },
    { frame: { rows: ANSWERED, filled: 24, pointer: 'rest' }, holdMs: 350 },
    { frame: { rows: ANSWERED, filled: 24, pointer: 'tag' }, holdMs: 650 },
    { frame: { rows: ANSWERED, filled: 24, pointer: 'tag', evidence: true }, holdMs: 3600 },
    { frame: { rows: ANSWERED, filled: 24, pointer: 'tag', pointerHidden: true }, holdMs: 400 },
];

/** The same story as stills, for a user who asked for less motion. */
const STILL_TIMELINE: readonly Beat[] = [
    { frame: { rows: EMPTY, filled: 0, pointer: 'fill' }, holdMs: 2500 },
    { frame: { rows: ['answered', 'answered', 'active', 'queued'], filled: 2, filling: true, pointer: 'rest', pointerHidden: true }, holdMs: 3000 },
    { frame: { rows: ANSWERED, filled: 24, pointer: 'tag', evidence: true }, holdMs: 4500 },
];

/** The compact control sizing the corner cards' footers share. */
const FILL_BUTTON_STYLE: React.CSSProperties = { padding: '1px 8px', fontSize: '11px', whiteSpace: 'nowrap', gap: '4px' };

/** The table's name and its fill: the Fill button, then the fill's progress. */
const TableBar: React.FC<{ frame: Frame }> = ({ frame }) => {
    const started = frame.filling || frame.filled > 0;
    return (
        <div className="beaver-table-showcase__bar">
            <Icon icon={TableIcon} size={13} className="font-color-secondary flex-shrink-0" />
            <span className="beaver-table-showcase__name">{TABLE_NAME}</span>
            <div className="flex-1" />
            {!started ? (
                <span data-pointer-target="fill" className={`beaver-table-showcase__fill ${frame.pressed ? 'beaver-table-showcase__fill--pressed' : ''}`}>
                    <Button variant="solid" icon={PlayIcon} style={FILL_BUTTON_STYLE} tabIndex={-1}>
                        Fill {TOTAL_ROWS} rows
                    </Button>
                </span>
            ) : frame.filling ? (
                <span className="beaver-table-showcase__status">
                    <span className="beaver-table-showcase__pulse" />
                    {frame.filled} of {TOTAL_ROWS} filled
                </span>
            ) : (
                <span className="beaver-table-showcase__status beaver-table-showcase__status--done">
                    <Icon icon={CheckmarkCircleIcon} size={12} className="font-color-green" />
                    {TOTAL_ROWS} of {TOTAL_ROWS} filled
                </span>
            )}
            {started && (
                <span className="beaver-table-showcase__progress" aria-hidden="true">
                    <span style={{ width: `${(frame.filled / TOTAL_ROWS) * 100}%` }} />
                </span>
            )}
        </div>
    );
};

/** Placeholder lines where an answer is coming, from the real grid's classes. */
const FillLines: React.FC<{ short?: boolean }> = ({ short }) => (
    <span className={`rt-fill-lines${short ? ' rt-fill-lines-short' : ''}`}>
        <span className="rt-fill-line" />
        {!short && <span className="rt-fill-line" />}
    </span>
);

/**
 * One answer cell. It carries the real grid's `rt-cell` and `data-fill`, so
 * the shimmer, the landing tint and the fade-in are the table's own.
 */
const AnswerCell: React.FC<{ look: RowLook; short?: boolean; children: React.ReactNode }> = ({ look, short, children }) => {
    const fill = look === 'queued' ? 'queued' : look === 'active' ? 'active' : look === 'landed' ? 'landed' : undefined;
    return (
        <div className="beaver-table-showcase__cell rt-cell" data-fill={fill}>
            {look === 'queued' || look === 'active' ? (
                <FillLines short={short} />
            ) : look === 'empty' ? null : (
                <div className="rt-cell-body beaver-table-showcase__answer">{children}</div>
            )}
        </div>
    );
};

const TableRow: React.FC<{ row: ShowcaseRow; look: RowLook; first: boolean; tagHovered: boolean }> = ({ row, look, first, tagHovered }) => (
    <>
        <div className="beaver-table-showcase__cell beaver-table-showcase__item">
            <span className="beaver-table-showcase__title">{row.title}</span>
            <span className="beaver-table-showcase__byline">{row.byline}</span>
        </div>
        <AnswerCell look={look} short>
            <span className={`bt-pill bt-pill-${row.design.color} beaver-table-showcase__pill`}>{row.design.label}</span>
        </AnswerCell>
        <AnswerCell look={look}>
            <span className="beaver-table-showcase__finding">
                {row.finding}{' '}
                <span
                    className={`rt-tag rt-tag-page beaver-table-showcase__tag ${tagHovered ? 'beaver-table-showcase__tag--hovered' : ''}`}
                    data-pointer-target={first ? 'tag' : undefined}
                >
                    {row.page}
                </span>
            </span>
        </AnswerCell>
    </>
);

/** The page tag's card, from the real card's classes: where, the passage, and the link that opens it. */
const EvidenceCard: React.FC = () => (
    <div className="bt-hover-card beaver-table-showcase__evidence">
        <div className="rt-card rt-evidence-card">
            <div className="rt-card-meta">
                <Icon icon={FileIcon} size={11} />
                <span>{EVIDENCE.where}</span>
            </div>
            <p className="rt-quote">“{EVIDENCE.quote}”</p>
            <span className="rt-link-button">
                Open in PDF
                <Icon icon={ArrowUpRightIcon} size={11} />
            </span>
        </div>
    </div>
);

/**
 * The release note's visual for research tables: a table of a few papers,
 * filled by Beaver while you watch, each answer linked to the page it came
 * from. The grid's cells, pills, tags and passage card use the research
 * table's own classes, so the fill animates as it does in the table tab.
 * Purely decorative: nothing in it takes the pointer or focus.
 */
const ResearchTableShowcase: React.FC = () => {
    const rootRef = useRef<HTMLDivElement>(null);
    const stageRef = useRef<HTMLDivElement>(null);
    const frame = useShowcaseTimeline(rootRef, TIMELINE, STILL_TIMELINE);
    const position = usePointerPosition(stageRef, frame.pointer, frame);
    const tagHovered = frame.pointer === 'tag' && !frame.pointerHidden;

    return (
        <div ref={rootRef} className="beaver-showcase beaver-table-showcase" aria-hidden="true">
            <div ref={stageRef} className="beaver-table-showcase__stage">
                <div className="beaver-table-showcase__table">
                    <TableBar frame={frame} />
                    <div className="beaver-table-showcase__grid">
                        <div className="beaver-table-showcase__head">Item</div>
                        <div className="beaver-table-showcase__head">Design</div>
                        <div className="beaver-table-showcase__head">Main finding</div>
                        {ROWS.map((row, index) => (
                            <TableRow
                                key={row.byline}
                                row={row}
                                look={frame.rows[index] ?? 'empty'}
                                first={index === 0}
                                tagHovered={index === 0 && tagHovered}
                            />
                        ))}
                    </div>
                </div>
                {frame.evidence && <EvidenceCard />}
                <ShowcasePointer position={position} hidden={frame.pointerHidden} pressed={frame.pressed} />
            </div>
        </div>
    );
};

export default ResearchTableShowcase;
