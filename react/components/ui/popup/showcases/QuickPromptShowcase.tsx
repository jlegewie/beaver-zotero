import React, { useEffect, useRef, useState } from 'react';
import Button from '@beaver/agent-ui/primitives/Button';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpLineIcon,
    ArrowUpRightIcon,
    BrainIcon,
    CheckmarkCircleIcon,
    GlobalSearchIcon,
    Icon,
    NoteIcon,
    PdfIcon,
    PlusSignIcon,
} from '../../../icons/icons';
import RunPulse from '../../../runStatusPopup/RunPulse';
import { quickPromptShortcutKeys } from '../../../../utils/quickPromptShortcut';

/** The prompt the showcase types, and what the run makes of it. */
const PROMPT = 'Summarize the key findings and save them as a note';
const THREAD_NAME = 'Key findings summary';
const STATUS_LINES = ['Reading Sampson 2012, p. 31-48', 'Writing the note'];
const NOTE_TITLE = 'Key findings: Sampson 2012';

/** The compact control sizing the corner cards' footers share. */
const FOOTER_BUTTON_STYLE: React.CSSProperties = { padding: '2px 10px', fontSize: '0.875rem', whiteSpace: 'nowrap' };

type Scene = 'shortcut' | 'compose' | 'running' | 'completed';

interface Frame {
    scene: Scene;
    /** Shortcut: the keys are down. */
    pressed?: boolean;
    /** Compose: how much of the prompt has been typed. */
    typed?: number;
    /** Compose: the send button is being pressed. */
    sending?: boolean;
    /** Running: which status line is up. */
    status?: number;
}

interface Beat {
    frame: Frame;
    holdMs: number;
}

const TYPING_MS_PER_CHAR = 28;

/**
 * The story, beat by beat: the chord is pressed, the composer opens in the
 * corner and the prompt is typed and sent, the run's card takes its place
 * and works, and the result is there. Then it starts over.
 */
function buildTimeline(): Beat[] {
    const beats: Beat[] = [
        { frame: { scene: 'shortcut', pressed: false }, holdMs: 700 },
        { frame: { scene: 'shortcut', pressed: true }, holdMs: 450 },
        { frame: { scene: 'compose', typed: 0 }, holdMs: 600 },
    ];
    for (let typed = 1; typed <= PROMPT.length; typed++) {
        beats.push({ frame: { scene: 'compose', typed }, holdMs: TYPING_MS_PER_CHAR });
    }
    beats.push(
        { frame: { scene: 'compose', typed: PROMPT.length }, holdMs: 500 },
        { frame: { scene: 'compose', typed: PROMPT.length, sending: true }, holdMs: 260 },
        { frame: { scene: 'running', status: 0 }, holdMs: 1700 },
        { frame: { scene: 'running', status: 1 }, holdMs: 1500 },
        { frame: { scene: 'completed' }, holdMs: 3200 },
    );
    return beats;
}

const TIMELINE = buildTimeline();

/** The same story as stills, for a user who asked for less motion. */
const STILL_TIMELINE: Beat[] = [
    { frame: { scene: 'shortcut', pressed: true }, holdMs: 2500 },
    { frame: { scene: 'compose', typed: PROMPT.length }, holdMs: 3500 },
    { frame: { scene: 'running', status: 0 }, holdMs: 3000 },
    { frame: { scene: 'completed' }, holdMs: 4000 },
];

/**
 * Plays the timeline on the window the showcase is drawn in, looping until
 * the showcase goes away. The timers are the window's own: a popup can be
 * drawn in either main window, and a timer scheduled elsewhere would outlive
 * the one that closes.
 */
function useTimeline(rootRef: React.RefObject<HTMLElement>): Frame {
    const [frame, setFrame] = useState<Frame>(TIMELINE[0].frame);
    useEffect(() => {
        const win = rootRef.current?.ownerDocument.defaultView;
        if (!win) return;
        const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
        const beats = reducedMotion ? STILL_TIMELINE : TIMELINE;
        let index = 0;
        let timer: number | null = null;
        const play = () => {
            setFrame(beats[index].frame);
            timer = win.setTimeout(() => {
                index = (index + 1) % beats.length;
                play();
            }, beats[index].holdMs);
        };
        play();
        return () => {
            if (timer !== null) win.clearTimeout(timer);
        };
    }, [rootRef]);
    return frame;
}

const Chord: React.FC<{ keys: string[]; pressed: boolean }> = ({ keys, pressed }) => (
    <div className={`beaver-showcase__chord ${pressed ? 'beaver-showcase__chord--pressed' : ''}`}>
        {keys.map((key) => (
            <span key={key} className="beaver-showcase__key">{key}</span>
        ))}
    </div>
);

/**
 * The quick prompt's card, built from the real card's and composer's
 * classes: the open file attached, the prompt being typed, and the control
 * row with Send lighting up once there is something to send.
 */
