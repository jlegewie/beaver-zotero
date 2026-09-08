import AppKit
import AVFoundation

private var now: Double { ProcessInfo.processInfo.systemUptime }

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let args = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}
guard let portText = argument("--port"), let port = Int(portText), (1...65535).contains(port),
      let token = argument("--token"), token.count == 64, token.allSatisfy({ $0.isHexDigit }),
      let sessionID = argument("--session"), (1...128).contains(sessionID.count),
      sessionID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }) else { exit(2) }

/// Locks only small counters; never hold this lock while stopping the engine or doing I/O.
final class SharedState {
    private let lock = NSLock()
    private var contact = now
    private var callback = now
    private var eventBytes = 0
    private var inputBytes = 0
    private var finishDeadline: Double?
    private var ready = false
    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock(); defer { lock.unlock() }
        return body()
    }
    func markReady() { withLock { ready = true } }
    func isReady() -> Bool { withLock { ready } }
    func beginFinish() { withLock { if finishDeadline == nil { finishDeadline = now + 10 } } }
    func finishExpired() -> Bool { withLock { finishDeadline.map { now >= $0 } ?? false } }
    func touchControl() { withLock { contact = now } }
    func touchAudio() { withLock { callback = now } }
    func controlAge() -> Double { withLock { now - contact } }
    func audioAge() -> Double { withLock { now - callback } }
    func reserve(_ bytes: Int, input: Bool) -> Bool {
        withLock {
            if input {
                if inputBytes + bytes > 2_097_152 { return false }; inputBytes += bytes
            } else {
                if eventBytes + bytes > 160_000 { return false }; eventBytes += bytes
            }
            return true
        }
    }
    func release(_ bytes: Int, input: Bool) { withLock { if input { inputBytes -= bytes } else { eventBytes -= bytes } } }
}

final class Helper {
    let state = SharedState()
    let audioQueue = DispatchQueue(label: "ai.beaverapp.voice.audio")
    let eventQueue = DispatchQueue(label: "ai.beaverapp.voice.events")
    let controlQueue = DispatchQueue(label: "ai.beaverapp.voice.control")
    let engine = AVAudioEngine()
    let url: URL
    let token: String
    let sessionID: String
    let permissionOnly: Bool
    let http = VoiceHTTPClient()
    var converter: PCMConverter?
    var controlTimer: DispatchSourceTimer?
    var watchdog: DispatchSourceTimer?
    var captureTimer: Timer?
    var observer: NSObjectProtocol?
    #if VOICE_TESTING
    let testMode: String
    var fixtureTimer: Timer?
    #endif
    var terminal = false
    var capturing = false
    var eventSequence = 0 // eventQueue only
    var controlSequence = 0 // controlQueue only
    let launched = now

    init(port: Int, token: String, sessionID: String) {
        self.url = URL(string: "http://127.0.0.1:\(port)/voice")!
        self.token = token; self.sessionID = sessionID
        self.permissionOnly = CommandLine.arguments.contains("--permission-only")
        #if VOICE_TESTING
        self.testMode = argument("--test-mode") ?? "fixture"
        #endif

    }

    func post(_ fields: [String: Any]) -> String? {
        var envelope = fields
        envelope["version"] = 1; envelope["sessionId"] = sessionID
        guard let data = try? JSONSerialization.data(withJSONObject: envelope), data.count <= 6144 else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"; request.httpBody = data
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("close", forHTTPHeaderField: "Connection")
        guard let (data, response) = http.execute(request) else { return nil }
        if response.statusCode != 200 { return "cancel" }
        guard let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              reply["version"] as? Int == 1, reply["sessionId"] as? String == sessionID,
              let command = reply["command"] as? String,
              ["continue", "finish", "cancel", "exit"].contains(command) else { return nil }
        return command
    }

