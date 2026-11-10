import React from 'react';
import { AlertIcon, Icon } from '../../../components/icons/icons';

/**
 * What changed since a proposal whose apply was refused, shown in the
 * expanded card. The collapsed card only says "Changed since proposed".
 */
export const StaleProposalNote: React.FC<{ detail: string; className?: string }> = ({ detail, className = 'px-3 pt-2' }) => (
    <div className={`display-flex flex-row items-start gap-2 text-sm font-color-secondary ${className}`} role="status">
        <Icon icon={AlertIcon} className="font-color-orange flex-shrink-0 mt-010" />
        <span>{detail}</span>
    </div>
);
