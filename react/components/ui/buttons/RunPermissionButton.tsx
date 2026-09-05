import React, { useMemo } from 'react';
import PermissionMenu, { PermissionMenuOption } from '@beaver/agent-ui/primitives/PermissionMenu';
import HandIcon from '@beaver/agent-ui/icons/HandIcon';
import SecurityWarningIcon from '@beaver/agent-ui/icons/SecurityWarningIcon';
import { openPreferencesWindow } from '../../../../src/ui/openPreferencesWindow';

/** How much Beaver may change in the library for the rest of the current run. */
export type RunPermissionMode = 'ask' | 'full_access';

/**
 * Where the standing default lives, so the menu can stay run-scoped without
 * hiding the fact that a permanent choice exists. The footnote opens that pane.
 */
export const RUN_PERMISSION_FOOTNOTE_LINK = 'Settings → Permissions';
export const RUN_PERMISSION_FOOTNOTE = `Set the default in ${RUN_PERMISSION_FOOTNOTE_LINK}`;

/**
 * What the grant reaches, stated on the row itself. Full access is deliberately
 * unqualified: it covers every library change the run makes, including the
 * ones that have no Preferences row of their own (annotation deletion,
 * destructive note rewrites). Those carve-outs exist to keep a *standing*
 * preference from quietly authorizing them; a grant the user makes on the card
 * in front of them, for this run only, is the explicit decision they protect —
 * so the row has to say it reaches them.
 */
export const FULL_ACCESS_DESCRIPTION =
    'Apply every library change for the rest of this response including deletions.';

/**
 * The full-access row's description once the grant would answer more than the
 * card it sits on. Switching answers every covered card in the run, seen or
 * not, and the row is the only place that can say how many.
 */
export function describeFullAccess(pendingCoveredCount: number): string {
    if (pendingCoveredCount <= 1) return FULL_ACCESS_DESCRIPTION;
    return `${FULL_ACCESS_DESCRIPTION}. Approves the ${pendingCoveredCount} pending changes now`;
}

/**
 * The same two choices, in the same order and wearing the same icons, as the
 * batch approval card's mode menu — a user meets both of these while a run is
 * waiting on them, and they should read as one control with two scopes. The
 * option that keeps asking comes first, as in every permission menu.
 */
export const RUN_PERMISSION_OPTIONS: readonly PermissionMenuOption<RunPermissionMode>[] = [
    {
        value: 'ask',
        label: 'Ask permission',
        description: 'Review every change before it is applied',
        icon: HandIcon,
    },
    {
        value: 'full_access',
        label: 'Full access',
        description: FULL_ACCESS_DESCRIPTION,
        icon: SecurityWarningIcon,
        tone: 'warning',
    },
];

interface RunPermissionButtonProps {
    mode: RunPermissionMode;
    onChange: (mode: RunPermissionMode) => void;
    disabled?: boolean;
    /**
     * How many pending approvals a switch to full access would answer right
     * now, this card's included. Shown on the row when it is more than one.
     */
    pendingCoveredCount?: number;
}

/**
 * The permission control on an approval card: the shared `PermissionMenu` with
 * the copy for a grant that lasts the current run.
 *
 * Presentational — the caller owns the run the grant is scoped to. It replaces
 * the per-tool preference control while a card is waiting on the user, so the
 * one decision in front of them is about this run rather than about a setting
 * they would have to remember to undo.
 *
 * Like the batch card's menu it carries no heading: the two rows say what they
 * do, and a question above them only pushes the options further from the
 * trigger. The footnote is the exception — nothing else on the card says a
 * standing default exists — and it opens the Permissions pane, since the
 * moment a card is waiting is exactly when someone decides "always do this".
 */
const RunPermissionButton: React.FC<RunPermissionButtonProps> = ({
    mode,
    onChange,
    disabled = false,
    pendingCoveredCount = 0,
}) => {
    const options = useMemo(
        () => RUN_PERMISSION_OPTIONS.map((option) => (
            option.value === 'full_access'
                ? { ...option, description: describeFullAccess(pendingCoveredCount) }
                : option
        )),
        [pendingCoveredCount],
    );
    return (
        <PermissionMenu
            options={options}
            value={mode}
            onChange={onChange}
            footnote={RUN_PERMISSION_FOOTNOTE}
            footnoteLink={RUN_PERMISSION_FOOTNOTE_LINK}
            onFootnoteClick={() => openPreferencesWindow('permissions')}
            disabled={disabled}
            ariaLabel="How library changes are approved for this run"
            tooltipContent="How library changes are approved for this run"
            style={{ padding: '2px 6px', fontSize: '0.95rem' }}
        />
    );
};

export default RunPermissionButton;
