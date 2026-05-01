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
}

guard CommandLine.arguments.count > 1 else {
  print("[]")
  exit(0)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let image = NSImage(contentsOf: url),
      let cgImage = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("[]")
  exit(0)
}

let width = CGFloat(cgImage.width)
let height = CGFloat(cgImage.height)
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
try? handler.perform([request])

let items = (request.results ?? []).compactMap { observation -> OCRItem? in
  guard let candidate = observation.topCandidates(1).first else { return nil }
  let b = observation.boundingBox
  return OCRItem(
    text: candidate.string,
    confidence: candidate.confidence,
    x: b.minX * width,
    y: (1 - b.maxY) * height,
    w: b.width * width,
    h: b.height * height
  )
}

let data = try! JSONEncoder().encode(items)
print(String(data: data, encoding: .utf8) ?? "[]")
