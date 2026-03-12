import SwiftUI

struct WatchRootView: View {
    @ObservedObject var model: WatchAppModel

    var body: some View {
        VStack(spacing: 12) {
            Text("Pluto")
                .font(.headline)
            Text(model.bridgeStatus)
                .font(.caption2)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)

            Text("Sessions: \(model.sessionCount)")
                .font(.caption2)
                .foregroundStyle(.secondary)

            if model.isPlayingAudio {
                Label("Pluto spricht", systemImage: "speaker.wave.2.fill")
                    .font(.caption2)
            }

            if model.isRecordingAudio {
                Label("Mikro aktiv", systemImage: "mic.fill")
                    .font(.caption2)
            }

            Button("Voice starten") {
                model.requestVoiceStart()
            }
            .buttonStyle(.borderedProminent)

            Button("Stop") {
                model.requestVoiceStop()
            }
            .buttonStyle(.bordered)

            if !model.bridge.lastPayload.isEmpty {
                Text("Letzte iPhone-Nachricht empfangen")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if !model.lastEventType.isEmpty {
                Text(model.lastEventType)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            if !model.lastError.isEmpty {
                Text(model.lastError)
                    .font(.caption2)
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.red)
            }
        }
        .padding()
    }
}
