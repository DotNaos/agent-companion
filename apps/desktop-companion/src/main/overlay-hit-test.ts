import type { Rectangle } from 'electron';

const AVATAR_SIZE = 220;
const AVATAR_OFFSET_RIGHT = 12;
const AVATAR_OFFSET_BOTTOM = 8;
const AVATAR_CLICK_RADIUS = 112;

export function isPointInsidePlutoAvatar(
    bounds: Rectangle,
    point: { x: number; y: number },
) {
    const centerX =
        bounds.x + bounds.width - AVATAR_OFFSET_RIGHT - AVATAR_SIZE / 2;
    const centerY =
        bounds.y + bounds.height - AVATAR_OFFSET_BOTTOM - AVATAR_SIZE / 2;
    const distance = Math.hypot(point.x - centerX, point.y - centerY);

    return distance <= AVATAR_CLICK_RADIUS;
}

export function shouldOverlayIgnoreMouseEvents(options: {
    bounds: Rectangle;
    cursorPoint: { x: number; y: number };
    hasApprovalBubble: boolean;
}) {
    if (options.hasApprovalBubble) {
        return false;
    }

    return !isPointInsidePlutoAvatar(options.bounds, options.cursorPoint);
}
