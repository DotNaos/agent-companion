import SwiftUI

struct SessionListView: View {
    @ObservedObject var model: PhoneAppModel

    var body: some View {
        NavigationStack {
            List {
                Section("Verbindung") {
                    LabeledContent("Laptop") {
                        Text(model.bootstrap?.runner.connectedToRemote == true ? "Online" : "Offline")
                    }
                    LabeledContent("Tunnel") {
                        Text(model.bootstrap?.desktop.tunnelRunning == true ? "Aktiv" : "Aus")
                    }
                    if let url = model.bootstrap?.desktop.publicAdminUrl {
                        Text(url)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                Section {
                    Button("Neue Pluto-Session starten") {
                        Task {
                            await model.createSession()
                        }
                    }
                }

                Section("Pluto-Sessions") {
                    if model.sessions.isEmpty {
                        Text("Noch keine Sessions. Starte eine neue Pluto-Session auf dem iPhone oder Desktop.")
                            .foregroundStyle(.secondary)
                    }

                    ForEach(model.sessions) { session in
                        NavigationLink(value: session) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text(session.title ?? "Unbenannte Pluto-Session")
                                    .font(.headline)
                                Text(session.status.capitalized)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Pluto")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Trennen") {
                        model.clearSession()
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            await model.reloadAll()
                        }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .navigationDestination(for: PlutoSessionSummary.self) { session in
                SessionDetailView(model: model, session: session)
                    .task {
                        await model.loadHistory(sessionId: session.id)
                    }
            }
        }
    }
}
