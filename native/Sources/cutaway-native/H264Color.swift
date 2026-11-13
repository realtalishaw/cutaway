import Foundation

/// Rewrites the colour description inside an H.264 sequence parameter set so the
/// bitstream itself says BT.709 primaries, transfer and matrix. The container's
/// `colr` box is written separately (MP4ColorTagger); players disagree about which
/// of the two they trust, so both have to say the same thing.
enum H264Color {
    private struct BitReader {
        let bytes: [UInt8]
        var pos = 0
        let end: Int
        init(_ bytes: [UInt8], start: Int, end: Int) { self.bytes = bytes; pos = start; self.end = end }
        var remaining: Int { end - pos }
        mutating func bit() throws -> Int {
            guard pos < end else { throw CLIError("corrupt", "SPS ended early") }
            let b = (Int(bytes[pos >> 3]) >> (7 - (pos & 7))) & 1
            pos += 1
            return b
        }
        mutating func bits(_ n: Int) throws -> Int {
            var v = 0
            for _ in 0..<n { v = (v << 1) | (try bit()) }
            return v
        }
        mutating func ue() throws -> Int {
            var zeros = 0
            while try bit() == 0 {
                zeros += 1
                guard zeros <= 31 else { throw CLIError("corrupt", "bad exp-Golomb code") }
            }
            return zeros == 0 ? 0 : ((1 << zeros) - 1) + (try bits(zeros))
        }
        mutating func se() throws -> Int {
            let k = try ue()
            return (k & 1) == 1 ? (k + 1) / 2 : -(k / 2)
        }
    }

    private struct BitWriter {
        var bytes: [UInt8] = []
        var count = 0
        mutating func bit(_ b: Int) {
            if count & 7 == 0 { bytes.append(0) }
            if b != 0 { bytes[count >> 3] |= UInt8(1 << (7 - (count & 7))) }
            count += 1
        }
        mutating func bits(_ v: Int, _ n: Int) {
            for i in stride(from: n - 1, through: 0, by: -1) { bit((v >> i) & 1) }
        }
        mutating func copy(_ src: [UInt8], from: Int, to: Int) {
            var p = from
            while p < to {
                bit((Int(src[p >> 3]) >> (7 - (p & 7))) & 1)
                p += 1
            }
        }
    }

    private static func unescape(_ nal: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(nal.count)
        var zeros = 0
        for b in nal {
            if zeros >= 2 && b == 3 { zeros = 0; continue }
            out.append(b)
            zeros = b == 0 ? zeros + 1 : 0
        }
        return out
    }

    private static func escape(_ rbsp: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(rbsp.count + 4)
        var zeros = 0
        for b in rbsp {
            if zeros >= 2 && b <= 3 { out.append(3); zeros = 0 }
            out.append(b)
            zeros = b == 0 ? zeros + 1 : 0
        }
        return out
    }

    private static func skipScalingList(_ r: inout BitReader, size: Int) throws {
        var last = 8, next = 8
        for _ in 0..<size {
            if next != 0 { next = (last + (try r.se()) + 256) % 256 }
            last = next == 0 ? last : next
        }
    }

