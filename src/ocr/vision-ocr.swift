// Local OCR helper for proton-drive-mcp (macOS only). Compiled on first use with `swiftc -O` into the
// private cache directory; see src/services/ocr.ts. Nothing here touches the network.
//
// usage: vision-ocr <absolute path to an image or PDF> <max pages> [languages, comma separated] [max image pixels]
// stdout: {"engine":"vision","totalPages":N,"pages":[{"page":1,"text":"..."}]}
// A failure prints one line to stderr (never recognized text) and exits non-zero.
import Foundation
import Vision
import PDFKit
import AppKit
import ImageIO

let PDF_DPI = 200.0
let MAX_SIDE_PIXELS = 9000.0
let DEFAULT_MAX_IMAGE_PIXELS = 100_000_000.0

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3, let maxPages = Int(args[2]), maxPages >= 1 else { fail("usage: vision-ocr <path> <max pages> [languages]") }
let path = args[1]
// The pixel limit comes from the caller (PROTON_DRIVE_OCR_MAX_PIXELS); a value that is not a positive number is refused, not ignored.
var maxImagePixels = DEFAULT_MAX_IMAGE_PIXELS
if args.count > 4 {
    guard let v = Double(args[4]), v.isFinite, v > 0 else { fail("invalid pixel limit") }
    maxImagePixels = v
}
let requested = args.count > 3 ? args[3].split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } : []

// Languages are matched by primary subtag against what Vision supports, so an unsupported language is dropped, never an error.
// Three-letter codes (eng, pol) are mapped to their two-letter form (en, pl).
func primarySubtag(_ code: String) -> String {
    let base = code.replacingOccurrences(of: "_", with: "-").split(separator: "-").first.map(String.init)?.lowercased() ?? ""
    if base.count == 3, let two = Locale.LanguageCode(base).identifier(.alpha2) { return two.lowercased() }
    return base
}

func makeRequest() -> VNRecognizeTextRequest {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    request.automaticallyDetectsLanguage = true
    if !requested.isEmpty, let supported = try? request.supportedRecognitionLanguages() {
        let wanted = Set(requested.map(primarySubtag))
        let chosen = supported.filter { wanted.contains(primarySubtag($0)) }
        if !chosen.isEmpty {
            request.recognitionLanguages = chosen
            request.automaticallyDetectsLanguage = false
        }
    }
    return request
}

func recognize(_ image: CGImage, orientation: CGImagePropertyOrientation) -> String {
    let request = makeRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: orientation, options: [:])
    do { try handler.perform([request]) } catch { fail("Vision could not recognize the image: \(error.localizedDescription)") }
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    return lines.joined(separator: "\n")
}

var pages: [[String: Any]] = []
var totalPages = 1
let url = URL(fileURLWithPath: path)

if url.pathExtension.lowercased() == "pdf" {
    guard let doc = PDFDocument(url: url) else { fail("could not open the PDF") }
    if doc.isLocked { fail("the PDF is password protected") }
    totalPages = doc.pageCount
    for i in 0..<min(totalPages, maxPages) {
        guard let page = doc.page(at: i) else { continue }
        // Pixel size at ~200 dpi, rotation-aware, with a ceiling so a huge page cannot exhaust memory.
        var box = page.bounds(for: .mediaBox)
        if page.rotation % 180 != 0 { box = CGRect(x: 0, y: 0, width: box.height, height: box.width) }
        if box.width < 1 || box.height < 1 { continue }
        let scale = min(PDF_DPI / 72.0, MAX_SIDE_PIXELS / max(box.width, box.height))
        let size = CGSize(width: (box.width * scale).rounded(), height: (box.height * scale).rounded())
        autoreleasepool {
            let thumb = page.thumbnail(of: size, for: .mediaBox)
            var rect = CGRect(origin: .zero, size: thumb.size)
            if let cg = thumb.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
                pages.append(["page": i + 1, "text": recognize(cg, orientation: .up)])
            }
        }
    }
} else {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
          CGImageSourceGetCount(source) > 0 else { fail("could not read the image") }
    let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    // Fail closed: a missing, zero or non-numeric width or height is a refusal, never "small enough". The header can be a NSNumber, Int or Double.
    func dimension(_ value: Any?) -> Double? {
        if let n = value as? NSNumber { let d = n.doubleValue; return d.isFinite && d > 0 ? d : nil }
        if let i = value as? Int { return i > 0 ? Double(i) : nil }
        if let d = value as? Double { return d.isFinite && d > 0 ? d : nil }
        return nil
    }
    guard let w = dimension(props?[kCGImagePropertyPixelWidth]), let h = dimension(props?[kCGImagePropertyPixelHeight]) else { fail("the image size could not be determined") }
    if w * h > maxImagePixels { fail("the image is too large to read safely") }
    guard let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { fail("could not decode the image") }
    if Double(image.width) * Double(image.height) > maxImagePixels { fail("the image is too large to read safely") }
    let raw = (props?[kCGImagePropertyOrientation] as? UInt32) ?? 1
    let orientation = CGImagePropertyOrientation(rawValue: raw) ?? .up
    pages.append(["page": 1, "text": recognize(image, orientation: orientation)])
}

let out: [String: Any] = ["engine": "vision", "totalPages": totalPages, "pages": pages]
guard let data = try? JSONSerialization.data(withJSONObject: out) else { fail("could not encode the result") }
FileHandle.standardOutput.write(data)
