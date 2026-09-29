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
Jack's Picker is a screenshot and annotation tool that lives in your menu bar. Press a hotkey, drag to select, and your capture opens in an editor ready to mark up, copy, or save. Everything stays on your Mac unless you send it somewhere.

CAPTURE
• Region, window, or full-screen capture from the menu bar, the floating toolbar, or a global hotkey
• Repeat Last Region grabs the same area again with one keystroke
• Choose a window from live thumbnails, or delay a full-screen capture by 5 seconds
• Record an area of your screen with your Mac's sound, your microphone, and your camera in a corner bubble, or record it as a GIF
• Scrolling capture stitches a long page into one image
• A thumbnail waits in the corner after each capture: drag it into any app, or pin a capture on top of your windows

ANNOTATE
• Arrows, lines, text, boxes, ellipses, highlights, spotlight, freehand drawing, blur, and pixelate
• Numbered steps that count themselves
• Color swatches, custom colors, an eyedropper, and adjustable stroke size
• Move, resize, recolor, duplicate, or reorder any annotation; they stay editable when you reopen a capture
• Crop, rotate, resize, trim to content, and combine images

COPY TEXT AND TABLES
• Copy the text from any capture, or straight from the screen with one hotkey
• Copy Table for Excel turns a screenshot of a table into rows that paste into spreadsheet cells
• Smart Redact finds email addresses, phone and card numbers, IP addresses, keys, and passwords, and covers them for you
• Text recognition runs on your Mac with Apple's Vision framework, in many languages

FOR TEAMS
• Search finds the words inside every screenshot, not just file names
• Turn captures into a step-by-step guide as a PDF, web page, or Markdown
• Your logo as a watermark, your brand colors in the toolbar, and Confidential, Internal, or Draft stamps
• An optional check warns you before you share a capture that shows sensitive information
• Send to Slack, Microsoft Teams, Jira, Linear, or GitHub, or get a link from your own S3-compatible storage
• IT can set and lock settings with a configuration profile

ORGANIZE
• Recent captures sidebar; GIFs and recordings play right in the app
• Edit recordings and GIFs: trim, crop, combine clips, annotate, turn a video into a GIF, or save a frame
• Pin favorites, rename captures, and group them into projects, each linked to a folder if you like
• Drag a capture, annotations included, into any other app

EXPORT
• Copy the annotated image or the original in one click
• Save as PNG or JPG
• Share with AirDrop, Mail, Messages, and more

YOUR SHORTCUTS
• Every capture hotkey can be changed. Defaults:
  ⌘⇧2 Region
  ⌘⇧1 Full screen
  ⌘⌥⇧W Window
  ⌘⌥⇧2 Repeat last region
  ⌘⌥⇧T Copy text from the screen
• The defaults leave macOS's own ⌘⇧3, ⌘⇧4, and ⌘⇧5 alone

PRIVATE BY DESIGN
• No account and no sign-in
• No analytics or tracking
• The app goes online only when you send a capture to a service you've set up
• Captures are saved as regular image files in Pictures ▸ Jack's Picker

In English, German, Spanish, French, and Japanese, with VoiceOver labels and keyboard access throughout.

Jack's Picker needs Screen Recording permission to capture your screen. It asks for the microphone or camera only if you turn them on for a recording. You can change any of these in System Settings ▸ Privacy & Security.
```

3,368 chars (limit 4,000)

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
| Unrestricted web access | No | The app has no browser. Its windows only show bundled pages. It connects only to the services a user sets up for Send to…. |
| User-generated content shared with others / messaging or chat | No | The app has no community, feed or chat of its own. Send to… posts a capture to the user's own team tools (Slack, Jira and so on) under those services' terms; other people using the app never see it. |
| Advertising | No | No ads. |
| Parental controls / age assurance | No | Not applicable. |
| Gambling (real money) | No | None. |

The questionnaire's wording changes from time to time. The rule is simple: the app has no bundled media, no web browsing, and no social features of its own, so the lowest rating applies everywhere.

## What's New in This Version (1.0)

```
First release of Jack's Picker:
• Region, window, full-screen, delayed, repeat-last-region, and scrolling capture
• Annotation editor with arrows, text, shapes, numbered steps, spotlight, blur, and pixelate
• Copy text, or whole tables, from any capture or straight from the screen
• Smart Redact, and an optional check for sensitive information before sharing
• Screen recording with sound and a camera bubble, plus GIFs
• Search inside screenshots, step-by-step guides, and brand watermarks and stamps
• Send to Slack, Teams, Jira, Linear, GitHub, or your own S3 storage
• Customizable global hotkeys, in five languages
```

(Apple may hide this field for a version 1.0 submission. Keep it for the first update.)

---

## Notes for App Review

Paste into **App Review Information ▸ Notes**. Sign-in required: **No** (leave the demo account fields empty).

```
Thank you for reviewing Jack's Picker. A few things to know before you start:

