import Foundation

struct PlutoVoiceStreamEvent: Decodable, Identifiable, Equatable {
    let id: UUID
    let type: String
    let text: String?
    let turnId: Int?
    let audioBase64: String?
    let mimeType: String?
    let status: String?
    let code: String?
    let message: String?
    let session: PlutoVoiceSession?

    enum CodingKeys: String, CodingKey {
        case type
        case text
        case turnId
        case audioBase64
        case mimeType
        case status
        case code
        case message
        case session
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = UUID()
        type = try container.decode(String.self, forKey: .type)
        text = try container.decodeIfPresent(String.self, forKey: .text)
        turnId = try container.decodeIfPresent(Int.self, forKey: .turnId)
        audioBase64 = try container.decodeIfPresent(String.self, forKey: .audioBase64)
        mimeType = try container.decodeIfPresent(String.self, forKey: .mimeType)
        status = try container.decodeIfPresent(String.self, forKey: .status)
        code = try container.decodeIfPresent(String.self, forKey: .code)
        message = try container.decodeIfPresent(String.self, forKey: .message)
        session = try container.decodeIfPresent(PlutoVoiceSession.self, forKey: .session)
    }
}

@MainActor
final class PlutoVoiceSocket {
    private let decoder = JSONDecoder()
    private var task: URLSessionWebSocketTask?

    var onEvent: ((PlutoVoiceStreamEvent) -> Void)?
    var onDisconnect: ((Error?) -> Void)?

    func connect(baseURL: URL, accessToken: String, sessionId: String) {
        disconnect()
        var request = URLRequest(url: baseURL.appending(path: "/api/mobile/pluto/sessions/\(sessionId)/stream"))
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        let webSocketTask = URLSession.shared.webSocketTask(with: request)
        task = webSocketTask
        webSocketTask.resume()
        receiveNextMessage(from: webSocketTask)
    }

    func disconnect() {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }

    func sendPing() async throws {
        try await send(json: ["type": "ping"])
    }

    func sendTextInput(clientId: String, text: String) async throws {
        try await send(json: [
            "type": "text_input",
            "input": [
                "clientId": clientId,
                "text": text,
            ],
        ])
    }

    func sendAudioChunk(clientId: String, audioBase64: String, mimeType: String = "audio/pcm;rate=16000") async throws {
        try await send(json: [
            "type": "audio_chunk",
            "chunk": [
                "clientId": clientId,
                "audioBase64": audioBase64,
                "mimeType": mimeType,
            ],
        ])
    }

    func endAudioStream(clientId: String) async throws {
        try await send(json: [
            "type": "audio_stream_end",
            "clientId": clientId,
        ])
    }

    private func send(json: [String: Any]) async throws {
        guard let task else {
            throw PlutoVoiceSocketError.notConnected
        }
        let data = try JSONSerialization.data(withJSONObject: json)
        guard let string = String(data: data, encoding: .utf8) else {
            throw PlutoVoiceSocketError.invalidPayload
        }
        try await task.send(.string(string))
    }

    private func receiveNextMessage(from task: URLSessionWebSocketTask) {
        task.receive { [weak self, weak task] result in
            Task { @MainActor [weak self, weak task] in
                guard let self, let task, self.task === task else {
                    return
                }

                switch result {
                case .failure(let error):
                    self.onDisconnect?(error)
                case .success(let message):
                    let data: Data?
                    switch message {
                    case .data(let payload):
                        data = payload
                    case .string(let string):
                        data = string.data(using: .utf8)
                    @unknown default:
                        data = nil
                    }

                    if let data, let event = try? self.decoder.decode(PlutoVoiceStreamEvent.self, from: data) {
                        self.onEvent?(event)
                    }
                    self.receiveNextMessage(from: task)
                }
            }
        }
    }
}

enum PlutoVoiceSocketError: LocalizedError {
    case notConnected
    case invalidPayload

    var errorDescription: String? {
        switch self {
        case .notConnected:
            return "Pluto voice stream is not connected."
        case .invalidPayload:
            return "Failed to encode the Pluto voice message."
        }
    }
}
