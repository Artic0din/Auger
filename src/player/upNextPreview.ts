// Apple's Up Next page is an HStack: the preview spans the first two cards of the 4 x 360 + 3 x 40 column (180 px in from
// each edge) and the panel follows, so a right-to-left layout puts the preview on the right.
const COLUMN_INSET = 180;

export const UP_NEXT_PREVIEW = { top: 112, width: 760, height: Math.round(760 * 9 / 16) } as const;

/** The preview's left edge on a screen `screenWidth` wide. */
export function upNextPreviewLeft(screenWidth: number, rightToLeft: boolean): number {
    return rightToLeft ? screenWidth - COLUMN_INSET - UP_NEXT_PREVIEW.width : COLUMN_INSET;
}
