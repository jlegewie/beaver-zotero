// Copy of /zotero/chrome/content/zotero/components/icons.jsx (converted to TypeScript)
'use strict';

import React from 'react';

interface IconProps extends React.HTMLAttributes<HTMLSpanElement> {
    name?: string;
    className?: string;
    style?: React.CSSProperties;
    children?: React.ReactElement;
}

const Icon: React.FC<IconProps> = ({ name, className = "", ...rest }) => {
    return <span className={`icon icon-${name} ${className}`} {...rest} />;
};

type CSSIconProps = IconProps;

const CSSIcon: React.FC<CSSIconProps> = ({ name, className = "", ...rest }) => {
    return <span className={`icon icon-css icon-${name} ${className}`} {...rest} />;
};

interface CSSItemTypeIconProps extends Omit<IconProps, 'name'> {
    itemType?: string;
}

const CSSItemTypeIcon: React.FC<CSSItemTypeIconProps> = ({ itemType, ...rest }) => {
    return <CSSIcon name="item-type" data-item-type={itemType} {...rest} />;
};

const IconAttachSmall: React.FC<Omit<IconProps, 'name'>> = (props) => 
    <CSSIcon name="attachment" className="icon-16" {...props} />;

const IconTreeitemNoteSmall: React.FC<Omit<IconProps, 'name'>> = (props) => 
    <CSSIcon name="note" className="icon-16" {...props} />;

export {
    Icon,
    CSSIcon,
    CSSItemTypeIcon,
    IconAttachSmall,
    IconTreeitemNoteSmall
}; 