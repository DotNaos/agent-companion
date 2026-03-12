import SwiftUI

@main
struct PlutoPhoneApp: App {
    @StateObject private var model = PhoneAppModel()

    var body: some Scene {
        WindowGroup {
            Group {
                if model.hasSession {
                    SessionListView(model: model)
                } else {
                    NavigationStack {
                        PairingView(model: model)
                    }
                }
            }
            .task {
                await model.restoreSessionIfPossible()
            }
            .overlay(alignment: .bottom) {
                if let errorMessage = model.errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(.white)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(.red.opacity(0.9), in: Capsule())
                        .padding()
                }
            }
        }
    }
}
