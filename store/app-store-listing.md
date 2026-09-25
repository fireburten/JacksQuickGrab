# Jack's Picker — App Store Connect Listing (macOS, v1.0)

Paste-ready copy for App Store Connect. Character counts were checked with Python `len()` (Apple counts characters, not bytes). Limits are in brackets.

---

## App name [30]

| Option | Text | Chars |
|---|---|---|
| **Primary** | `Jack's Picker` | 13 |
| Alternate 1 | `Jack's Picker: Screenshot Tool` | 30 |
| Alternate 2 | `Jack's Picker: Snap & Mark Up` | 29 |

Use an alternate only if the plain name is already taken on the store. If you use one, don't also repeat its extra words in Keywords.

## Subtitle [30]

`Capture, Annotate & Copy Text` (29 chars)

## Promotional text [170]

Can be changed at any time without submitting a new version.

```
Grab a region, window, or full screen with one hotkey, mark it up, and copy it anywhere. Pull text or whole tables out of any screenshot, right on your Mac.
```

156 chars

## Description [4000]

Plain text. Paste everything inside the block as-is.

```
Jack's Picker is a screenshot and annotation tool that lives in your menu bar. Press a hotkey, drag to select, and your capture opens in an editor ready to mark up, copy, or save. Everything stays on your Mac.

CAPTURE
• Region, window, or full-screen capture from the menu bar, the floating toolbar, or a global hotkey
• Repeat Last Region grabs the same area again with one keystroke
• Choose a window from live thumbnails of your open windows
• Delayed full-screen capture (5 seconds) from the menu bar
• Live pixel-size readout while you drag; press Space to take the whole screen instead
• Record a selected area of your screen to a video file
• Optional auto-copy puts every new capture straight on your clipboard

ANNOTATE
• Arrows, text, boxes, highlights, freehand drawing, and blur
• Color swatches, custom colors, an eyedropper, and adjustable stroke size
• Select any annotation to move, resize, recolor, change opacity, duplicate, or reorder it
• Crop, rotate, resize, and trim to content
• Paste or drag in other images to combine them in one canvas
• Undo and redo
• Annotations stay editable: reopen a capture later and pick up where you left off

COPY TEXT AND TABLES
• Copy OCR Text pulls the text out of a capture and puts it on your clipboard
• Copy Table for Excel turns a screenshot of a table into tab-separated rows that paste straight into spreadsheet cells
• Smart Redact finds email addresses, phone numbers, card-style numbers, and key- or password-like text, then blurs them for you
• Text recognition runs on your Mac using Apple's Vision framework and reads text in many languages, including Chinese, Japanese and Korean (macOS 13 or later)

ORGANIZE
• Recent captures sidebar with search
• Pin favorites, rename captures, and group them into projects
• Drag a capture, annotations included, from the sidebar into any other app
• Reveal in Finder, or delete to the Trash

EXPORT
• Copy the annotated image, or the untouched original, in one click
• Save as PNG or JPG

YOUR SHORTCUTS
• Every capture hotkey can be changed. Defaults:
  ⌘⇧2 Region
  ⌘⇧1 Full screen
  ⌘⌥⇧W Window
  ⌘⌥⇧2 Repeat last region
• macOS's own ⌘⇧3, ⌘⇧4, and ⌘⇧5 are left alone
• The floating toolbar can be collapsed to a small button or hidden from the menu bar

PRIVATE BY DESIGN
• No account and no sign-in
• No analytics, no tracking, and no network connections
• Captures are saved as regular image files in Pictures ▸ Jack's Picker

Jack's Picker needs Screen Recording permission to capture your screen. macOS will ask the first time, and you can change it any time in System Settings ▸ Privacy & Security.
```

2,618 chars (limit 4,000)

## Keywords [100]

Comma-separated, no spaces after commas. Avoids words already in the name and subtitle (jack, picker, capture, annotate, copy, text), since Apple indexes those separately.

```
screenshot,screen,snip,markup,ocr,table,spreadsheet,blur,redact,recorder,arrow,crop,hotkey,menu bar
```

99 chars

## Categories

- **Primary:** Productivity
- **Secondary:** Graphics & Design

Most screenshot and markup utilities sit in Productivity, and that's where people browse for them. Graphics & Design is a good second category because of the annotation editor.

Note: `package.json` sets `mac.category` to `public.app-category.graphics-design` (the `LSApplicationCategoryType` in Info.plist). App Store Connect doesn't require that value to match, but if you'd like it to, change it to `public.app-category.productivity` or pick Graphics & Design as the primary category.

## Age rating

Answer **None** or **No** to every question. The app gets the lowest rating (4+).

