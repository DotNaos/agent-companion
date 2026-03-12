import SwiftUI

@main
struct PlutoWatchApp: App {
    @StateObject private var model = WatchAppModel()

    var body: some Scene {
        WindowGroup {
            WatchRootView(model: model)
                .task {
                    model.start()
                }
        }
    }
}
