import SwiftUI

struct SessionDetailView: View {
    @ObservedObject var model: PhoneAppModel
    let session: PlutoSessionSummary

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.title ?? "Pluto-Session")
                        .font(.title3.bold())
                    Text("Status: \(session.status)")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Button(model.connectedSessionId == session.id ? "Trennen" : "Voice verbinden") {
                    Task {
                        if model.connectedSessionId == session.id {
                            await model.disconnectVoice()
                        } else {
                            await model.connectVoice(sessionId: session.id)
                        }
                    }
                }
                .buttonStyle(.borderedProminent)
            }

            HStack(spacing: 12) {
                Button(model.isRecordingAudio ? "Mikro stoppen" : "Mikro starten") {
                    Task {
                        if model.isRecordingAudio {
                            await model.stopMicrophone()
                        } else {
                            await model.connectVoice(sessionId: session.id)
                            await model.startMicrophone()
                        }
                    }
                }
                .buttonStyle(.bordered)
                .disabled(model.connectedSessionId != nil && model.connectedSessionId != session.id)

                if model.isPlayingAudio {
                    Label("Pluto spricht", systemImage: "speaker.wave.2.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if model.isRecordingAudio {
                    Label("Mikro aktiv", systemImage: "mic.fill")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            List {
                Section("History") {
                    if let history = model.selectedSessionHistory, history.sessionId == session.id {
                        ForEach(history.entries) { entry in
                            HistoryRow(entry: entry)
                        }
                    } else {
                        Text("Noch keine Session-History geladen.")
                            .foregroundStyle(.secondary)
                    }
                }

                Section("Live Stream") {
                    if model.streamEvents.isEmpty {
                        Text("Noch keine Live-Events. Verbinde den Voice-Stream oder sende Text.")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(model.streamEvents) { event in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(event.type)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(event.text ?? event.message ?? event.status ?? "Event empfangen")
                        }
                    }
                }
            }

            HStack(spacing: 12) {
                TextField("Text an Pluto senden", text: $model.draftText, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                Button("Senden") {
                    Task {
                        await model.sendDraftText()
                        await model.loadHistory(sessionId: session.id)
                    }
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .navigationTitle("Session")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct HistoryRow: View {
    let entry: PlutoHistoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(bodyText)
                .font(.body)
        }
        .padding(.vertical, 4)
    }

    private var title: String {
        switch entry {
        case .textInput:
            return "Du"
        case .message:
            return "Pluto Nachricht"
        case .streamEvent(let entry):
            return entry.event.type
        }
    }

    private var bodyText: String {
        switch entry {
        case .textInput(let entry):
            return entry.text
        case .message(let entry):
            return entry.message.text
        case .streamEvent(let entry):
            return entry.event.text
                ?? entry.event.message
                ?? entry.event.summary
                ?? entry.event.status
                ?? entry.event.reason
                ?? "Stream-Ereignis"
        }
    }
}
