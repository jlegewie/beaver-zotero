import type { PageGeometry } from "../../beaver-extract/types";
import {
    CoordOrigin,
    type BoundingBox,
} from "../../../react/types/citations";

type TopLeftBox = { l: number; t: number; r: number; b: number };

function isUsableRect(rect: number[]): boolean {
    return (
        Array.isArray(rect) &&
        rect.length === 4 &&
        !rect.some((value) => !Number.isFinite(value))
    );
}

/**
 * Convert a top-left bbox in Beaver Extract's public display page frame to a Zotero
 * annotation rect in unrotated PDF user space (`[left, bottom, right, top]`).
 */
export function sourceBboxToZoteroRect(
    bbox: TopLeftBox,
    geometry: PageGeometry,
): number[] {
    const dx = geometry.viewBox[0];
    const dy = geometry.viewBox[1];
    let l: number;
    let r: number;
    let bottom: number;
    let top: number;
    switch (geometry.rotation) {
        case 90:
            l = bbox.t + dx;
            r = bbox.b + dx;
            bottom = bbox.l + dy;
            top = bbox.r + dy;
            break;
        case 180:
            l = geometry.width - bbox.r + dx;
            r = geometry.width - bbox.l + dx;
            bottom = bbox.t + dy;
            top = bbox.b + dy;
            break;
        case 270:
            l = geometry.width - bbox.b + dx;
            r = geometry.width - bbox.t + dx;
            bottom = geometry.height - bbox.r + dy;
            top = geometry.height - bbox.l + dy;
            break;
        case 0:
        default:
            l = bbox.l + dx;
            r = bbox.r + dx;
            bottom = geometry.height - bbox.b + dy;
            top = geometry.height - bbox.t + dy;
            break;
    }
    return [l, bottom, r, top];
}

/**
 * Convert extracted highlight bboxes into Zotero annotation rects.
 * Explicit bottom-left input follows Beaver's legacy annotation pipeline:
 * bottom-left PDF coordinates are rotated into Zotero's stored user space.
 */
export function sourceBboxesToZoteroRects(
    boxes: BoundingBox[],
    geometry: PageGeometry,
): number[][] {
    return boxes
        .map((box) => box.coord_origin === CoordOrigin.BOTTOMLEFT
            ? legacyBottomLeftBoxToZoteroRect(box, geometry)
            : sourceBboxToZoteroRect({ l: box.l, t: box.t, r: box.r, b: box.b }, geometry))
        .filter(isUsableRect);
}

/**
 * Convert a top-left bbox in the rendered display frame to a Zotero annotation
 * rect in unrotated PDF user space.
 */
export function displayBoxToZoteroRect(
    bbox: TopLeftBox,
    geometry: PageGeometry,
): number[] {
    const dx = geometry.viewBox[0];
    const dy = geometry.viewBox[1];
    let l: number;
    let r: number;
    let bottom: number;
    let top: number;
    switch (geometry.rotation) {
        case 90:
            l = bbox.t + dx;
            r = bbox.b + dx;
            bottom = bbox.l + dy;
            top = bbox.r + dy;
            break;
        case 180:
            l = geometry.width - bbox.r + dx;
            r = geometry.width - bbox.l + dx;
            bottom = bbox.t + dy;
            top = bbox.b + dy;
            break;
        case 270:
            l = geometry.width - bbox.b + dx;
            r = geometry.width - bbox.t + dx;
            bottom = geometry.height - bbox.r + dy;
            top = geometry.height - bbox.l + dy;
            break;
        case 0:
        default:
            l = bbox.l + dx;
            r = bbox.r + dx;
            bottom = geometry.height - bbox.b + dy;
            top = geometry.height - bbox.t + dy;
            break;
    }
    return [l, bottom, r, top];
}

function legacyBottomLeftBoxToZoteroRect(
    bbox: BoundingBox,
    geometry: PageGeometry,
): number[] {
    const dx = geometry.viewBox[0];
    const dy = geometry.viewBox[1];
    let l: number;
    let r: number;
    let bottom: number;
    let top: number;
    switch (geometry.rotation) {
        case 90:
            l = geometry.width - bbox.t + dx;
            r = geometry.width - bbox.b + dx;
            bottom = bbox.l + dy;
            top = bbox.r + dy;
            break;
        case 180:
            l = geometry.width - bbox.r + dx;
            r = geometry.width - bbox.l + dx;
            bottom = geometry.height - bbox.t + dy;
            top = geometry.height - bbox.b + dy;
            break;
        case 270:
            l = bbox.b + dx;
            r = bbox.t + dx;
            bottom = geometry.height - bbox.r + dy;
            top = geometry.height - bbox.l + dy;
            break;
        case 0:
        default:
            l = bbox.l + dx;
            r = bbox.r + dx;
            bottom = bbox.b + dy;
            top = bbox.t + dy;
            break;
    }
    return [l, bottom, r, top];
}
