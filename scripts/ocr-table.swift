import Foundation
import Vision
import AppKit

struct OCRItem: Codable {
  let text: String
  let confidence: Float
  let x: CGFloat
  let y: CGFloat
  let w: CGFloat
  let h: CGFloat
  let obsId: Int  // Vision observation index — words sharing an obsId are one logical cell
}

guard CommandLine.arguments.count > 1 else { print("[]"); exit(0) }

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("[]"); exit(0)
}

let width  = CGFloat(cgImage.width)
let height = CGFloat(cgImage.height)

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false  // preserve codes, part numbers, IDs as-is
// macOS 13+: let Vision pick the script/language per observation so non-English
// text (accented Latin, CJK, Cyrillic, ...) is read. With auto-detect on, Vision
// chooses the model itself; in testing, also setting recognitionLanguages to every
// supported language changed nothing, so it's left at its default.
// macOS 12 has no auto-detect; keep English there so behavior is unchanged.
if #available(macOS 13.0, *) {
  request.automaticallyDetectsLanguage = true
} else {
  request.recognitionLanguages = ["en-US"]
}

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

var items: [OCRItem] = []
for (obsIndex, observation) in (request.results ?? []).enumerated() {
  guard let candidate = observation.topCandidates(1).first else { continue }
  let fullText = candidate.string
  var searchStart = fullText.startIndex

  for word in fullText.components(separatedBy: .whitespaces) {
    guard !word.isEmpty else { continue }
    guard let range = fullText.range(of: word, options: .literal, range: searchStart..<fullText.endIndex) else { continue }
    defer { searchStart = range.upperBound }
    guard let box = try? candidate.boundingBox(for: range) else { continue }
    let b = box.boundingBox
    items.append(OCRItem(
      text: word,
      confidence: candidate.confidence,
      x: b.minX * width,
      y: (1 - b.maxY) * height,
      w: b.width * width,
      h: b.height * height,
      obsId: obsIndex
    ))
  }
}

let data = try! JSONEncoder().encode(items)
print(String(data: data, encoding: .utf8) ?? "[]")
