import Foundation

/// Adds a BT.709 `colr` (nclx) box to the video sample entry of a finished MP4.
/// AVAssetWriter does not write one when samples are passed through untouched, so the
/// box is inserted afterwards and every chunk offset is shifted to match.
enum MP4ColorTagger {
    private static func u32(_ b: [UInt8], _ o: Int) -> Int {
        (Int(b[o]) << 24) | (Int(b[o + 1]) << 16) | (Int(b[o + 2]) << 8) | Int(b[o + 3])
    }
    private static func putU32(_ b: inout [UInt8], _ o: Int, _ v: Int) {
        b[o] = UInt8((v >> 24) & 0xff); b[o + 1] = UInt8((v >> 16) & 0xff); b[o + 2] = UInt8((v >> 8) & 0xff); b[o + 3] = UInt8(v & 0xff)
    }
    private static func type(_ b: [UInt8], _ o: Int) -> String {
        String(bytes: b[(o + 4)..<(o + 8)], encoding: .isoLatin1) ?? ""
    }

    /// Child boxes inside `range` of `b` (32-bit sizes only, which is all a moov uses).
    private static func children(_ b: [UInt8], _ range: Range<Int>) -> [(type: String, start: Int, size: Int)] {
        var out: [(String, Int, Int)] = []
        var o = range.lowerBound
        while o + 8 <= range.upperBound {
            let size = u32(b, o)
            guard size >= 8, o + size <= range.upperBound else { break }
            out.append((type(b, o), o, size))
            o += size
        }
        return out
    }
    private static func child(_ b: [UInt8], _ range: Range<Int>, _ name: String) -> (start: Int, size: Int)? {
        children(b, range).first { $0.type == name }.map { ($0.start, $0.size) }
    }
    private static func body(_ box: (start: Int, size: Int)) -> Range<Int> { (box.start + 8)..<(box.start + box.size) }

    /// Returns true when a box was added, false when the file already carried colour tags.
    static func tagBT709(input: URL, output: URL) throws -> Bool {
        let fm = FileManager.default
        guard let inHandle = try? FileHandle(forReadingFrom: input) else { throw CLIError("io", "Cannot read \(input.path)") }
        defer { try? inHandle.close() }
        let fileSize = ((try? fm.attributesOfItem(atPath: input.path))?[.size] as? NSNumber)?.uint64Value ?? 0

        // Locate moov among the top-level boxes.
        var offset: UInt64 = 0
        var moovStart: UInt64?
        var moovSize: UInt64 = 0
        while offset + 8 <= fileSize {
            try inHandle.seek(toOffset: offset)
            guard let head = try inHandle.read(upToCount: 16), head.count >= 8 else { break }
            let h = [UInt8](head)
            var size = UInt64(u32(h, 0))
            if size == 1, h.count >= 16 {
                size = (UInt64(u32(h, 8)) << 32) | UInt64(u32(h, 12))
            } else if size == 0 {
                size = fileSize - offset
            }
            guard size >= 8 else { break }
            if type(h, 0) == "moov" { moovStart = offset; moovSize = size; break }
            offset += size
        }
        guard let moovAt = moovStart, moovSize < 512_000_000 else { throw CLIError("mux-failed", "No moov box found.") }
        try inHandle.seek(toOffset: moovAt)
        guard let moovData = try inHandle.read(upToCount: Int(moovSize)), moovData.count == Int(moovSize) else {
            throw CLIError("mux-failed", "Could not read the moov box.")
        }
        var moov = [UInt8](moovData)
        let moovBox = (start: 0, size: moov.count)

        // Find the video track's first sample entry.
        var ancestors: [Int] = [0]   // offsets of size fields to grow
        var entry: (start: Int, size: Int)?
        for trak in children(moov, body(moovBox)) where trak.type == "trak" {
            let trakBox = (start: trak.start, size: trak.size)
            guard let mdia = child(moov, body(trakBox), "mdia"),
                  let hdlr = child(moov, body(mdia), "hdlr"), hdlr.size >= 24,
                  String(bytes: moov[(hdlr.start + 16)..<(hdlr.start + 20)], encoding: .isoLatin1) == "vide",
                  let minf = child(moov, body(mdia), "minf"),
                  let stbl = child(moov, body(minf), "stbl"),
                  let stsd = child(moov, body(stbl), "stsd"), stsd.size >= 24 else { continue }
            let first = stsd.start + 16
            let size = u32(moov, first)
            guard size >= 86, first + size <= stsd.start + stsd.size else { continue }
            entry = (first, size)
            ancestors += [trak.start, mdia.start, minf.start, stbl.start, stsd.start, first]
            break
        }
        guard let e = entry else { throw CLIError("mux-failed", "No video sample entry found.") }
        if children(moov, (e.start + 86)..<(e.start + e.size)).contains(where: { $0.type == "colr" }) {
            return false
        }

        let colr: [UInt8] = [0, 0, 0, 19] + Array("colr".utf8) + Array("nclx".utf8) + [0, 1, 0, 1, 0, 1, 0x00]
        let delta = colr.count
        moov.insert(contentsOf: colr, at: e.start + e.size)
        for o in ancestors { putU32(&moov, o, u32(moov, o) + delta) }

        // Media data after the moov moves by `delta`: fix every chunk offset that points past it.
        let moovEnd = moovAt + moovSize
        let newMoov = (start: 0, size: moov.count)
        for trak in children(moov, body(newMoov)) where trak.type == "trak" {
            guard let mdia = child(moov, body((trak.start, trak.size)), "mdia"),
                  let minf = child(moov, body(mdia), "minf"),
                  let stbl = child(moov, body(minf), "stbl") else { continue }
            if let stco = child(moov, body(stbl), "stco") {
                let count = u32(moov, stco.start + 12)
                for i in 0..<count {
                    let o = stco.start + 16 + i * 4
                    guard o + 4 <= stco.start + stco.size else { break }
                    let v = u32(moov, o)
                    if UInt64(v) >= moovEnd { putU32(&moov, o, v + delta) }
                }
            }
            if let co64 = child(moov, body(stbl), "co64") {
                let count = u32(moov, co64.start + 12)
                for i in 0..<count {
                    let o = co64.start + 16 + i * 8
                    guard o + 8 <= co64.start + co64.size else { break }
                    let v = (UInt64(u32(moov, o)) << 32) | UInt64(u32(moov, o + 4))
                    if v >= moovEnd {
                        let n = v + UInt64(delta)
                        putU32(&moov, o, Int(n >> 32)); putU32(&moov, o + 4, Int(n & 0xffff_ffff))
                    }
                }
            }
        }

        // Stream the patched file out.
        fm.createFile(atPath: output.path, contents: nil)
        guard let outHandle = try? FileHandle(forWritingTo: output) else { throw CLIError("io", "Cannot write \(output.path)") }
        defer { try? outHandle.close() }
        func copy(from start: UInt64, to end: UInt64) throws {
            try inHandle.seek(toOffset: start)
            var remaining = end - start
            while remaining > 0 {
                let n = Int(min(remaining, 8 * 1024 * 1024))
                guard let chunk = try inHandle.read(upToCount: n), !chunk.isEmpty else { throw CLIError("io", "Unexpected end of file while copying.") }
                try outHandle.write(contentsOf: chunk)
                remaining -= UInt64(chunk.count)
            }
        }
        try copy(from: 0, to: moovAt)
        try outHandle.write(contentsOf: Data(moov))
        try copy(from: moovEnd, to: fileSize)
        return true
    }
}
