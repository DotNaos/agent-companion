import AVFoundation
import Foundation

@MainActor
final class PhoneVoiceController {
    var onError: ((String) -> Void)?
    var onCaptureStateChange: ((Bool) -> Void)?
    var onPlaybackStateChange: ((Bool) -> Void)?

    private let playbackEngine = AVAudioEngine()
    private let playbackNode = AVAudioPlayerNode()

    private var captureSocket: PlutoVoiceSocket?
    private var captureClientId: String?
    private var captureSampleRate = 16_000.0
    private var pendingPlaybackBuffers = 0
    private var playbackConfigured = false
    private var captureConfigured = false

    init() {
        playbackEngine.attach(playbackNode)
        playbackEngine.connect(playbackNode, to: playbackEngine.mainMixerNode, format: nil)
    }

    func startCapture(clientId: String, socket: PlutoVoiceSocket) async throws {
        try await ensureRecordPermission()
        try configureAudioSession()
        try configureCaptureTap(clientId: clientId, socket: socket)

        if !playbackEngine.isRunning {
            try playbackEngine.start()
        }
        onCaptureStateChange?(true)
    }

    func stopCapture() async {
        if captureConfigured {
            let inputNode = playbackEngine.inputNode
            inputNode.removeTap(onBus: 0)
            captureConfigured = false
        }

        let socket = captureSocket
        let clientId = captureClientId
        captureSocket = nil
        captureClientId = nil

        if let socket, let clientId {
            try? await socket.endAudioStream(clientId: clientId)
        }

        onCaptureStateChange?(false)
    }

    func stopPlayback() {
        pendingPlaybackBuffers = 0
        playbackNode.stop()
        onPlaybackStateChange?(false)
    }

    func handleIncomingAudioChunk(audioBase64: String, mimeType: String) {
        do {
            try configureAudioSession()
            if !playbackEngine.isRunning {
                try playbackEngine.start()
            }
            let buffer = try makePlaybackBuffer(audioBase64: audioBase64, mimeType: mimeType)
            pendingPlaybackBuffers += 1
            if !playbackNode.isPlaying {
                playbackNode.play()
                onPlaybackStateChange?(true)
            }
            playbackNode.scheduleBuffer(buffer) { [weak self] in
                guard let self else {
                    return
                }
                Task { @MainActor [weak self] in
                    guard let self else {
                        return
                    }
                    self.pendingPlaybackBuffers = max(0, self.pendingPlaybackBuffers - 1)
                    if self.pendingPlaybackBuffers == 0 {
                        self.onPlaybackStateChange?(false)
                    }
                }
            }
        } catch {
            onError?(error.localizedDescription)
        }
    }

