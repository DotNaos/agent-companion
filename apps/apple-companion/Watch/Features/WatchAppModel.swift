import Combine
import Foundation

@MainActor
final class WatchAppModel: ObservableObject {
    @Published var bridgeStatus = "Noch nicht verbunden"
    @Published var isRecordingAudio = false
    @Published var isPlayingAudio = false
    @Published var sessionCount = 0
    @Published var lastEventType = ""
    @Published var lastError = ""

    let bridge = WatchBridgeSession()
    private var cancellables = Set<AnyCancellable>()

    init() {
        bridge.$activationStateDescription
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.bridgeStatus = $0 }
            .store(in: &cancellables)

        bridge.$lastPayload
            .receive(on: RunLoop.main)
            .sink { [weak self] payload in
                self?.sessionCount = payload["sessionCount"] as? Int ?? 0
                self?.lastEventType = payload["lastEventType"] as? String ?? ""
                self?.lastError = payload["lastError"] as? String ?? ""
                self?.isRecordingAudio = payload["isRecordingAudio"] as? Bool ?? false
                self?.isPlayingAudio = payload["isPlayingAudio"] as? Bool ?? false
            }
            .store(in: &cancellables)
    }

    func start() {
        bridge.activate()
    }

    func requestVoiceStart() {
        bridge.send(command: "start-voice")
    }

    func requestVoiceStop() {
        bridge.send(command: "stop-voice")
    }
}
