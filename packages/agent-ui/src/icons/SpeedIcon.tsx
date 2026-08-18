import React from "react";

type SpeedIconProps = React.SVGProps<SVGSVGElement>;

const SpeedIcon: React.FC<SpeedIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
        <circle cx="12" cy="18" r="3" />
        <path d="M12 15V10" />
        <path d="M22 13C22 7.47715 17.5228 3 12 3C6.47715 3 2 7.47715 2 13" />
    </svg>
);

export default SpeedIcon;