import React from "react";

type UndoIconProps = React.SVGProps<SVGSVGElement>;

const UndoIcon: React.FC<UndoIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M3 8H15C18.3137 8 21 10.6863 21 14C21 17.3137 18.3137 20 15 20H11" />
        <path d="M7 4L5.8462 4.87652C3.94873 6.31801 3 7.03875 3 8C3 8.96125 3.94873 9.68199 5.8462 11.1235L7 12" />
    </svg>
);

export default UndoIcon;