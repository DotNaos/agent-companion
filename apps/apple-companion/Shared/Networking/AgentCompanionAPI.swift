import Foundation

actor AgentCompanionAPI {
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder

    init() {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .useDefaultKeys
        self.decoder = decoder

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        self.encoder = encoder
    }

    func exchangePairingCode(baseURL: URL, request: MobileAuthExchangeRequest) async throws -> MobileAuthSession {
        try await performRequest(
            url: baseURL.appending(path: "/api/mobile/auth/exchange"),
            method: "POST",
            body: request,
            accessToken: nil,
            responseType: MobileAuthSession.self
        )
    }

    func fetchBootstrap(baseURL: URL, accessToken: String) async throws -> MobileBootstrap {
        try await performRequest(
            url: baseURL.appending(path: "/api/mobile/bootstrap"),
            method: "GET",
            body: Optional<String>.none,
            accessToken: accessToken,
            responseType: MobileBootstrap.self
        )
    }

    func listSessions(baseURL: URL, accessToken: String) async throws -> [PlutoSessionSummary] {
        let response: PlutoSessionsResponse = try await performRequest(
            url: baseURL.appending(path: "/api/mobile/pluto/sessions"),
            method: "GET",
            body: Optional<String>.none,
            accessToken: accessToken,
            responseType: PlutoSessionsResponse.self
        )
        return response.sessions
    }

    func createSession(
        baseURL: URL,
        accessToken: String,
        title: String,
        clientLabel: String,
        platform: String = "iOS"
    ) async throws -> PlutoVoiceSessionCreateResponse {
        try await performRequest(
            url: baseURL.appending(path: "/api/mobile/pluto/sessions"),
            method: "POST",
            body: PlutoVoiceSessionCreateRequest(
                title: title,
                client: PlutoVoiceSessionCreateClientRequest(label: clientLabel, platform: platform)
            ),
            accessToken: accessToken,
            responseType: PlutoVoiceSessionCreateResponse.self
        )
    }

    func attachSession(
        baseURL: URL,
        accessToken: String,
        sessionId: String,
        clientLabel: String,
        platform: String = "iOS"
    ) async throws -> PlutoVoiceSessionAttachResponse {
        try await performRequest(
            url: baseURL.appending(path: "/api/mobile/pluto/sessions/\(sessionId)/attach"),
            method: "POST",
            body: PlutoVoiceSessionAttachRequest(label: clientLabel, platform: platform),
            accessToken: accessToken,
            responseType: PlutoVoiceSessionAttachResponse.self
        )
    }

    func fetchSessionHistory(
        baseURL: URL,
        accessToken: String,
        sessionId: String,
        limit: Int = 200
    ) async throws -> PlutoVoiceSessionHistoryResponse {
        var components = URLComponents(url: baseURL.appending(path: "/api/mobile/pluto/sessions/\(sessionId)/history"), resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
        ]
        guard let url = components?.url else {
            throw AgentCompanionAPIError.invalidURL
        }
        return try await performRequest(
            url: url,
            method: "GET",
            body: Optional<String>.none,
            accessToken: accessToken,
            responseType: PlutoVoiceSessionHistoryResponse.self
        )
    }

    private func performRequest<RequestBody: Encodable, ResponseBody: Decodable>(
        url: URL,
        method: String,
        body: RequestBody?,
        accessToken: String?,
        responseType: ResponseBody.Type
    ) async throws -> ResponseBody {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let accessToken, !accessToken.isEmpty {
            request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        }
        if let body {
            request.httpBody = try encoder.encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AgentCompanionAPIError.invalidResponse
        }
        guard (200 ..< 300).contains(httpResponse.statusCode) else {
            let serverMessage = String(data: data, encoding: .utf8) ?? "Unknown server error"
            throw AgentCompanionAPIError.server(statusCode: httpResponse.statusCode, message: serverMessage)
        }
        return try decoder.decode(ResponseBody.self, from: data)
    }
}

enum AgentCompanionAPIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case server(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "The server URL is invalid."
        case .invalidResponse:
            return "The server response was invalid."
        case .server(let statusCode, let message):
            return "Server error \(statusCode): \(message)"
        }
    }
}
