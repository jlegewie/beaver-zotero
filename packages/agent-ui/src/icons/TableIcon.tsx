import React from "react";

type TableIconProps = React.SVGProps<SVGSVGElement>;

const TableIcon: React.FC<TableIconProps> = (props) => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width={24} height={24} color="currentColor" fill="none" stroke="currentColor" strokeWidth="1.5" {...props}>
        <path d="M3.89124 20.1088C2.5 18.7175 2.5 16.4783 2.5 12C2.5 7.52166 2.5 5.28249 3.89124 3.89124C5.28249 2.5 7.52166 2.5 12 2.5C16.4783 2.5 18.7175 2.5 20.1088 3.89124C21.5 5.28249 21.5 7.52166 21.5 12C21.5 16.4783 21.5 18.7175 20.1088 20.1088C18.7175 21.5 16.4783 21.5 12 21.5C7.52166 21.5 5.28249 21.5 3.89124 20.1088Z" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M2.5 9L21.5 9" />
        <path d="M2.5 13L21.5 13" />
        <path d="M2.5 17L21.5 17" />
        <path d="M12 21.5L12 9" strokeLinecap="round" />
    </svg>
);

export default TableIcon;