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
