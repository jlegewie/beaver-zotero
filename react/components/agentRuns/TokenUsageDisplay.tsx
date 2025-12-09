import React from 'react';
import { RunUsage } from '../../agents/types';
import { Icon, DollarCircleIcon } from '../icons/icons';
import Tooltip from '../ui/Tooltip';

interface TokenUsageDisplayProps {
    usage: RunUsage;
    cost?: number;
    showDetails?: boolean;
}

/**
 * Displays usage statistics for a completed agent run.
 * Shows an icon with optional token/cost summary, with full details in tooltip.
 */
export const TokenUsageDisplay: React.FC<TokenUsageDisplayProps> = ({ usage, cost, showDetails = false }) => {
    // Format cost as currency
    const formatCost = (cost: number) => {
        if (cost < 0.01) {
            return `$${cost.toFixed(4)}`;
        }
        return `$${cost.toFixed(2)}`;
    };

    // Format token count
    const formatTokens = (count: number) => {
        if (count >= 1000) {
            return `${(count / 1000).toFixed(1)}k`;
        }
        return count.toString();
    };

    const totalTokens = usage.input_tokens + usage.output_tokens;
    const summaryText = cost !== undefined 
        ? `${formatTokens(totalTokens)} tokens • ${formatCost(cost)}`
        : `${formatTokens(totalTokens)} tokens`;

    const tooltipContent = (
        <div className="display-flex flex-col gap-1 text-sm min-w-[140px]">
            <div className="display-flex justify-between gap-4">
                <span className="font-color-secondary">Input tokens:</span>
                <span>{formatTokens(usage.input_tokens)}</span>
            </div>
            <div className="display-flex justify-between gap-4">
                <span className="font-color-secondary">Output tokens:</span>
                <span>{formatTokens(usage.output_tokens)}</span>
            </div>
            {usage.cache_read_tokens > 0 && (
                <div className="display-flex justify-between gap-4">
                    <span className="font-color-secondary">Cache read:</span>
                    <span>{formatTokens(usage.cache_read_tokens)}</span>
                </div>
            )}
            {usage.cache_write_tokens > 0 && (
                <div className="display-flex justify-between gap-4">
                    <span className="font-color-secondary">Cache write:</span>
                    <span>{formatTokens(usage.cache_write_tokens)}</span>
                </div>
            )}
            {/* <div className="display-flex justify-between gap-4">
                <span className="font-color-secondary">Requests:</span>
                <span>{usage.requests}</span>
            </div>
            <div className="display-flex justify-between gap-4">
                <span className="font-color-secondary">Tool calls:</span>
                <span>{usage.tool_calls}</span>
            </div> */}
            {cost !== undefined && (
                <div className="display-flex justify-between gap-4 font-medium mt-1 pt-1 border-top-quinary">
                    <span>Total cost:</span>
                    <span>{formatCost(cost)}</span>
                </div>
            )}
        </div>
    );

    return (
        <div className="rounded-md flex flex-col min-w-0 px-4">
            <div className="display-flex flex-row py-15">
                <Tooltip
                    content="Usage details"
                    customContent={tooltipContent}
                    showArrow={true}
                >
                    <div className="display-flex flex-row gap-2 items-center opacity-60 cursor-default">
                        <Icon icon={DollarCircleIcon} />
                        {showDetails && (
                            <span className="text-sm">{summaryText}</span>
                        )}
                    </div>
                </Tooltip>
                <div className="flex-1"/>
            </div>
        </div>
    );
};

export default TokenUsageDisplay;

