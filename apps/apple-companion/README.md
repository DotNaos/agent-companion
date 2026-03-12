# Apple Companion

Native Apple client scaffold for `agent-companion`.

## Included in this slice

- iPhone SwiftUI app scaffold
- watchOS SwiftUI companion scaffold
- shared Swift networking, models, token storage, and Pluto voice socket helpers
- XcodeGen project definition for generating a real `.xcodeproj`

## Current scope

This scaffold is wired for:

- pairing against `/api/mobile/auth/exchange`
- loading mobile bootstrap data
- listing Pluto sessions
- creating Pluto sessions
- loading per-session history
- opening the Pluto voice websocket and sending control / text messages

The watch app is currently a thin shell that is ready to evolve into the iPhone-bridged Pluto voice companion discussed in the implementation plan.

## Generate the project

```bash
cd apps/apple-companion
xcodegen generate
```

Then open `PlutoAppleCompanion.xcodeproj` in Xcode.

## Install on your Apple Watch

Current status in this repo:

- the paired Apple Watch is visible to Xcode tooling
- the Xcode project is valid and lists `PlutoWatch`
- the immediate blocker is a missing local `watchOS 26.2` platform component on this Mac

Before deploying to the physical watch:

1. Open Xcode
2. Go to `Xcode > Settings > Components`
3. Install the required `watchOS 26.2` platform/support files
4. Open `PlutoAppleCompanion.xcodeproj`
5. Select the `PlutoWatch` scheme
6. Choose your Apple Watch as the run destination
7. In Signing, pick your personal/team account if Xcode asks for it
8. Run the app

The project definition already uses automatic signing and separate bundle identifiers for phone and watch targets, so once the missing watchOS platform is installed, the next likely step is just selecting your team and deploying.
