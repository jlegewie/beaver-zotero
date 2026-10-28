import React from 'react';
import type { TableCardCost } from '@beaver/agent-core/protocol/tableCardProtocol';
import { creditChip, creditTooltip } from '@beaver/agent-core/run-state/tableCardDraft';
import Tooltip from '@beaver/agent-ui/primitives/Tooltip';
import { DollarCircleIcon, Icon } from '../../icons/icons';

/**
 * The credit chip of a table card, as on the batch card: shown only when the
 * cost quotes credits, that is when approving raises what the run already
 * authorizes. The tooltip says what approving authorizes, not what the run
 * will cost.
 */
const TableCardCreditChip: React.FC<{ cost: TableCardCost | null }> = ({ cost }) => {
    const chip = creditChip(cost);
    const tooltip = creditTooltip(cost);
    if (!chip || !tooltip) return null;
    return (
        // A flex-none wrapper, so the tooltip is not measured as a flex item
        // of the wrapping header row.
        <div className="flex-none">
            <Tooltip content={tooltip} showArrow width="220px" horizontalAlign="end">
                <div className="table-card-credit-chip text-sm font-color-secondary items-center display-flex">
                    <Icon icon={DollarCircleIcon} className="font-color-secondary scale-11 flex-none mr-1" />
                    {chip}
                </div>
            </Tooltip>
        </div>
    );
};

export default TableCardCreditChip;
