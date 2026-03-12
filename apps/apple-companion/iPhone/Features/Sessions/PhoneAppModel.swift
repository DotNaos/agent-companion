import Foundation
import SwiftUI

@MainActor
final class PhoneAppModel: ObservableObject {
    @Published var serverURLText = "http://127.0.0.1:4318"
    @Published var pairingCode = ""
    @Published var bootstrap: MobileBootstrap?
    @Published var sessions: [PlutoSessionSummary] = []
    @Published var selectedSessionHistory: PlutoVoiceSessionHistoryResponse?
    @Published var streamEvents: [PlutoVoiceStreamEvent] = []
    @Published var draftText = ""
    @Published var isBusy = false
    @Published var errorMessage: String?
    @Published var connectedSessionId: String?
    @Published var activeClientId: String?
    @Published var activeClientSessionId: String?
    @Published var selectedSessionId: String?
    @Published var isRecordingAudio = false
    @Published var isPlayingAudio = false
    @Published var pairingServerCandidates: [String] = []

    let sessionStore: MobileSessionStore
    let watchBridge = WatchBridgeSession()
    private let api = AgentCompanionAPI()
    private let voiceSocket = PlutoVoiceSocket()
    private let voiceController = PhoneVoiceController()

    init(sessionStore: MobileSessionStore = MobileSessionStore()) {
        self.sessionStore = sessionStore
        if let saved = sessionStore.savedSession {
            serverURLText = saved.baseURL.absoluteString
        }
        watchBridge.activate()
        watchBridge.onMessage = { [weak self] payload in
            Task { @MainActor [weak self] in
                await self?.handleWatchPayload(payload)
            }
        }

        voiceController.onError = { [weak self] message in
            Task { @MainActor [weak self] in
                self?.errorMessage = message
                self?.publishBridgeState()
            }
        }
        voiceController.onCaptureStateChange = { [weak self] isCapturing in
            Task { @MainActor [weak self] in
                self?.isRecordingAudio = isCapturing
                self?.publishBridgeState()
            }
        }
        voiceController.onPlaybackStateChange = { [weak self] isPlaying in
            Task { @MainActor [weak self] in
                self?.isPlayingAudio = isPlaying
                self?.publishBridgeState()
            }
        }

        voiceSocket.onEvent = { [weak self] event in
            Task { @MainActor [weak self] in
                if event.type == "audio_chunk", let audioBase64 = event.audioBase64, let mimeType = event.mimeType {
                    self?.voiceController.handleIncomingAudioChunk(audioBase64: audioBase64, mimeType: mimeType)
                }
                if event.type == "output_turn_complete" {
                    self?.isPlayingAudio = false
                }
                if let session = event.session {
                    self?.upsertSessionSummary(from: session)
                }
                self?.streamEvents.append(event)
                self?.publishBridgeState()
            }
        }
        voiceSocket.onDisconnect = { [weak self] error in
            Task { @MainActor [weak self] in
                self?.connectedSessionId = nil
                self?.isRecordingAudio = false
                if let error {
                    self?.errorMessage = error.localizedDescription
                }
                self?.publishBridgeState()
            }
        }
    }

    var hasSession: Bool {
        sessionStore.savedSession != nil
    }

    func restoreSessionIfPossible() async {
        guard let saved = sessionStore.savedSession else {
            return
        }
        serverURLText = saved.baseURL.absoluteString
        await reloadAll()
    }

    func pairDevice() async {
        let candidateStrings = orderedPairingServerCandidates()
        guard let primaryCandidate = candidateStrings.first,
              let initialBaseURL = URL(string: primaryCandidate)
        else {
            errorMessage = "Bitte eine gültige Server-URL eingeben."
            return
        }

        isBusy = true
        defer { isBusy = false }

        var lastError: Error?

        for candidate in candidateStrings {
            guard let baseURL = URL(string: candidate) else {
                continue
            }

            do {
                let auth = try await api.exchangePairingCode(
                    baseURL: baseURL,
                    request: MobileAuthExchangeRequest(
                        code: pairingCode,
                        device: .init(label: HostDevice.currentLabel, platform: HostDevice.currentPlatform)
                    )
                )
                sessionStore.save(baseURL: baseURL, auth: auth)
                serverURLText = baseURL.absoluteString
                pairingCode = ""
                pairingServerCandidates = []
                await reloadAll()
                return
            } catch {
                lastError = error
            }
        }

        let fallbackBaseURL = initialBaseURL.absoluteString
        errorMessage = lastError?.localizedDescription ?? "Pairing über \(fallbackBaseURL) ist fehlgeschlagen."
    }

    func applyPairingScan(_ value: String) -> Bool {
        guard let payload = MobilePairingPayload.parse(from: value) else {
            errorMessage = "Der QR-Code enthält kein gültiges Pluto-Pairing."
            return false
        }

        serverURLText = payload.servers.first ?? payload.server
        pairingCode = payload.code
        pairingServerCandidates = payload.servers
        errorMessage = nil
        return true
    }

