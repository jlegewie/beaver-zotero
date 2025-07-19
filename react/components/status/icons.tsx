import React from "react";
import { CheckmarkCircleIcon, CancelCircleIcon, Icon, Spinner, ThreeIcon, OneIcon, TwoIcon, AlertIcon as AlertIconIcon } from "../icons/icons";


export const CancelIcon = <Icon icon={CancelCircleIcon} className="font-color-red scale-14" />;
export const CheckmarkIcon = <Icon icon={CheckmarkCircleIcon} className="font-color-green scale-14" />;
export const StepOneIcon = <Icon icon={OneIcon} className="font-color-secondary scale-14" />;
export const StepTwoIcon = <Icon icon={TwoIcon} className="font-color-secondary scale-14" />;
export const StepThreeIcon = <Icon icon={ThreeIcon} className="font-color-secondary scale-14" />;
export const SpinnerIcon = <Spinner className="scale-14 -mr-1" />;
export const AlertIcon = <Icon icon={AlertIconIcon} className="font-color-tertiary scale-14" />;