const ComposerCard: React.FC<{ typed: string; sending: boolean }> = ({ typed, sending }) => (
    <div className="beaver-quick-prompt__card">
        <div className="beaver-quick-prompt__composer">
            <div className="user-message-display">
                <div className="composer-attachments">
                    <span className="variant-outline source-button">
                        <span className="chip-icon-slot">
                            <Icon icon={PdfIcon} size={14} className="font-color-secondary" />
                        </span>
                        <span className="truncate">Current File</span>
                    </span>
                </div>
                <div className="mb-2">
                    <div className="beaver-showcase__editor">
                        {typed ? (
                            <>
                                {typed}
                                <span className="beaver-showcase__caret" />
                            </>
                        ) : (
                            <span className="beaver-showcase__placeholder">
                                <span className="beaver-showcase__caret" />
                                Ask Beaver
                            </span>
                        )}
                    </div>
                </div>
                <div className="composer-controls">
                    <button type="button" className="variant-ghost composer-add-sources" tabIndex={-1}>
                        <Icon icon={PlusSignIcon} size={18} className="scale-13" />
                    </button>
                    <button type="button" className="variant-ghost-secondary beaver-showcase__model" tabIndex={-1}>
                        <Icon icon={BrainIcon} />
                        Auto
                        <Icon icon={ArrowDownIcon} className="scale-11 -ml-1" />
                    </button>
                    <div className="flex-1" />
                    <button type="button" className="variant-ghost-secondary icon-only composer-icons" tabIndex={-1}>
                        <Icon icon={GlobalSearchIcon} />
                    </button>
                    <button
                        type="button"
                        className={`variant-solid icon-only composer-send ${sending ? 'beaver-showcase__send--pressed' : ''}`}
                        disabled={typed.length === 0}
                        tabIndex={-1}
                    >
                        <Icon icon={ArrowUpLineIcon} />
                    </button>
                </div>
            </div>
        </div>
    </div>
);

/** The run status card's frame, from the real card's classes. */
const RunCard: React.FC<{ leading: React.ReactNode; detail?: React.ReactNode; children?: React.ReactNode }> = ({ leading, detail, children }) => (
    <div className="beaver-run-status-popup__card beaver-showcase__run-card">
        <div className="beaver-run-status-popup__content">
            <div className="beaver-run-status-popup__header">
                <div className="beaver-run-status-popup__leading">{leading}</div>
                <div className="beaver-run-status-popup__text">
                    <div className="beaver-run-status-popup__title font-color-primary">{THREAD_NAME}</div>
                    {detail && <div className="beaver-run-status-popup__detail font-color-secondary">{detail}</div>}
                </div>
            </div>
            {children}
        </div>
    </div>
);

const RunningCard: React.FC<{ status: number }> = ({ status }) => (
    <RunCard leading={<RunPulse />} detail={<span className="shimmer-text">{STATUS_LINES[status] ?? STATUS_LINES[0]}</span>} />
);

const CompletedCard: React.FC = () => (
    <RunCard leading={<Icon icon={CheckmarkCircleIcon} size={16} className="font-color-green" />}>
        <div className="beaver-run-status-popup__rows">
            <button type="button" className="beaver-run-status-popup__row" tabIndex={-1}>
                <Icon icon={NoteIcon} className="font-color-secondary" />
                <span className="beaver-run-status-popup__row-text">
                    <span className="font-color-primary font-medium">Created Note</span>
                    <span className="font-color-secondary"> {NOTE_TITLE}</span>
                </span>
                <Icon icon={ArrowUpRightIcon} className="font-color-tertiary beaver-run-status-popup__row-arrow" />
            </button>
        </div>
        <div className="beaver-run-status-popup__footer">
            <div className="flex-1" />
            <Button variant="outline" style={FOOTER_BUTTON_STYLE} rightIcon={ArrowRightIcon} tabIndex={-1}>
                Open Beaver
            </Button>
        </div>
    </RunCard>
);

/**
 * The release note's visual for the quick prompt: the feature played out in
 * a slot on the note — the shortcut, the composer it opens, the run's card
 * that takes over once the prompt is sent, and the result. The cards are
 * drawn from the real cards' classes, so they look like what the user will
 * see. Purely decorative: nothing in it takes the pointer or focus.
 */
const QuickPromptShowcase: React.FC = () => {
    const rootRef = useRef<HTMLDivElement>(null);
    const frame = useTimeline(rootRef);
    const keys = quickPromptShortcutKeys();

    return (
        <div ref={rootRef} className="beaver-showcase" data-scene={frame.scene} aria-hidden="true">
            <div className="beaver-showcase__stage">
                {frame.scene === 'shortcut' ? (
                    <Chord keys={keys} pressed={!!frame.pressed} />
                ) : (
                    // Keyed on the scene so each card arrives with its own entrance.
                    <div
                        key={frame.scene}
                        className={`beaver-showcase__card ${frame.scene === 'compose' ? 'beaver-quick-prompt' : 'beaver-run-status-popup'}`}
                    >
                        {frame.scene === 'compose' && (
                            <ComposerCard typed={PROMPT.slice(0, frame.typed ?? 0)} sending={!!frame.sending} />
                        )}
                        {frame.scene === 'running' && <RunningCard status={frame.status ?? 0} />}
                        {frame.scene === 'completed' && <CompletedCard />}
                    </div>
                )}
            </div>
        </div>
    );
};

export default QuickPromptShowcase;
