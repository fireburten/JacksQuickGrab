# ocr-table.ps1 - Windows OCR via Windows.Media.Ocr (WinRT, built into Win10+)
# Returns JSON array of { text, confidence, x, y, w, h } in pixel coords.
# Usage: powershell -File ocr-table.ps1 <imagePath>

param([string]$ImagePath)

if (-not $ImagePath -or -not (Test-Path $ImagePath)) {
    Write-Output '[]'
    exit 0
}

# Await a WinRT IAsyncOperation<T> synchronously
function Await-WinRT {
    param($AsyncOp, [type]$ResultType)
    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object { $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 } |
        Select-Object -First 1
    if (-not $method) { throw 'AsTask not found — requires System.Runtime.WindowsRuntime' }
    $method.MakeGenericMethod($ResultType).Invoke($null, @($AsyncOp)).GetAwaiter().GetResult()
}

try {
    Add-Type -AssemblyName 'System.Runtime.WindowsRuntime' -ErrorAction Stop

    # Load WinRT types
    $null = [Windows.Media.Ocr.OcrEngine,           Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.Streams.DataWriter,     Windows.Foundation, ContentType = WindowsRuntime]

    # Stream image bytes into a WinRT InMemoryRandomAccessStream
    $bytes  = [System.IO.File]::ReadAllBytes($ImagePath)
    $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
    $writer = [Windows.Storage.Streams.DataWriter]::new($stream)
    $writer.WriteBytes($bytes)
    $null   = Await-WinRT ($writer.StoreAsync()) ([uint32])
    $writer.DetachStream()
    $stream.Seek(0)

    # Decode to SoftwareBitmap
    $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) `
                           ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap  = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) `
                           ([Windows.Graphics.Imaging.SoftwareBitmap])

    # Create OCR engine from the user's language profile
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) {
        # Fallback: try English explicitly
        $lang   = [Windows.Globalization.Language]::new('en-US')
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
    }
    if (-not $engine) {
        Write-Output '[]'
        exit 0
    }

    # Run OCR
    $result = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    # Collect word-level items with pixel bounding boxes.
    # obsId = line index so the JS can reconstruct multi-word cells.
    $items = [System.Collections.Generic.List[hashtable]]::new()
    $lineIndex = 0
    foreach ($line in $result.Lines) {
        foreach ($word in $line.Words) {
            $b = $word.BoundingRect
            $items.Add(@{
                text       = $word.Text
                confidence = 0.95
                x          = [Math]::Round($b.X, 1)
                y          = [Math]::Round($b.Y, 1)
                w          = [Math]::Round($b.Width, 1)
                h          = [Math]::Round($b.Height, 1)
                obsId      = $lineIndex
            })
        }
        $lineIndex++
    }

    if ($items.Count -eq 0) {
        Write-Output '[]'
    } else {
        # ConvertTo-Json wraps a single item in an object, not array — force array
        $arr = @($items)
        Write-Output ($arr | ConvertTo-Json -Compress -Depth 3)
    }

} catch {
    Write-Output '[]'
}
