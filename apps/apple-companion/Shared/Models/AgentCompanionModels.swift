import Foundation

struct MobileAuthExchangeRequest: Codable {
    struct Device: Codable {
        let label: String
        let platform: String
    }

    let code: String
    let device: Device
}

struct MobileDevice: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let label: String
    let platform: String?
    let createdAt: String
    let lastSeenAt: String
    let revokedAt: String?
}

struct MobileAuthSession: Codable, Equatable {
    let accessToken: String
    let expiresAt: String
    let device: MobileDevice
}

struct RunnerStatus: Codable, Equatable, Hashable {
    let connectedToRemote: Bool
    let lastSeenAt: String?
    let pendingApprovals: Int
    let runningProcesses: Int
}

struct PlutoMessage: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let source: String
    let delivery: String
    let tone: String
    let title: String?
    let text: String
    let createdAt: String
    let expiresAt: String?
    let audioAvailable: Bool
}

struct PlutoState: Codable, Equatable, Hashable {
    let available: Bool
    let muted: Bool
    let autoCommentaryEnabled: Bool
    let commentaryIntervalMs: Int
    let model: String
    let pending: Bool
    let lastError: String?
    let activeMessage: PlutoMessage?
    let history: [PlutoMessage]
}

struct PlutoSessionHost: Codable, Equatable, Hashable {
    let id: String
    let type: String
    let label: String
}

struct PlutoSessionSummary: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let title: String?
    let host: PlutoSessionHost
    let status: String
    let model: String
    let createdAt: String
    let lastActivityAt: String
    let ownerClientId: String?
    let speakerClientId: String?
}

struct MobileDesktopStatus: Codable, Equatable, Hashable {
    let runnerRunning: Bool
    let tunnelRunning: Bool
    let publicAdminUrl: String?
    let publicMcpUrl: String?
}

struct MobileBootstrap: Codable, Equatable, Hashable {
    let runner: RunnerStatus
    let pluto: PlutoState
    let plutoVoiceSessions: [PlutoSessionSummary]
    let desktop: MobileDesktopStatus
}

struct PlutoVoiceSessionClient: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let label: String
    let platform: String?
    let joinedAt: String
    let lastSeenAt: String
    let canSendAudio: Bool
    let canReceiveAudio: Bool
    let canObserve: Bool
}

struct PlutoVoiceSession: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let title: String?
    let host: PlutoSessionHost
    let status: String
    let model: String
    let createdAt: String
    let lastActivityAt: String
    let ownerClientId: String?
    let speakerClientId: String?
    let clients: [PlutoVoiceSessionClient]
}

struct PlutoVoiceSessionCreateClientRequest: Codable {
    let label: String
    let platform: String
    let requestedRole: String
    let canReceiveAudio: Bool
    let canObserve: Bool

    init(
        label: String,
        platform: String,
        requestedRole: String = "speaker",
        canReceiveAudio: Bool = true,
        canObserve: Bool = true
    ) {
        self.label = label
        self.platform = platform
        self.requestedRole = requestedRole
        self.canReceiveAudio = canReceiveAudio
        self.canObserve = canObserve
    }
}

struct PlutoVoiceSessionCreateRequest: Codable {
    let title: String?
    let client: PlutoVoiceSessionCreateClientRequest?
}

struct PlutoVoiceSessionCreateResponse: Codable {
    let session: PlutoVoiceSession
    let client: PlutoVoiceSessionClient?
}

struct PlutoVoiceSessionAttachRequest: Codable {
    let label: String
    let platform: String
    let requestedRole: String
    let canReceiveAudio: Bool
    let canObserve: Bool

    init(
        label: String,
        platform: String,
        requestedRole: String = "speaker",
        canReceiveAudio: Bool = true,
        canObserve: Bool = true
    ) {
        self.label = label
        self.platform = platform
        self.requestedRole = requestedRole
        self.canReceiveAudio = canReceiveAudio
        self.canObserve = canObserve
    }
}

struct PlutoVoiceSessionAttachResponse: Codable {
    let session: PlutoVoiceSession
    let client: PlutoVoiceSessionClient
}

struct PlutoVoiceSessionHistoryResponse: Codable, Equatable, Hashable {
    let sessionId: String
    let entries: [PlutoHistoryEntry]
}

enum PlutoHistoryEntry: Codable, Identifiable, Equatable, Hashable {
    case textInput(PlutoTextInputEntry)
    case message(PlutoMessageEntry)
    case streamEvent(PlutoStreamEventHistoryEntry)

    enum CodingKeys: String, CodingKey {
        case kind
    }

    var id: String {
        switch self {
        case .textInput(let entry):
            return entry.id
        case .message(let entry):
            return entry.id
        case .streamEvent(let entry):
            return entry.id
        }
    }

    var createdAt: String {
        switch self {
        case .textInput(let entry):
            return entry.createdAt
        case .message(let entry):
            return entry.createdAt
        case .streamEvent(let entry):
            return entry.createdAt
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "text_input":
            self = .textInput(try PlutoTextInputEntry(from: decoder))
        case "message":
            self = .message(try PlutoMessageEntry(from: decoder))
        case "stream_event":
            self = .streamEvent(try PlutoStreamEventHistoryEntry(from: decoder))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown history entry kind")
        }
    }

    func encode(to encoder: Encoder) throws {
        switch self {
        case .textInput(let entry):
            try entry.encode(to: encoder)
        case .message(let entry):
            try entry.encode(to: encoder)
        case .streamEvent(let entry):
            try entry.encode(to: encoder)
        }
    }
}

struct PlutoTextInputEntry: Codable, Identifiable, Equatable, Hashable {
    let kind: String
    let id: String
    let sessionId: String
    let createdAt: String
    let clientId: String
    let text: String
}

struct PlutoMessageEntry: Codable, Identifiable, Equatable, Hashable {
    let kind: String
    let id: String
    let sessionId: String
    let createdAt: String
    let message: PlutoMessage
}

struct PlutoStreamEventHistoryEntry: Codable, Identifiable, Equatable, Hashable {
    let kind: String
    let id: String
    let sessionId: String
    let createdAt: String
    let event: PlutoPersistedStreamEvent
}

struct PlutoPersistedStreamEvent: Codable, Equatable, Hashable {
    let type: String
    let text: String?
    let turnId: Int?
    let toolName: String?
    let summary: String?
    let ok: Bool?
    let approvalId: String?
    let decision: String?
    let status: String?
    let waitingForInput: Bool?
    let interrupted: Bool?
    let code: String?
    let message: String?
    let reason: String?
}

struct PlutoSessionsResponse: Codable {
    let sessions: [PlutoSessionSummary]
}
