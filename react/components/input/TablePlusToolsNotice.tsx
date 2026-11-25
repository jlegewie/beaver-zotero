import React from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import { AlertIcon, CancelIcon, Icon } from '../icons/icons';
import { tablePlusToolsNoticeAtom, tablePlusToolsNoticeDismissedAtom } from '../../atoms/chatAccess';
import { selectBeaverModelAtom } from '../../atoms/models';
import { requestPlusToolsAtom } from '../../atoms/ui';
import { setPref } from '../../../src/utils/prefs';
import { openPreferencesWindow } from '../../ui/openPreferencesWindow';

interface TablePlusToolsNoticeProps {
    /**
     * `band`: docked above the chat input, like the other composer bands.
     * `tray`: tucked under the input on the home page, where the feature
     * credits line sits.
     */
    placement: 'band' | 'tray';
}

/**
 * Tells a user on their own API key, with Plus Tools off, that Beaver can only
 * read the research table the message carries: filling and editing it are
 * Plus Tools. Offers the changes that fix it — switching to the Beaver model
 * or turning Plus Tools on, or getting credits when there are none for
 * either. Renders nothing otherwise (see `tablePlusToolsNoticeAtom`).
 */
const TablePlusToolsNotice: React.FC<TablePlusToolsNoticeProps> = ({ placement }) => {
    const notice = useAtomValue(tablePlusToolsNoticeAtom);
    const setDismissed = useSetAtom(tablePlusToolsNoticeDismissedAtom);
    const setRequestPlusTools = useSetAtom(requestPlusToolsAtom);
    const selectBeaverModel = useSetAtom(selectBeaverModelAtom);
    if (!notice) return null;

    const tables = notice.tableCount > 1 ? 'these tables' : 'this table';
    const them = notice.tableCount > 1 ? 'them' : 'it';

    // Kept from the composer's container, whose click handler focuses the editor.
    const handle = (action: () => void) => (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        action();
    };
    const link = (label: string, action: () => void) => (
        <a href="#" className="table-plus-tools-notice-link" onClick={handle(action)}>{label}</a>
    );

    const turnOnPlusTools = () => {
        setPref('requestPlusTools', true);
        setRequestPlusTools(true);
    };

    return (
        <div
            role="status"
            className={placement === 'band'
                ? 'composer-docked-bar table-plus-tools-notice display-flex flex-row items-start px-3 py-15 gap-2'
                : 'home-tray table-plus-tools-notice is-tray'}
        >
            {placement === 'band' && <Icon icon={AlertIcon} className="font-color-secondary scale-10 mt-010" />}
            <span className="table-plus-tools-notice-text">
                With your API key, Beaver can only read {tables}.{' '}
                {notice.fix === 'switch-model-or-plus-tools' ? (
                    <>
                        {link('Switch to the Beaver model', () => selectBeaverModel())}
                        {' or '}
                        {link('turn on Plus Tools', turnOnPlusTools)}
                        {` to fill and edit ${them}.`}
                    </>
                ) : (
                    <>
                        {`Filling and editing ${them} need credits. `}
                        {link('Get credits', () => openPreferencesWindow('billing'))}
                    </>
                )}
            </span>
            <div className="flex-1" />
            <IconButton
                variant="ghost-secondary"
                icon={CancelIcon}
                ariaLabel="Dismiss"
                onClick={handle(() => setDismissed(true))}
                className="scale-85 mt-010"
            />
        </div>
    );
};

export default TablePlusToolsNotice;
