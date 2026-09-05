import React from 'react';
import PermissionMenu, { PermissionMenuOption } from '@beaver/agent-ui/primitives/PermissionMenu';
import HandIcon from '@beaver/agent-ui/icons/HandIcon';
import SecurityWarningIcon from '@beaver/agent-ui/icons/SecurityWarningIcon';

/** How much Beaver may change in the library for the rest of the current run. */
export type RunPermissionMode = 'ask' | 'full_access';

/**
 * Where the standing default lives, so the menu can stay run-scoped without
 * hiding the fact that a permanent choice exists.
 */
export const RUN_PERMISSION_FOOTNOTE = 'Set the default in Settings → Permissions';

/**
 * The same two choices, in the same order and wearing the same icons, as the
 * batch approval card's mode menu — a user meets both of these while a run is
 * waiting on them, and they should read as one control with two scopes.
 *
 * Full access is deliberately unqualified: it covers every library change the
 * run makes, including the ones that have no Preferences row of their own
 * (annotation deletion, destructive note rewrites). Those carve-outs exist to
 * keep a *standing* preference from quietly authorizing them; a grant the user
 * makes on the card in front of them, for this run only, is the explicit
 * decision they protect.
 */
export const RUN_PERMISSION_OPTIONS: readonly PermissionMenuOption<RunPermissionMode>[] = [
    {
        value: 'full_access',
        label: 'Full access',
        description: 'Apply library changes for the rest of this response',
        icon: SecurityWarningIcon,
        tone: 'warning',
    },
    {
        value: 'ask',
        label: 'Ask permission',
        description: 'Review every change before it is applied',
        icon: HandIcon,
    },
];

interface RunPermissionButtonProps {
    mode: RunPermissionMode;
    onChange: (mode: RunPermissionMode) => void;
    disabled?: boolean;
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
 * standing default exists.
 */
const RunPermissionButton: React.FC<RunPermissionButtonProps> = ({
    mode,
    onChange,
    disabled = false,
}) => (
    <PermissionMenu
        options={RUN_PERMISSION_OPTIONS}
        value={mode}
        onChange={onChange}
        footnote={RUN_PERMISSION_FOOTNOTE}
        disabled={disabled}
        ariaLabel="How library changes are approved for this run"
        tooltipContent="How library changes are approved for this run"
        style={{ padding: '2px 6px', fontSize: '0.95rem' }}
    />
);

export default RunPermissionButton;
