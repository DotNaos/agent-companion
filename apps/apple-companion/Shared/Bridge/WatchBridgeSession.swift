import Foundation
import WatchConnectivity

final class WatchBridgeSession: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var activationStateDescription = "idle"
    @Published private(set) var lastPayload: [String: Any] = [:]

    var onMessage: (([String: Any]) -> Void)?

    private let session: WCSession? = WCSession.isSupported() ? .default : nil

    override init() {
        super.init()
        session?.delegate = self
    }

    func activate() {
        session?.activate()
    }

    func send(command: String, metadata: [String: Any] = [:]) {
        guard let session else {
            publishActivationState("watch-connectivity-unavailable")
            return
        }
        guard isCounterpartAvailable(for: session) else {
            publishActivationState(counterpartUnavailableDescription(for: session))
            return
        }
        guard session.activationState == .activated else {
            publishActivationState("watch-session-not-activated")
            return
        }
        guard session.isReachable else {
            publishActivationState("iphone-unreachable")
            return
        }
        var payload = metadata
        payload["command"] = command
        session.sendMessage(payload, replyHandler: nil) { [weak self] error in
            self?.publishActivationState(error.localizedDescription)
        }
    }

    func update(context: [String: Any]) {
        guard let session else {
            publishActivationState("watch-connectivity-unavailable")
            return
        }
        guard isCounterpartAvailable(for: session) else {
            publishActivationState(counterpartUnavailableDescription(for: session))
            return
        }
        guard session.activationState == .activated else {
            publishActivationState("watch-session-not-activated")
            return
        }
        do {
            try session.updateApplicationContext(context)
        } catch {
            publishActivationState(error.localizedDescription)
        }
    }

    func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        if let error {
            publishActivationState(error.localizedDescription)
        } else {
            publishActivationState(String(describing: activationState))
        }
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        publishPayload(message)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String : Any]) {
        publishPayload(applicationContext)
    }

#if os(iOS)
    func sessionDidBecomeInactive(_ session: WCSession) {
        publishActivationState("inactive")
    }

    func sessionDidDeactivate(_ session: WCSession) {
        publishActivationState("deactivated")
        session.activate()
    }
#endif

    private func isCounterpartAvailable(for session: WCSession) -> Bool {
#if os(iOS)
        return session.isPaired && session.isWatchAppInstalled
#elseif os(watchOS)
        return session.isCompanionAppInstalled
#else
        return true
#endif
    }

    private func counterpartUnavailableDescription(for session: WCSession) -> String {
#if os(iOS)
        if !session.isPaired {
            return "watch-not-paired"
        }
        if !session.isWatchAppInstalled {
            return "watch-app-not-installed"
        }
        return "watch-unavailable"
#elseif os(watchOS)
        return session.isCompanionAppInstalled ? "iphone-unavailable" : "iphone-app-not-installed"
#else
        return "counterpart-unavailable"
#endif
    }

    private func publishActivationState(_ value: String) {
        performSelector(onMainThread: #selector(applyActivationState(_:)), with: value as NSString, waitUntilDone: false)
    }

    private func publishPayload(_ payload: [String: Any]) {
        performSelector(onMainThread: #selector(applyPayload(_:)), with: payload as NSDictionary, waitUntilDone: false)
    }

    @objc
    private func applyActivationState(_ value: NSString) {
        activationStateDescription = value as String
    }

    @objc
    private func applyPayload(_ payload: NSDictionary) {
        let dictionary = payload as? [String: Any] ?? [:]
        lastPayload = dictionary
        onMessage?(dictionary)
    }
}
