import { describe, expect, it } from "vitest";
import {
    isTrustedDesktopRendererUrl,
    shouldAllowMediaPermission,
} from "./media-permissions.js";

describe("isTrustedDesktopRendererUrl", () => {
  it("allows localhost renderer urls", () => {
    expect(
      isTrustedDesktopRendererUrl("http://127.0.0.1:4318/desktop"),
    ).toBe(true);
    expect(
      isTrustedDesktopRendererUrl("http://localhost:5173/overlay"),
    ).toBe(true);
  });

  it("rejects non-loopback urls", () => {
    expect(
      isTrustedDesktopRendererUrl("https://example.com/desktop"),
    ).toBe(false);
  });

  it("rejects malformed urls", () => {
    expect(isTrustedDesktopRendererUrl("not-a-url")).toBe(false);
  });
});

describe("shouldAllowMediaPermission", () => {
  it("allows loopback audio media requests", () => {
    expect(
      shouldAllowMediaPermission("media", {
        mediaTypes: ["audio"],
        requestingUrl: "http://127.0.0.1:4318/desktop",
      }),
    ).toBe(true);
  });

  it("rejects non-audio media requests", () => {
    expect(
      shouldAllowMediaPermission("media", {
        mediaTypes: ["video"],
        requestingUrl: "http://127.0.0.1:4318/desktop",
      }),
    ).toBe(false);
  });

  it("rejects non-media permissions", () => {
    expect(
      shouldAllowMediaPermission("notifications", {
        mediaTypes: ["audio"],
        requestingUrl: "http://127.0.0.1:4318/desktop",
      }),
    ).toBe(false);
  });
});
