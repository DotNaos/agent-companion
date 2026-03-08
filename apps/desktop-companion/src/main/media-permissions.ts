export type MediaPermissionRequestDetails = {
  mediaTypes?: string[];
  requestingUrl: string;
};

export function shouldAllowMediaPermission(
  permission: string,
  details: MediaPermissionRequestDetails,
) {
  if (permission !== "media") {
    return false;
  }

  if (!details.mediaTypes?.includes("audio")) {
    return false;
  }

  return isTrustedDesktopRendererUrl(details.requestingUrl);
}

export function isTrustedDesktopRendererUrl(url: string) {
  try {
    const parsed = new URL(url);
    const isLoopbackHost =
      parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";

    return (
      isLoopbackHost &&
      (parsed.protocol === "http:" || parsed.protocol === "https:")
    );
  } catch {
    return false;
  }
}
