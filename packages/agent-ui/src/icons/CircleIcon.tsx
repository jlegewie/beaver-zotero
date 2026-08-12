import React from "react";

type CircleIconProps = React.SVGProps<SVGSVGElement>;

const CircleIcon: React.FC<CircleIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <circle cx="12" cy="12" r="10"></circle>
    </svg>
);

export default CircleIcon;