| Question area | Answer | Why |
|---|---|---|
| Violence (cartoon, realistic, graphic), sexual content, nudity, profanity, horror/fear themes, mature/suggestive themes | None | The app ships no content of its own. It only shows what the user captures from their own screen. |
| Alcohol, tobacco, drugs; simulated gambling; contests | None | None of these appear in the app. |
| Medical or wellness information | None | None. |
| Unrestricted web access | No | The app has no browser and makes no network requests. Its windows only show bundled pages. |
| User-generated content shared with others / messaging or chat | No | Captures stay on the user's Mac. Nothing is uploaded, shared with other users, or sent anywhere. |
| Advertising | No | No ads. |
| Parental controls / age assurance | No | Not applicable. |
| Gambling (real money) | No | None. |

The questionnaire's wording changes from time to time. The rule is simple: the app has no bundled media, no web access, and no social features, so the lowest rating applies everywhere.

## What's New in This Version (1.0)

```
First release of Jack's Picker:
• Region, window, full-screen, delayed, and repeat-last-region capture
• Annotation editor with arrows, text, boxes, highlights, drawing, and blur
• Copy text, or whole tables, from any capture using on-device text recognition
• Smart Redact to blur emails, phone numbers, and keys
• Screen recording of a selected area
• Recent captures with search, pins, rename, and projects
• Customizable global hotkeys
```

(Apple may hide this field for a version 1.0 submission. Keep it for the first update.)

---

## Notes for App Review

Paste into **App Review Information ▸ Notes**. Sign-in required: **No** (leave the demo account fields empty).

```
Thank you for reviewing Jack's Picker. A few things to know before you start:

1. WHERE TO FIND THE APP
Jack's Picker is a menu bar app (LSUIElement), so there is no Dock icon and no main window at launch. After launch you'll see:
- A menu bar icon (the Jack's Picker logo). Left-click it to show or hide the floating toolbar. Right-click it for the menu: Capture Region, Repeat Last Region, Capture Window, Capture Full Screen, Delayed Full Screen (5s), Auto-copy After Capture, Show / Hide HUD, Open Captures Folder, and Quit.
- A floating toolbar (the "HUD") near the top left of the screen with Region, Window, Full, Record, and History buttons.
On first launch a short welcome dialog explains this.

2. SCREEN RECORDING PERMISSION
Capturing the screen requires the macOS Screen Recording permission (NSScreenCaptureUsageDescription is set). Without it, macOS only returns the desktop wallpaper. It is used only when the user takes a screenshot or starts a recording. To grant it: System Settings > Privacy & Security > Screen & System Audio Recording > enable Jack's Picker, then quit and reopen the app (macOS requires a relaunch). The app shows a dialog with an "Open Settings" button that links directly to that pane. No other permissions are requested. The global hotkeys don't need Accessibility or Input Monitoring access.

3. GLOBAL HOTKEYS (all user-configurable in the editor under Tools > Capture Hotkeys)
- Capture Region: Command-Shift-2
- Capture Full Screen: Command-Shift-1
- Capture Window: Command-Option-Shift-W
- Repeat Last Region: Command-Option-Shift-2 (does nothing until one region capture has been taken)
The defaults deliberately avoid the system screenshot shortcuts Command-Shift-3, -4, and -5, and the app refuses to assign those.

4. SUGGESTED TEST FLOW
Press Command-Shift-2, drag over any area (Esc cancels, Space captures the whole screen). The capture opens in the editor. Try the annotation tools on the left, then Tools > Copy OCR Text or Copy Table for Excel over some on-screen text, and paste into TextEdit or Numbers. Click Record on the toolbar and drag an area to record it; click Stop and the video is saved and revealed in Finder.

5. WHERE FILES ARE SAVED
Captures and recordings are saved to ~/Pictures/Jack's Picker (com.apple.security.assets.pictures.read-write entitlement). Annotation data for each capture is kept in a hidden .annotations subfolder there so markups stay editable. Save PNG / Save JPG use the standard save panel (user-selected read-write entitlement). Settings are kept in the app's sandbox container.

6. PRIVACY / NETWORK
The app makes no network requests. There are no accounts, no login, no analytics, and no third-party SDKs. Text recognition (OCR) runs entirely on-device using Apple's Vision framework, through a small helper bundled inside the app.

Contact: [CONTACT EMAIL]
```

---

## Character count verification

Output from the Python check (`len()` on each field exactly as written above):

| Field | Limit | Count |
|---|---|---|
| Name | 30 | 13 |
| Alternate name 1 | 30 | 30 |
| Alternate name 2 | 30 | 29 |
| Subtitle | 30 | 29 |
| Promotional text | 170 | 156 |
| Description | 4000 | 2,618 |
| Keywords | 100 | 99 |
| What's New | 4000 | 439 |
| Review notes | 4000 | 2,855 (with the `[CONTACT EMAIL]` placeholder) |
