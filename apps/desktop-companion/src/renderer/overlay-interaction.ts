const INTERACTIVE_OVERLAY_SELECTOR =
    '.pluto-hit-target, .pet-bubble:not(.passive)';

interface ClosestCapable {
    closest(selector: string): unknown;
}

export function isOverlayInteractiveTarget(target: EventTarget | null) {
    if (!target || typeof target !== 'object') {
        return false;
    }

    if (!("closest" in target)) {
        return false;
    }

    const closest = (target as ClosestCapable).closest;
    if (typeof closest !== 'function') {
        return false;
    }

    return Boolean(closest.call(target, INTERACTIVE_OVERLAY_SELECTOR));
}
