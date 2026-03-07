# Desktop Companion

## Purpose

The Electron app is the local user-facing control plane for `agent-companion`. It keeps the user in the loop while the local runner executes remote MCP requests.

## Tray Behavior

The tray menu exposes:

- show dashboard
- show or hide the floating overlay
- start or stop `cloudflared`
- quit the companion

## Floating Companion

The overlay is a pinned corner window that shows:

- runner connectivity
- tunnel status
- pending approval count
- recent activity messages

It is meant to stay visible while the user works.

## Permission Management UI

The dashboard manages:

- `projectsRoot`
- manual allowed paths
- per-path capability flags
- allowed repo tasks
- allowed dev-server tasks
- `run_command` rules
- remote admin allowed origins

## Approval Dialogs

When a pending approval arrives, the Electron process shows a native dialog with:

- approve once
- deny
- open dashboard

The dashboard and remote admin UI both show the full approval queue and can persist remembered permissions.

## Activity and User-Facing Messages

The dashboard and overlay surface:

- auth events
- tool calls
- file writes
- process lifecycle
- command execution attempts
- approval events

## Relationship To The Remote Admin UI

The remote admin UI is not a separate product. It is the same local control surface served by the desktop companion on `127.0.0.1:4318` and exposed through the tunnel for secondary-device access.
