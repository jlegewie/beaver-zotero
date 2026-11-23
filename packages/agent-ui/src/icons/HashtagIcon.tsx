import React from "react";

type HashtagIconProps = React.SVGProps<SVGSVGElement>;

const HashtagIcon: React.FC<HashtagIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M10 3L7 21" />
        <path d="M17 3L14 21" />
        <path d="M21 8H4" />
        <path d="M20 16H3" />
    </svg>
);

export default HashtagIcon;
