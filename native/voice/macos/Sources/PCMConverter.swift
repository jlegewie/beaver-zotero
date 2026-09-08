import AVFoundation

/// Stateful sample-rate conversion and explicit arithmetic downmix to 16 kHz PCM16.
final class PCMConverter {
    let inputFormat: AVAudioFormat
    private let mono: AVAudioFormat
    private let converter: AVAudioConverter
    private var pending = Data()
    private(set) var frames = 0
    private(set) var samples = 0
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

    func append(_ input: AVAudioPCMBuffer) throws {
        guard input.format == inputFormat, input.frameLength <= 32768,
              let source = input.floatChannelData,
              let mixed = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: input.frameLength),
              let destination = mixed.floatChannelData else { throw VoiceFailure("discontinuity") }
        mixed.frameLength = input.frameLength
        for i in 0..<Int(input.frameLength) {
            var value: Float = 0
            for channel in 0..<Int(inputFormat.channelCount) { value += source[channel][i] / Float(inputFormat.channelCount) }
            guard value.isFinite else { throw VoiceFailure("capture_failed") }
            destination[0][i] = max(-1, min(1, value))
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
