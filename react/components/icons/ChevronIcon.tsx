import React from "react";

type ChevronIconProps = React.SVGProps<SVGSVGElement>;

const ChevronIcon: React.FC<ChevronIconProps> = ({ style, ...props }) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ transform: 'rotate(90deg)', ...style }} {...props}>
        <path d="M8.99995 7L6.62858 8.92711C4.87619 10.3512 4 11.0633 4 12C4 12.9367 4.8762 13.6488 6.62859 15.0729L9 17" strokeMiterlimit="16" />
        <path d="M15 7L17.3714 8.92711C19.1238 10.3512 20 11.0633 20 12C20 12.9367 19.1238 13.6488 17.3714 15.0729L15 17" strokeMiterlimit="16" />
    </svg>
);

export default ChevronIcon;