    private func configureAudioSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
    }

    private func configureCaptureTap(clientId: String, socket: PlutoVoiceSocket) throws {
        let inputNode = playbackEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)

        captureSocket = socket
        captureClientId = clientId
        captureSampleRate = max(8_000, format.sampleRate)

        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 1_024, format: format) { [weak self] buffer, _ in
            self?.sendCapturedBuffer(buffer)
        }
        captureConfigured = true
    }

    private func sendCapturedBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let socket = captureSocket, let clientId = captureClientId else {
            return
        }

        guard let channelData = buffer.floatChannelData?.pointee else {
            return
        }

        let frameLength = Int(buffer.frameLength)
        guard frameLength > 0 else {
            return
        }

        let data = Self.makePCM16Data(samples: channelData, frameLength: frameLength)
        let audioBase64 = data.base64EncodedString()
        let mimeType = "audio/pcm;rate=\(Int(captureSampleRate.rounded()))"

        Task {
            do {
                try await socket.sendAudioChunk(clientId: clientId, audioBase64: audioBase64, mimeType: mimeType)
            } catch {
                await MainActor.run {
                    self.onError?(error.localizedDescription)
                }
            }
        }
    }

    private func makePlaybackBuffer(audioBase64: String, mimeType: String) throws -> AVAudioPCMBuffer {
        guard mimeType.starts(with: "audio/pcm") else {
            throw PhoneVoiceControllerError.unsupportedAudioFormat(mimeType)
        }
        guard let data = Data(base64Encoded: audioBase64) else {
            throw PhoneVoiceControllerError.invalidAudioPayload
        }

        let sampleRate = Self.parseSampleRate(from: mimeType, fallback: 24_000)
        let frameCount = data.count / MemoryLayout<Int16>.size
        guard frameCount > 0 else {
            throw PhoneVoiceControllerError.invalidAudioPayload
        }

        guard let sourceFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false),
              let sourceBuffer = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(frameCount)),
              let sourceChannel = sourceBuffer.floatChannelData?.pointee else {
            throw PhoneVoiceControllerError.invalidAudioPayload
        }

        data.withUnsafeBytes { rawBuffer in
            let samples = rawBuffer.bindMemory(to: Int16.self)
            for index in 0 ..< frameCount {
                let sample = samples[index]
                sourceChannel[index] = sample >= 0
                    ? Float(sample) / Float(Int16.max)
                    : Float(sample) / 32768.0
            }
        }
        sourceBuffer.frameLength = AVAudioFrameCount(frameCount)

        let destinationFormat = playbackNode.outputFormat(forBus: 0)
        if Self.formatsMatch(sourceFormat, destinationFormat) {
            return sourceBuffer
        }

        return try convertPlaybackBuffer(sourceBuffer, to: destinationFormat)
    }

    private func ensureRecordPermission() async throws {
        let granted: Bool
        if #available(iOS 17.0, *) {
            granted = await AVAudioApplication.requestRecordPermission()
        } else {
            let session = AVAudioSession.sharedInstance()
            granted = await withCheckedContinuation { continuation in
                session.requestRecordPermission { allowed in
                    continuation.resume(returning: allowed)
                }
            }
        }
        if !granted {
            throw PhoneVoiceControllerError.microphonePermissionDenied
        }
    }

    private func convertPlaybackBuffer(_ sourceBuffer: AVAudioPCMBuffer, to destinationFormat: AVAudioFormat) throws -> AVAudioPCMBuffer {
        guard let converter = AVAudioConverter(from: sourceBuffer.format, to: destinationFormat) else {
            throw PhoneVoiceControllerError.unsupportedPlaybackConfiguration
        }

        let capacityRatio = destinationFormat.sampleRate / sourceBuffer.format.sampleRate
        let outputCapacity = AVAudioFrameCount(ceil(Double(sourceBuffer.frameLength) * capacityRatio)) + 1_024
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: destinationFormat, frameCapacity: max(outputCapacity, 1_024)) else {
            throw PhoneVoiceControllerError.unsupportedPlaybackConfiguration
        }

        var didProvideInput = false
        var conversionError: NSError?
        let status = converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if didProvideInput {
                outStatus.pointee = .endOfStream
                return nil
            }
            didProvideInput = true
            outStatus.pointee = .haveData
            return sourceBuffer
        }

        if let conversionError {
            throw conversionError
        }

        guard status == .haveData || status == .inputRanDry,
              outputBuffer.frameLength > 0
        else {
            throw PhoneVoiceControllerError.unsupportedPlaybackConfiguration
        }

        return outputBuffer
    }

    private static func makePCM16Data(samples: UnsafeMutablePointer<Float>, frameLength: Int) -> Data {
        var data = Data(count: frameLength * MemoryLayout<Int16>.size)
        data.withUnsafeMutableBytes { rawBuffer in
            guard let output = rawBuffer.bindMemory(to: Int16.self).baseAddress else {
                return
            }
            for index in 0 ..< frameLength {
                let sample = max(-1, min(1, samples[index]))
                let value = sample < 0
                    ? Int16(sample * 32768.0)
                    : Int16(sample * Float(Int16.max))
                output[index] = value.littleEndian
            }
        }
        return data
    }

    private static func parseSampleRate(from mimeType: String, fallback: Double) -> Double {
        for parameter in mimeType.split(separator: ";").dropFirst() {
            let parts = parameter.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, parts[0] == "rate", let parsed = Double(parts[1]) {
                return parsed
            }
        }
        return fallback
    }

    private static func formatsMatch(_ lhs: AVAudioFormat, _ rhs: AVAudioFormat) -> Bool {
        lhs.channelCount == rhs.channelCount
            && abs(lhs.sampleRate - rhs.sampleRate) < 0.5
            && lhs.commonFormat == rhs.commonFormat
            && lhs.isInterleaved == rhs.isInterleaved
    }
}

enum PhoneVoiceControllerError: LocalizedError {
    case microphonePermissionDenied
    case invalidAudioPayload
    case unsupportedAudioFormat(String)
    case unsupportedPlaybackConfiguration

    var errorDescription: String? {
        switch self {
        case .microphonePermissionDenied:
            return "Microphone permission is required for Pluto voice chat."
        case .invalidAudioPayload:
            return "The incoming Pluto audio payload was invalid."
        case .unsupportedAudioFormat(let mimeType):
            return "Unsupported Pluto audio format: \(mimeType)"
        case .unsupportedPlaybackConfiguration:
            return "The current iPhone playback format could not be prepared for Pluto audio."
        }
    }
}
