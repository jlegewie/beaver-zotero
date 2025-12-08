import React, { useState } from 'react';
import { RunUsage } from '../../agents/types';
import Button from '../ui/Button';
import { Icon, ArrowDownIcon, ArrowRightIcon, DatabaseIcon } from '../icons/icons';

interface UsageFooterProps {
    usage: RunUsage;
    cost?: number;
}

/**
 * Displays usage statistics for a completed agent run.
 * Shows token counts and cost in an expandable section.
 */
export const UsageFooter: React.FC<UsageFooterProps> = ({ usage, cost }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isHovered, setIsHovered] = useState(false);

    const toggleExpanded = () => {
        setIsExpanded(!isExpanded);
    };

    const getIcon = () => {
        if (isExpanded) return ArrowDownIcon;
        if (isHovered) return ArrowRightIcon;
        return DatabaseIcon;
    };

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

    return (
        <div
            className={`
                rounded-md flex flex-col min-w-0 px-4
                ${isExpanded ? 'border-popup' : 'border-transparent'}
            `}
        >
            <div
                className={`
                    display-flex flex-row py-15
                    ${isExpanded ? 'border-bottom-quinary bg-senary' : ''}
                `}
                onMouseEnter={() => setIsHovered(true)}
                onMouseLeave={() => setIsHovered(false)}
            >
                <div className="display-flex flex-row flex-1" onClick={toggleExpanded}>
                    <Button
                        variant="ghost-secondary"
                        className="text-base scale-105 w-full min-w-0 align-start text-left opacity-60"
                        style={{ padding: '2px 6px', maxHeight: 'none' }}
                    >
                        <div className="display-flex flex-row px-3 gap-2">
                            <div className={`flex-1 display-flex mt-010 ${isExpanded ? 'font-color-primary' : ''}`}>
                                <Icon icon={getIcon()} />
                            </div>
                            
                            <div className={`display-flex text-sm ${isExpanded ? 'font-color-primary' : ''}`}>
                                {summaryText}
                            </div>
                        </div>
                    </Button>
                    <div className="flex-1"/>
                </div>
            </div>

            {isExpanded && (
                <div className="p-3 text-sm opacity-70">
                    <div className="display-flex flex-col gap-1">
                        <div className="display-flex justify-between">
                            <span>Input tokens:</span>
                            <span>{formatTokens(usage.input_tokens)}</span>
                        </div>
                        <div className="display-flex justify-between">
                            <span>Output tokens:</span>
                            <span>{formatTokens(usage.output_tokens)}</span>
                        </div>
                        {usage.cache_read_tokens > 0 && (
                            <div className="display-flex justify-between">
                                <span>Cache read:</span>
                                <span>{formatTokens(usage.cache_read_tokens)}</span>
                            </div>
                        )}
                        {usage.cache_write_tokens > 0 && (
                            <div className="display-flex justify-between">
                                <span>Cache write:</span>
                                <span>{formatTokens(usage.cache_write_tokens)}</span>
                            </div>
                        )}
                        <div className="display-flex justify-between">
                            <span>Requests:</span>
                            <span>{usage.requests}</span>
                        </div>
                        <div className="display-flex justify-between">
                            <span>Tool calls:</span>
                            <span>{usage.tool_calls}</span>
                        </div>
                        {cost !== undefined && (
                            <div className="display-flex justify-between font-medium mt-1 pt-1 border-top-quinary">
                                <span>Total cost:</span>
                                <span>{formatCost(cost)}</span>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default UsageFooter;

