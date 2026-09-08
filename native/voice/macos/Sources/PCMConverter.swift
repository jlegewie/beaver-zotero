import AVFoundation

/// Stateful sample-rate conversion and explicit arithmetic downmix to 16 kHz PCM16.
final class PCMConverter {
    let inputFormat: AVAudioFormat
    private let mono: AVAudioFormat
    private let converter: AVAudioConverter
    private var pending = Data()
    private(set) var frames = 0
    private(set) var samples = 0
    private(set) var inputPeak: Float = 0
    private(set) var clippedSamples = 0
    private(set) var discontinuityCount = 0
    private var expectedSampleTime: Int64?
    private var gain: Float = 1
    var quality: [String: Any] {
        ["inputPeak": inputPeak, "clippedSamples": clippedSamples, "discontinuityCount": discontinuityCount]
    }
    func markDiscontinuity() { discontinuityCount += 1 }
    var emit: (Data, Int) throws -> Void

    init(format: AVAudioFormat, emit: @escaping (Data, Int) throws -> Void) throws {
        guard format.commonFormat == .pcmFormatFloat32, !format.isInterleaved,
              format.channelCount > 0, format.channelCount <= 32, format.sampleRate > 0,
              let mono = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: format.sampleRate, channels: 1, interleaved: false),
              let target = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: false),
              let converter = AVAudioConverter(from: mono, to: target) else { throw VoiceFailure("device_unavailable") }
        self.inputFormat = format
        self.mono = mono
        self.converter = converter
        self.emit = emit
    }

    func append(_ input: AVAudioPCMBuffer, sampleTime: Int64? = nil) throws {
        if let time = sampleTime {
            if let expected = expectedSampleTime, time != expected {
                markDiscontinuity(); throw VoiceFailure("discontinuity")
            }
            let (next, overflow) = time.addingReportingOverflow(Int64(input.frameLength))
            guard !overflow else { throw VoiceFailure("capture_failed") }
            expectedSampleTime = next
        } else { expectedSampleTime = nil }
        guard input.format == inputFormat, input.frameLength <= 32768,
              let source = input.floatChannelData,
              let mixed = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: input.frameLength),
              let destination = mixed.floatChannelData else { throw VoiceFailure("discontinuity") }
        mixed.frameLength = input.frameLength
        var squares: Double = 0
        for i in 0..<Int(input.frameLength) {
            var value: Float = 0
            var clipped = false
            for channel in 0..<Int(inputFormat.channelCount) {
                let sample = source[channel][i]
                guard sample.isFinite else { throw VoiceFailure("capture_failed") }
                inputPeak = max(inputPeak, abs(sample))
                clipped = clipped || abs(sample) >= 0.99
                value += sample / Float(inputFormat.channelCount)
            }
            if clipped { clippedSamples += 1 }
            destination[0][i] = value
            squares += Double(value) * Double(value)
        }
        let rms = Float(sqrt(squares / Double(max(1, input.frameLength))))
        // Preserve ordinary speech levels. Never amplify near-silence; cap quiet-speech gain.
        let desired: Float = rms >= 0.01 && (rms < 0.1 || rms > 0.35) ? min(4, 0.2 / rms) : 1
        let attack = Float(1 - exp(-1 / (0.005 * inputFormat.sampleRate)))
        let release = Float(1 - exp(-1 / (0.5 * inputFormat.sampleRate)))
        for i in 0..<Int(input.frameLength) {
            let value = destination[0][i]
            gain += (desired - gain) * (desired < gain ? attack : release)
            // Immediate peak limiting with slow gain recovery leaves resampling headroom.
            if abs(value) * gain > 0.85 { gain = 0.85 / abs(value) }
            destination[0][i] = value * gain
        }
        try convert(mixed, ending: false)
    }

    func finish() throws {
        try convert(nil, ending: true)
        if !pending.isEmpty { try flush(pending.count) }
    }

    private func convert(_ input: AVAudioPCMBuffer?, ending: Bool) throws {
        var supplied = false
        // The converter may retain a filter tail. Drain through endOfStream on finish.
        for _ in 0..<128 {
            let out = AVAudioPCMBuffer(pcmFormat: converter.outputFormat, frameCapacity: 1600)!
            var error: NSError?
            let status = converter.convert(to: out, error: &error) { _, state in
                if let input = input, !supplied { supplied = true; state.pointee = .haveData; return input }
                state.pointee = ending ? .endOfStream : .noDataNow
                return nil
            }
            if error != nil || status == .error { throw VoiceFailure("capture_failed") }
            if let values = out.int16ChannelData {
                for i in 0..<Int(out.frameLength) {
                    let sample = UInt16(bitPattern: values[0][i])
                    pending.append(UInt8(sample & 255)); pending.append(UInt8(sample >> 8))
                }
            }
            while pending.count >= 3200 { try flush(3200) }
            if status == .endOfStream || (!ending && status == .inputRanDry) { return }
            if !ending && out.frameLength == 0 { return }
        }
        throw VoiceFailure("capture_failed")
    }

    private func flush(_ count: Int) throws {
        let bytes = Data(pending.prefix(count))
        try emit(bytes, frames)
        frames += 1; samples += count / 2
        pending.removeFirst(count)
    }
}

struct VoiceFailure: Error { let code: String; init(_ code: String) { self.code = code } }