    /// Returns the SPS NAL unit with colour_primaries = transfer_characteristics =
    /// matrix_coefficients = 1 (BT.709). Everything else is copied bit for bit.
    /// `nil` when the SPS already says so.
    static func patchSPS(_ nal: [UInt8]) throws -> [UInt8]? {
        guard nal.count > 4, nal[0] & 0x1f == 7 else { throw CLIError("corrupt", "not an SPS") }
        let rbsp = unescape(nal)
        // The data ends at the stop bit: the last 1 in the payload.
        var last = rbsp.count - 1
        while last > 0 && rbsp[last] == 0 { last -= 1 }
        var stop = last * 8 + 7
        while (Int(rbsp[last]) >> (7 - (stop & 7))) & 1 == 0 { stop -= 1 }

        var r = BitReader(rbsp, start: 8, end: stop)
        let profile = try r.bits(8)
        _ = try r.bits(16)          // constraint flags, level
        _ = try r.ue()              // seq_parameter_set_id
        if [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].contains(profile) {
            let chroma = try r.ue()
            if chroma == 3 { _ = try r.bit() }
            _ = try r.ue(); _ = try r.ue(); _ = try r.bit()
            if try r.bit() == 1 {
                for i in 0..<(chroma != 3 ? 8 : 12) {
                    if try r.bit() == 1 { try skipScalingList(&r, size: i < 6 ? 16 : 64) }
                }
            }
        }
        _ = try r.ue()              // log2_max_frame_num_minus4
        let pocType = try r.ue()
        if pocType == 0 {
            _ = try r.ue()
        } else if pocType == 1 {
            _ = try r.bit(); _ = try r.se(); _ = try r.se()
            for _ in 0..<(try r.ue()) { _ = try r.se() }
        }
        _ = try r.ue(); _ = try r.bit()         // max_num_ref_frames, gaps
        _ = try r.ue(); _ = try r.ue()          // width, height in macroblocks
        if try r.bit() == 0 { _ = try r.bit() } // frame_mbs_only, mb_adaptive
        _ = try r.bit()                         // direct_8x8_inference
        if try r.bit() == 1 { for _ in 0..<4 { _ = try r.ue() } }

        var w = BitWriter()
        let vuiFlagAt = r.pos
        if try r.bit() == 0 {
            // No VUI at all: add the smallest one that carries the colour description.
            w.copy(rbsp, from: 0, to: vuiFlagAt)
            w.bit(1)
            w.bit(0); w.bit(0)                  // aspect ratio, overscan
            w.bit(1); w.bits(5, 3); w.bit(0); w.bit(1); w.bits(1, 8); w.bits(1, 8); w.bits(1, 8)
            w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0); w.bit(0)   // chroma loc, timing, HRDs, pic struct, restrictions
        } else {
            if try r.bit() == 1, try r.bits(8) == 255 { _ = try r.bits(32) }   // aspect ratio
            if try r.bit() == 1 { _ = try r.bit() }                            // overscan
            let signalAt = r.pos
            var format = 5, fullRange = 0
            if try r.bit() == 1 {
                format = try r.bits(3)
                fullRange = try r.bit()
                if try r.bit() == 1 {
                    let p = try r.bits(8), t = try r.bits(8), m = try r.bits(8)
                    if p == 1 && t == 1 && m == 1 { return nil }
                }
            }
            w.copy(rbsp, from: 0, to: signalAt)
            w.bit(1); w.bits(format, 3); w.bit(fullRange); w.bit(1); w.bits(1, 8); w.bits(1, 8); w.bits(1, 8)
            w.copy(rbsp, from: r.pos, to: stop)
        }
        w.bit(1)                                // rbsp stop bit; the writer pads with zeros
        return escape(w.bytes)
    }

    /// Patches every SPS inside an `avcC` box payload. `nil` when nothing changed.
    static func patchAvcC(_ avcC: Data) throws -> Data? {
        let b = [UInt8](avcC)
        guard b.count > 7, b[0] == 1 else { throw CLIError("corrupt", "unexpected avcC") }
        var out = Array(b[0..<6])
        var o = 6
        var changed = false
        for _ in 0..<Int(b[5] & 0x1f) {
            guard o + 2 <= b.count else { throw CLIError("corrupt", "avcC ended early") }
            let len = (Int(b[o]) << 8) | Int(b[o + 1])
            guard o + 2 + len <= b.count else { throw CLIError("corrupt", "avcC ended early") }
            let sps = Array(b[(o + 2)..<(o + 2 + len)])
            let patched = try patchSPS(sps)
            if patched != nil { changed = true }
            let use = patched ?? sps
            guard use.count <= 0xffff else { throw CLIError("corrupt", "SPS too large") }
            out += [UInt8(use.count >> 8), UInt8(use.count & 0xff)] + use
            o += 2 + len
        }
        out += b[o...]
        return changed ? Data(out) : nil
    }
}
