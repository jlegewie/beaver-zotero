import React from "react";

type ZapIconProps = React.SVGProps<SVGSVGElement> & {
    size?: number;
};

const ZapIcon: React.FC<ZapIconProps> = ({ size = 24, ...props }) => (
    <svg 
        xmlns="http://www.w3.org/2000/svg" 
        viewBox="0 0 24 24" 
        width={size} 
        height={size} 
        fill="none" 
        stroke="currentColor" 
        strokeWidth="2" 
        strokeLinecap="round" 
        strokeLinejoin="round"
        {...props}
    >
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
);

export default ZapIcon;