1. WHERE TO FIND THE APP
Jack's Picker is a menu bar app (LSUIElement), so there is no Dock icon and no main window at launch. After launch you'll see:
- A menu bar icon (the Jack's Picker logo). Left-click it to show or hide the floating toolbar. Right-click it for the menu: Capture Region, Repeat Last Region, Capture Window, Capture Full Screen, Copy Text from Screen, Delayed Full Screen (5s), Auto-copy After Capture, Show / Hide HUD, Open Captures Folder, Launch at Login, Settings…, About, and Quit.
- A floating toolbar (the "HUD") near the top left of the screen with Region, Window, Full, Scroll, Record, GIF, and History buttons.
On first launch a short welcome dialog explains this.

2. PERMISSIONS
- Screen Recording (NSScreenCaptureUsageDescription): needed to capture the screen. Without it, macOS only returns the desktop wallpaper. It is used only when the user takes a screenshot or starts a recording. To grant it: System Settings > Privacy & Security > Screen & System Audio Recording > enable Jack's Picker, then quit and reopen the app (macOS requires a relaunch). The app shows a dialog with an "Open Settings" button for that pane. The same permission covers the Mac's own sound when the user turns on 🔊 in the capture bar.
- Microphone (NSMicrophoneUsageDescription): requested only when the user turns on 🎙 next to Record.
- Camera (NSCameraUsageDescription): requested only when the user turns on 📷 next to Record, which shows the camera in a corner of the screen recording.
All three toggles are off by default. The global hotkeys don't need Accessibility or Input Monitoring access.

3. GLOBAL HOTKEYS (all user-configurable in Settings > Capture > Capture hotkeys)
- Capture Region: Command-Shift-2
- Capture Full Screen: Command-Shift-1
- Capture Window: Command-Option-Shift-W
- Repeat Last Region: Command-Option-Shift-2 (does nothing until one region capture has been taken)
- Copy Text from Screen: Command-Option-Shift-T
The defaults avoid the system screenshot shortcuts Command-Shift-3, -4, and -5. A user can choose those, and the app then explains how to turn off the macOS versions in System Settings > Keyboard > Keyboard Shortcuts > Screenshots.

4. SUGGESTED TEST FLOW
Press Command-Shift-2, drag over any area (Esc cancels, Space captures the whole screen). The capture opens in the editor. Try the annotation tools on the left, then Tools > Copy OCR Text or Copy Table for Excel over some on-screen text, and paste into TextEdit or Numbers. Click Record on the toolbar and drag an area to record it; click Stop and the video is saved and revealed in Finder. Settings (Command-comma in the editor) holds the rest.

5. WHERE FILES ARE SAVED
Captures and recordings are saved to ~/Pictures/Jack's Picker (com.apple.security.assets.pictures.read-write entitlement). Annotation data for each capture is kept in a hidden .annotations subfolder there so markups stay editable. Save PNG / Save JPG, guides, and choosing another captures folder use the standard panels (user-selected read-write entitlement). Settings and the search index are kept in the app's sandbox container.

6. PRIVACY / NETWORK
There are no accounts, no login, no analytics, and no third-party SDKs, and we run no servers. The app makes network requests (com.apple.security.network.client) only for Send to…, which is off until the user adds a destination in Settings > Sharing with their own Slack, Microsoft Teams, Jira, Linear, GitHub, or S3-compatible storage credentials. No demo account is needed: everything else works offline. Credentials are encrypted with a key kept in the Keychain. Text recognition (OCR), search and the sensitive-information check run entirely on-device using Apple's Vision framework, through a small helper bundled inside the app.

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
| Description | 4000 | 3,368 |
| Keywords | 100 | 99 |
| What's New | 4000 | 621 |
| Review notes | 4000 | 3,879 (with the `[CONTACT EMAIL]` placeholder) |
