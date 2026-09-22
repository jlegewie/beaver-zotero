import React, { useCallback, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { TableArtifact } from '@beaver/agent-core/run-state/tableResults';
import { getHost } from '@beaver/agent-ui/host';
import IconButton from '@beaver/agent-ui/primitives/IconButton';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { toolExpandedAtom, setToolExpandedAtom } from '../../../../atoms/messageUIState';
import { useTableDisplay } from '../../../../hooks/useTableDisplay';
import { TableResultView } from '../../../../components/agentRuns/toolResultViews/TableResultView';
import {
    ArrowDownIcon,
    ArrowRightIcon,
    ArrowUpRightIcon,
    Icon,
    TableIcon,
} from '../../../../components/icons/icons';

interface TableArtifactRowProps {
    row: TableArtifact;
}

/**
 * One table in the artifacts list, laid out like `ReviewActionRow` inside its
 * group: the table glyph, a past-tense label, the title, and an open glyph.
 * The title follows the document when it can be read, since the row exists to
 * take the user to the table as it is now; the expanded summary keeps the
 * historical observation and says what changed since.
 */
export const TableArtifactRow: React.FC<TableArtifactRowProps> = ({ row }) => {
    const { record } = row;
    const [isHovered, setIsHovered] = useState(false);
    const [openMessage, setOpenMessage] = useState('');

    // Same scope as the review rows so a tool call opened here does not open its
    // in-stream card too.
    const expansionKey = `${row.runId}:changes:${row.toolcallId}`;
    const expansionState = useAtomValue(toolExpandedAtom);
    const setExpanded = useSetAtom(setToolExpandedAtom);
    const isExpanded = expansionState[expansionKey] ?? false;
    const toggleExpanded = useCallback(
        () => setExpanded({ key: expansionKey, expanded: !isExpanded }),
        [expansionKey, isExpanded, setExpanded],
    );

    const current = useTableDisplay(record.reference.key);
    // The fallback covers both sources: the host contract does not promise a
    // non-empty current title any more than the record does.
    const title = (current?.status === 'available' ? current.title : record.reference.title)
        || 'Untitled table';
    const label = row.created ? 'Created Table' : 'Updated Table';

    const handleOpen = useCallback(async () => {
        const open = getHost().navigation?.openTable;
        if (!open) {
            setOpenMessage('Table provider unavailable.');
            return;
        }
        const outcome = await open(record.reference.key)
            .catch(() => ({ error: 'Table provider unavailable.' }));
        setOpenMessage('error' in outcome ? outcome.error : (outcome.warning ?? ''));
    }, [record.reference.key]);

    const headerIcon = isHovered ? (isExpanded ? ArrowDownIcon : ArrowRightIcon) : TableIcon;

    return (
        <div className="display-flex flex-col min-w-0">
            <div className={`display-flex flex-row items-center py-15 gap-1 ${isExpanded ? 'border-bottom-quinary' : ''}`}>
                <button
                    type="button"
                    className="variant-ghost-secondary display-flex flex-row items-start ml-3 gap-2 min-w-0 text-left"
                    style={{
                        fontSize: '0.95rem',
                        background: 'transparent',
                        border: 0,
                        padding: 0,
                        alignItems: 'flex-start',
                    }}
                    aria-expanded={isExpanded}
                    onClick={toggleExpanded}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                >
                    <div className="display-flex items-center scale-11 mt-010" style={{ flexShrink: 0 }}>
                        <Icon icon={headerIcon} />
                    </div>
                    <div
                        className="min-w-0"
                        style={{
                            display: '-webkit-box',
                            WebkitLineClamp: 2,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            wordBreak: 'break-word',
                        }}
                    >
                        <span className="font-color-primary font-medium">{label}</span>
                        {title && <span className="font-color-secondary ml-15">{title}</span>}
                    </div>
                </button>

                <div className="flex-1" />

                <div className="display-flex flex-row items-center gap-2 mr-3 mt-010" style={{ flexShrink: 0 }}>
                    <Tooltip content="Open table" showArrow singleLine>
                        <IconButton
                            icon={ArrowUpRightIcon}
                            variant="ghost-secondary"
                            iconClassName="font-color-secondary scale-10"
                            onClick={handleOpen}
                            ariaLabel="Open table"
                        />
                    </Tooltip>
                </div>
            </div>

            {openMessage && (
                <div role="status" className="px-3 pb-2 text-sm font-color-tertiary">{openMessage}</div>
            )}

            {isExpanded && <TableResultView view={{ view_type: 'table', record }} />}
        </div>
    );
};

export default TableArtifactRow;