    func reloadAll() async {
        guard let saved = sessionStore.savedSession else {
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            let bootstrap = try await api.fetchBootstrap(baseURL: saved.baseURL, accessToken: saved.auth.accessToken)
            let sessions = try await api.listSessions(baseURL: saved.baseURL, accessToken: saved.auth.accessToken)
            self.bootstrap = bootstrap
            self.sessions = sessions
            errorMessage = nil
            publishBridgeState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func createSession() async {
        guard let saved = sessionStore.savedSession else {
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            let result = try await api.createSession(
                baseURL: saved.baseURL,
                accessToken: saved.auth.accessToken,
                title: "Pluto on iPhone",
                clientLabel: HostDevice.currentLabel
            )
            activeClientId = result.client?.id
            activeClientSessionId = result.session.id
            selectedSessionId = result.session.id
            await reloadAll()
            await loadHistory(sessionId: result.session.id)
            publishBridgeState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadHistory(sessionId: String) async {
        guard let saved = sessionStore.savedSession else {
            return
        }

        isBusy = true
        defer { isBusy = false }

        do {
            selectedSessionHistory = try await api.fetchSessionHistory(
                baseURL: saved.baseURL,
                accessToken: saved.auth.accessToken,
                sessionId: sessionId
            )
            selectedSessionId = sessionId
            errorMessage = nil
            publishBridgeState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func connectVoice(sessionId: String) async {
        guard let saved = sessionStore.savedSession else {
            return
        }

        do {
            let clientId: String
            if activeClientSessionId == sessionId, let activeClientId {
                clientId = activeClientId
            } else {
                let result = try await api.attachSession(
                    baseURL: saved.baseURL,
                    accessToken: saved.auth.accessToken,
                    sessionId: sessionId,
                    clientLabel: HostDevice.currentLabel
                )
                clientId = result.client.id
                upsertSessionSummary(from: result.session)
            }

            activeClientId = clientId
            activeClientSessionId = sessionId
            selectedSessionId = sessionId
            voiceSocket.connect(baseURL: saved.baseURL, accessToken: saved.auth.accessToken, sessionId: sessionId)
            connectedSessionId = sessionId
            streamEvents = []
            errorMessage = nil
            publishBridgeState()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func disconnectVoice() async {
        await voiceController.stopCapture()
        voiceController.stopPlayback()
        voiceSocket.disconnect()
        connectedSessionId = nil
        isRecordingAudio = false
        isPlayingAudio = false
        publishBridgeState()
    }

    func startMicrophone() async {
        guard let clientId = activeClientId, connectedSessionId != nil else {
            errorMessage = "Verbinde zuerst eine Pluto-Voice-Session."
            return
        }

        do {
            try await voiceController.startCapture(clientId: clientId, socket: voiceSocket)
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        publishBridgeState()
    }

    func stopMicrophone() async {
        await voiceController.stopCapture()
        publishBridgeState()
    }

    func sendDraftText() async {
        guard let clientId = activeClientId else {
            errorMessage = "Kein aktiver Pluto-Client für Texteingabe vorhanden."
            return
        }
        let text = draftText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return
        }
        do {
            try await voiceSocket.sendTextInput(clientId: clientId, text: text)
            draftText = ""
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func clearSession() {
        Task {
            await disconnectVoice()
        }
        sessionStore.clear()
        bootstrap = nil
        sessions = []
        selectedSessionHistory = nil
        streamEvents = []
        activeClientId = nil
        activeClientSessionId = nil
        selectedSessionId = nil
        publishBridgeState()
    }

    private var normalizedBaseURL: URL? {
        URL(string: serverURLText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    private func orderedPairingServerCandidates() -> [String] {
        let manual = serverURLText.trimmingCharacters(in: .whitespacesAndNewlines)
        let values = [manual] + pairingServerCandidates
        var seen = Set<String>()

        return values.filter { value in
            guard !value.isEmpty else {
                return false
            }
            if seen.contains(value) {
                return false
            }
            seen.insert(value)
            return true
        }
    }

    private func publishBridgeState() {
        watchBridge.update(context: [
            "connectedSessionId": connectedSessionId ?? "",
            "selectedSessionId": selectedSessionId ?? "",
            "sessionCount": sessions.count,
            "lastEventType": streamEvents.last?.type ?? "",
            "lastError": errorMessage ?? "",
            "isRecordingAudio": isRecordingAudio,
            "isPlayingAudio": isPlayingAudio,
        ])
    }

    private func upsertSessionSummary(from session: PlutoVoiceSession) {
        let summary = PlutoSessionSummary(
            id: session.id,
            title: session.title,
            host: session.host,
            status: session.status,
            model: session.model,
            createdAt: session.createdAt,
            lastActivityAt: session.lastActivityAt,
            ownerClientId: session.ownerClientId,
            speakerClientId: session.speakerClientId
        )

        if let index = sessions.firstIndex(where: { $0.id == session.id }) {
            sessions[index] = summary
        } else {
            sessions.insert(summary, at: 0)
        }
    }

    private func handleWatchPayload(_ payload: [String: Any]) async {
        guard let command = payload["command"] as? String else {
            return
        }

        switch command {
        case "start-voice":
            if sessions.isEmpty {
                await createSession()
            }
            let targetSessionId = selectedSessionId ?? sessions.first?.id
            guard let targetSessionId else {
                errorMessage = "Keine Pluto-Session für die Watch verfügbar."
                publishBridgeState()
                return
            }
            await connectVoice(sessionId: targetSessionId)
            await startMicrophone()
        case "stop-voice":
            await stopMicrophone()
        default:
            break
        }
    }
}

enum HostDevice {
    static let currentLabel = "Oli iPhone"
    static let currentPlatform = "iOS"
}

private struct MobilePairingPayload {
    let server: String
    let servers: [String]
    let code: String

    static func parse(from rawValue: String) -> MobilePairingPayload? {
        guard let components = URLComponents(string: rawValue),
              components.scheme == "agentcompanion"
        else {
            return nil
        }

        let pathComponent = components.host ?? components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard pathComponent == "pair" else {
            return nil
        }

        let queryItems = components.queryItems ?? []
        let servers = queryItems
            .filter { $0.name == "server" }
            .compactMap(\.value)
            .filter { !$0.isEmpty }
        guard let server = servers.first,
              let code = queryItems.first(where: { $0.name == "code" })?.value,
              !code.isEmpty
        else {
            return nil
        }

        return MobilePairingPayload(server: server, servers: servers, code: code)
    }
}
