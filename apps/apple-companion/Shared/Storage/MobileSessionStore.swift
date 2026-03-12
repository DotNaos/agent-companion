import Foundation

struct MobileSavedSession: Codable, Equatable {
    var baseURL: URL
    var auth: MobileAuthSession
}

@MainActor
final class MobileSessionStore: ObservableObject {
    @Published private(set) var savedSession: MobileSavedSession?

    private let userDefaults: UserDefaults
    private let storageKey = "agent-companion.mobile-session"

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
        self.savedSession = Self.loadSavedSession(from: userDefaults, key: storageKey)
    }

    func save(baseURL: URL, auth: MobileAuthSession) {
        let session = MobileSavedSession(baseURL: baseURL, auth: auth)
        savedSession = session
        guard let data = try? JSONEncoder().encode(session) else {
            return
        }
        userDefaults.set(data, forKey: storageKey)
    }

    func clear() {
        savedSession = nil
        userDefaults.removeObject(forKey: storageKey)
    }

    private static func loadSavedSession(from defaults: UserDefaults, key: String) -> MobileSavedSession? {
        guard let data = defaults.data(forKey: key) else {
            return nil
        }
        return try? JSONDecoder().decode(MobileSavedSession.self, from: data)
    }
}
