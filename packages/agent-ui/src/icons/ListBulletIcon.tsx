import React from "react";

type ListBulletIconProps = React.SVGProps<SVGSVGElement>;

const ListBulletIcon: React.FC<ListBulletIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
        <path d="M8 5L20 5" />
        <path d="M4 5H4.00898" strokeWidth="2" />
        <path d="M4 12H4.00898" strokeWidth="2" />
        <path d="M4 19H4.00898" strokeWidth="2" />
        <path d="M8 12L20 12" />
        <path d="M8 19L20 19" />
    </svg>
);

export default ListBulletIcon;