    func event(_ fields: [String: Any]) -> String? {
        var fields = fields
        fields["eventSequence"] = eventSequence; eventSequence += 1
        return post(fields)
    }
    func act(_ command: String?) {
        // Cancellation cannot depend on a responsive main run loop or audio engine.
        if command != "continue" && command != "finish" { _exit(0) }
        if command == "finish" {
            state.beginFinish()
            DispatchQueue.main.async { self.finish() }
        }
    }
    func start() {
        // Independent queue can terminate even when the engine, event upload, or main run loop stalls.
        let watchdog = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .userInitiated))
        watchdog.schedule(deadline: .now(), repeating: .milliseconds(250))
        watchdog.setEventHandler { [self] in
            if state.controlAge() >= 3 || state.finishExpired() || (!state.isReady() && now - launched >= 30) || now - launched >= 155 { _exit(0) }
        }
        self.watchdog = watchdog; watchdog.resume()
        eventQueue.async { [self] in
            guard event(["type": "hello", "helperVersion": 2, "pid": getpid()]) == "continue" else { act("cancel"); return }
            state.touchControl()
            startControl()
            DispatchQueue.main.async { self.permission() }
        }
    }
    func startControl() {
        let timer = DispatchSource.makeTimerSource(queue: controlQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(500))
        timer.setEventHandler { [self] in
            let command = post(["type": "control", "sequence": controlSequence]); controlSequence += 1
            if command != nil { state.touchControl() }
            act(command)
        }
        controlTimer = timer; timer.resume()
    }
    func permission() {
        guard !terminal else { return }
        #if VOICE_TESTING
        if testMode == "setup-stall" { return }
        let status: AVAuthorizationStatus = testMode == "denied" ? .denied : testMode == "unrequested" ? .notDetermined : .authorized
        #else
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        #endif
        let name: String
        switch status {
        case .authorized: name = "granted"
        case .denied: name = "denied"
        case .restricted: name = "restricted"
        default: name = "not_determined"
        }
        eventQueue.async { [self] in
            let command = event(["type": "permission", "status": name])
            guard command == "continue" else { act(command); return }
            DispatchQueue.main.async {
                guard !self.terminal else { return }
                if status == .authorized {
                    if self.permissionOnly { self.permissionDone("granted") } else { self.capture() }
                }
                else if status == .notDetermined {
                    // Only explicit setup may prompt. A stale grant requires fresh setup and activation.
                    guard self.permissionOnly else { self.fail("unavailable"); return }
                    AVCaptureDevice.requestAccess(for: .audio) { allowed in
                        DispatchQueue.main.async {
                            self.permissionDone(allowed ? "granted" : "denied")
                        }
                    }
                } else {
                    if self.permissionOnly { self.permissionDone(name) } else { self.fail("permission_denied") }
                }
            }
        }
    }
    func permissionDone(_ status: String) {
        guard !terminal else { return }
        terminal = true
        eventQueue.async { [self] in _ = event(["type": "permission_done", "status": status]); _exit(0) }
    }
    func makeConverter(_ format: AVAudioFormat) throws -> PCMConverter {
        try PCMConverter(format: format) { [self] bytes, sequence in
            guard state.reserve(bytes.count, input: false) else { throw VoiceFailure("overflow") }
            let quality = converter?.quality ?? ["inputPeak": 0, "clippedSamples": 0, "discontinuityCount": 0]
            eventQueue.async { [self] in
                defer { state.release(bytes.count, input: false) }
                act(event(["type": "frame", "sequence": sequence, "sampleCount": bytes.count / 2, "pcm": bytes.base64EncodedString(), "quality": quality]))
            }
        }
    }
    // Acknowledge ready before starting capture so frames cannot overtake readiness.
    func readyThen(_ startCapture: @escaping () -> Void) {
        eventQueue.async { [self] in
            let command = event(["type": "ready", "format": ["encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1]])
            guard command == "continue" else { act(command); return }
            DispatchQueue.main.async {
                #if VOICE_TESTING
                if self.testMode == "startup-discontinuity" {
                    NotificationCenter.default.post(name: .AVAudioEngineConfigurationChange, object: self.engine)
                }
                #endif
                if !self.terminal { startCapture() }
            }
        }
    }
    func observeConfigurationChanges() {
        observer = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            self?.fail("discontinuity")
        }
    }
    func capture() {
        guard !terminal else { return }
        #if VOICE_TESTING
        if testMode == "no-device" { fail("device_unavailable"); return }
        startFixture(); return
        #else
        guard AVCaptureDevice.default(for: .audio) != nil else { fail("device_unavailable"); return }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        observeConfigurationChanges()
        do {
            converter = try makeConverter(format)
        } catch { fail("device_unavailable"); return }
        readyThen { self.startEngine(format) }
        #endif
    }
    #if VOICE_TESTING
    // Compiled only into the separately identified native fault-test app.
    func startFixture() {
        observeConfigurationChanges()
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
        do {
            converter = try makeConverter(format)
        } catch { fail("capture_failed"); return }
        readyThen { [self] in
            self.state.touchAudio(); self.state.markReady()
            var frames = 0
            self.fixtureTimer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [self] _ in
                if testMode == "main-stall" { Thread.sleep(forTimeInterval: 300) }
                if testMode == "capture-stall" { return }
                if testMode == "discontinuity" && frames > 10 { fail("discontinuity"); return }
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960)!
                buffer.frameLength = 960
                for i in 0..<960 {
                    let value = Float(sin(2 * Double.pi * 440 * Double(frames * 960 + i) / 48000)) * 0.2
                    buffer.floatChannelData![0][i] = value; buffer.floatChannelData![1][i] = value
                }
                frames += 1; state.touchAudio()
                audioQueue.async { [self] in
                    do { try converter?.append(buffer) }
                    catch { DispatchQueue.main.async { self.fail((error as? VoiceFailure)?.code ?? "capture_failed") } }
                }
            }
            self.monitorCapture()
        }
    }
    #endif
    func startEngine(_ format: AVAudioFormat) {
        guard !terminal else { return }
        // Read again after the ready round trip; the converter and tap must use the same format.
        guard AVCaptureDevice.default(for: .audio) != nil else { fail("device_unavailable"); return }
        let current = engine.inputNode.outputFormat(forBus: 0)
        guard current.isEqual(format) else { fail("discontinuity"); return }
        engine.inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { [self] buffer, time in
            let size = Int(buffer.frameLength) * Int(format.channelCount) * 4
            guard buffer.frameLength > 0, buffer.frameLength <= 32768, state.reserve(size, input: true) else {
                DispatchQueue.main.async { self.fail("overflow") }; return
            }
            guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength),
                  let source = buffer.floatChannelData, let target = copy.floatChannelData else {
                state.release(size, input: true); DispatchQueue.main.async { self.fail("capture_failed") }; return
            }
            copy.frameLength = buffer.frameLength
            for channel in 0..<Int(format.channelCount) { target[channel].update(from: source[channel], count: Int(buffer.frameLength)) }
            let sampleTime = time.isSampleTimeValid ? time.sampleTime : nil
            state.touchAudio()
            audioQueue.async { [self] in
                defer { state.release(size, input: true) }
                do { try converter?.append(copy, sampleTime: sampleTime) }
                catch { DispatchQueue.main.async { self.fail((error as? VoiceFailure)?.code ?? "capture_failed") } }
            }
        }
        do { try engine.start(); capturing = true; state.touchAudio(); state.markReady() }
        catch { engine.inputNode.removeTap(onBus: 0); fail("device_unavailable"); return }
        monitorCapture()
    }
    func monitorCapture() {
        let started = now
        captureTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [self] _ in
            if state.audioAge() >= 3 { fail("capture_failed") }
            else if now - started >= 120 { fail("duration_limit") }
        }
    }
    func stopEngine() {
        #if VOICE_TESTING
        fixtureTimer?.invalidate(); fixtureTimer = nil
        #endif
        captureTimer?.invalidate(); captureTimer = nil
        if capturing { engine.stop(); engine.inputNode.removeTap(onBus: 0); capturing = false }
        if let observer = observer { NotificationCenter.default.removeObserver(observer); self.observer = nil }
    }
    func finish() {
        guard !terminal else { return }
        terminal = true; stopEngine()
        audioQueue.async { [self] in
            do {
                try converter?.finish()
                let frames = converter?.frames ?? 0, samples = converter?.samples ?? 0
                eventQueue.async { [self] in
                    _ = event(["type": "done", "frameCount": frames, "sampleCount": samples])
                    _exit(0)
                }
            } catch { _exit(1) }
        }
    }
    func fail(_ code: String) {
        guard !terminal else { return }
        terminal = true; stopEngine()
        audioQueue.async { [self] in
            if code == "discontinuity", converter?.discontinuityCount == 0 { converter?.markDiscontinuity() }
            let quality = converter?.quality ?? ["inputPeak": 0, "clippedSamples": 0, "discontinuityCount": code == "discontinuity" ? 1 : 0]
            eventQueue.async { [self] in _ = event(["type": "error", "code": code, "quality": quality]); _exit(1) }
        }
    }
}
let helper = Helper(port: port, token: token, sessionID: sessionID)
helper.start()
app.run()
