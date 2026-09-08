import AVFoundation

func check(_ value: @autoclosure () -> Bool, _ message: String) {
    if !value() { fatalError(message) }
}
// Exercise the actual AVAudioConverter at common device rates, variable callback sizes,
// stereo downmix, RMS/frequency, saturation, and a non-frame-aligned final tail.
for rate in [44100.0, 48000.0] {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 2, interleaved: false)!
    var frames: [Data] = []
    let converter = try PCMConverter(format: format) { bytes, sequence in
        check(sequence == frames.count, "Noncontiguous frames")
        frames.append(bytes)
    }
    let count = Int(rate * 1.037)
    var offset = 0
    while offset < count {
        let length = min([127, 1024, 411, 2048][offset % 4], count - offset)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length))!
        buffer.frameLength = AVAudioFrameCount(length)
        for i in 0..<length {
            let signal = Float(sin(2 * Double.pi * 440 * Double(offset + i) / rate))
            buffer.floatChannelData![0][i] = signal * 0.6
            buffer.floatChannelData![1][i] = signal * 0.2
        }
        try converter.append(buffer); offset += length
    }
    try converter.finish()
    check(frames.dropLast().allSatisfy { $0.count == 3200 }, "Non-final short frame")
    check(frames.last!.count > 0 && frames.last!.count < 3200, "Missing final tail")
    let data = frames.reduce(Data(), +)
    let sampleCount = data.count / 2
    check(abs(sampleCount - Int(Double(count) * 16000 / rate)) <= 2, "Lost samples: \(sampleCount)")
    var squares = 0.0, crossings = 0, previous = 0.0
    for i in 0..<sampleCount {
        let word = UInt16(data[i * 2]) | UInt16(data[i * 2 + 1]) << 8
        let sample = Double(Int16(bitPattern: word)) / 32768
        squares += sample * sample
        if sample > 0 && previous <= 0 { crossings += 1 }; previous = sample
    }
    let rms = sqrt(squares / Double(sampleCount))
    check(abs(rms - 0.4 / sqrt(2)) < 0.01, "Incorrect downmix RMS: \(rms)")
    check(abs(Double(crossings) / (Double(sampleCount) / 16000) - 440) < 3, "Incorrect resampling frequency")
    print("PASS rate=\(rate) samples=\(sampleCount) tail=\(frames.last!.count / 2) rms=\(rms)")
}
// Identical but opposite stereo channels must cancel, establishing a real downmix.
let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: false)!
var silence = Data()
let converter = try PCMConverter(format: format) { data, _ in silence.append(data) }
let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
buffer.frameLength = 4800
for i in 0..<4800 { buffer.floatChannelData![0][i] = 0.75; buffer.floatChannelData![1][i] = -0.75 }
try converter.append(buffer); try converter.finish()
check(silence.allSatisfy { $0 == 0 }, "Downmix did not cancel")
print("PASS opposite-channel downmix")

// Gain control must preserve sample counts, bound peaks, report pre-gain clipping,
// and avoid boosting a muted/noisy microphone into plausible speech.
func controlledSignal(_ amplitude: Float, seconds: Double = 2) throws -> (PCMConverter, [Double]) {
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
    var data = Data()
    let converter = try PCMConverter(format: format) { bytes, _ in data.append(bytes) }
    for offset in stride(from: 0, to: Int(48000 * seconds), by: 960) {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 960)!
        buffer.frameLength = 960
        for i in 0..<960 { buffer.floatChannelData![0][i] = amplitude * Float(sin(2 * Double.pi * 440 * Double(offset + i) / 48000)) }
        try converter.append(buffer, sampleTime: Int64(offset))
    }
    try converter.finish()
    return (converter, stride(from: 0, to: data.count, by: 2).map {
        Double(Int16(bitPattern: UInt16(data[$0]) | UInt16(data[$0 + 1]) << 8)) / 32768
    })
}
let (loud, limited) = try controlledSignal(2)
check(limited.count == 32000, "Limiter lost samples")
check(limited.map { abs($0) }.max()! < 0.95, "Limiter failed to leave headroom")
check(loud.inputPeak > 1.9 && loud.clippedSamples > 0, "Input clipping hidden by limiter")
let (quiet, normalized) = try controlledSignal(0.04)
let settled = normalized.suffix(8000)
let normalizedRMS = sqrt(settled.reduce(0) { $0 + $1 * $1 } / Double(settled.count))
check(normalizedRMS > 0.08 && normalizedRMS < 0.12, "Quiet speech gain out of bounds")
check(quiet.clippedSamples == 0, "Quiet input misreported as clipping")
let (_, noise) = try controlledSignal(0.002)
check(noise.map { abs($0) }.max()! < 0.003, "Near-silence amplified")
let (_, muted) = try controlledSignal(0)
check(muted.allSatisfy { $0 == 0 }, "Muted microphone produced samples")
print("PASS gain normalization, peak limiter, clipping diagnostics, silence floor")

let timelineFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
let timeline = try PCMConverter(format: timelineFormat) { _, _ in }
let timelineBuffer = AVAudioPCMBuffer(pcmFormat: timelineFormat, frameCapacity: 960)!
timelineBuffer.frameLength = 960
timelineBuffer.floatChannelData![0].initialize(repeating: 0, count: 960)
try timeline.append(timelineBuffer, sampleTime: 0)
try timeline.append(timelineBuffer, sampleTime: 960)
check(timeline.discontinuityCount == 0, "Contiguous audio misclassified")
do {
    try timeline.append(timelineBuffer, sampleTime: 2880)
    fatalError("Missing samples not detected")
} catch {
    check((error as? VoiceFailure)?.code == "discontinuity", "Wrong timeline error")
    check(timeline.discontinuityCount == 1, "Missing discontinuity count")
}
print("PASS audio timestamp discontinuity detection")
