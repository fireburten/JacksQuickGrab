# Jack's Picker — App Store Screenshot Shot List

You need five Mac screenshots, all the same size. Apple accepts **1280×800, 1440×900, 2560×1600, or 2880×1800** (16:10). Aim for **2880×1800**.

The captions are for text you overlay on the images yourself. The Mac App Store has no separate caption field for screenshots. If you'd rather not add overlays, upload the raw screenshots and the captions become optional.

---

## One-time setup

1. **Use the real build.** Run the App Store dev build (`npm run build:mas-dev`) or a packaged build, so the menu bar icon, name, and save folder match what reviewers will see.
2. **Clean the Mac:**
   - Use a plain, dark wallpaper (System Settings ▸ Wallpaper). The app's purple UI looks best on dark.
   - Set Appearance to Dark (System Settings ▸ Appearance).
   - Turn on Do Not Disturb so notifications don't appear.
   - Hide desktop icons: `defaults write com.apple.finder CreateDesktop false && killall Finder`. Undo with `true` when you're finished.
   - Remove clutter from the menu bar: ⌘-drag extra icons out, and turn off the user name and battery percentage.
   - Quit apps you don't need. Don't show anything personal, and don't show third-party logos or brand UI in the content you capture.
3. **Grant Screen Recording** to Jack's Picker, and to Terminal because you'll take the final shots with `screencapture`. System Settings ▸ Privacy & Security ▸ Screen & System Audio Recording. Relaunch both after granting.
4. **Make demo content with fake data only**, for example:
   - `sales.numbers`: a small table with columns **Region / Q1 / Q2 / Q3 / Total** and 5–6 rows of made-up numbers.
   - `contact.txt` in TextEdit, 18pt or larger:
     ```
     Customer: Jane Example
     Email: jane.doe@example.com
     Phone: (555) 010-4477
     Card: 4111 1111 1111 1111
     API key: demo_key_4f9a8c2e7b1d6a3f5e0c9b8a
     Notes: Follow up next Tuesday about the renewal.
     ```
   - A neutral subject for the hero shot, such as a simple chart in Numbers or a web page you own.
5. **Take a few throwaway captures first** so the Recents sidebar has content. Rename a few of them to friendly names (right-click ▸ Rename, e.g. "Q3 dashboard", "Onboarding flow", "Bug – login button"). Pin two of them, and create one or two projects (＋ New Project Folder).

### How to take each final shot (exact size, no cropping)

Capture a fixed **1440×900-point** rectangle with the built-in `screencapture` tool. On a Retina display this saves exactly **2880×1800** pixels. On a non-Retina display it saves 1440×900, which Apple also accepts.

```bash
# 10-second timer, fixed 1440x900 pt rectangle at the top-left of the main display, JPEG (no alpha channel)
screencapture -T 10 -t jpg -R0,0,1440,900 ~/Desktop/01-editor.jpg

# check the size
sips -g pixelWidth -g pixelHeight ~/Desktop/01-editor.jpg
```

- Arrange every window you want in the shot inside the top-left 1440×900 of your main display.
- The 10-second timer (`-T 10`) gives you time to open menus or start a drag. You'll hear the shutter sound when the shot is taken.
- JPEG output avoids the alpha channel that App Store Connect rejects.
- For **shot 5**, which needs the menu bar icon, the rectangle must include the right-hand side of the menu bar. Set `x` = (your screen width in points − 1440). Find the width in points with `system_profiler SPDisplaysDataType | grep "UI Looks like"`. For example, a 1512-point-wide screen uses `-R72,0,1440,900`.

---

## Shot 1: Annotate anything (hero)

**Caption:** Capture, mark up, and copy in seconds

**What it shows:** The editor window filling the frame, with a capture carrying several annotations: a purple arrow pointing at a key element, a red box, a yellow highlight, a short text label, and one blurred area. Recents sidebar visible on the left, tools on the left edge, toolbar along the bottom.

**Steps**
1. Open your hero subject (e.g. the Numbers chart) and press **⌘⇧2**. Drag over it.
2. In the editor, add an **Arrow (A)**, a **Box (B)** in red, a **Highlight (H)**, a **Text (T)** label (e.g. "Revenue up 18%"), and a small **Blur (R)** over a detail.
3. Press **S** (Select) and click empty canvas so no selection handles show. Click **Fit** in the toolbar.
4. Move the editor window to the top-left and resize it to about 1440×900 (it shouldn't spill past the rectangle).
5. Run `screencapture -T 10 -t jpg -R0,0,1440,900 ~/Desktop/01-editor.jpg`, then leave the mouse still until the shutter sound.

## Shot 2: One hotkey, drag, done

**Caption:** Drag to capture any part of your screen

**What it shows:** The region-selection overlay in the middle of a drag: dimmed screen, bright purple selection with corner handles and crosshair guides, the "1024 × 640 px"-style size badge, and the hint bar at the bottom ("Drag to select · Space full screen · Esc cancel").

**Steps**
1. Put an attractive subject on screen (e.g. the sales table plus a chart) within the top-left 1440×900.
2. Run `screencapture -T 10 -t jpg -R0,0,1440,900 ~/Desktop/02-region.jpg`.
3. Right away, press **⌘⇧2**, press the mouse down, drag a selection around the subject, and **keep holding the mouse button** until you hear the shutter.
4. Press **Esc** to cancel the capture.

## Shot 3: Copy a table into a spreadsheet

**Caption:** Turn a screenshot of a table into spreadsheet rows

**What it shows:** Left: the editor with a capture of the sales table. Right: a new Numbers sheet showing the same data pasted into separate cells, with the "Table copied for Excel" toast visible in the editor if you can time it.

**Steps**
1. Open `sales.numbers`, press **⌘⇧2**, and capture just the table.
2. In the editor: **Tools ▸ Copy Table for Excel**.
3. Open a new blank Numbers document, click cell **A1**, and press **⌘V**. Check that each value landed in its own cell.
4. Tile the windows: editor on the left (~60%), Numbers on the right (~40%), both inside the top-left 1440×900.
5. Take the shot: `screencapture -T 10 -t jpg -R0,0,1440,900 ~/Desktop/03-table.jpg`. To catch the toast, click **Tools ▸ Copy Table for Excel** again about 1 second before the timer ends.

Use Numbers, not Microsoft Excel, in the screenshot. That keeps third-party trademarks and branded UI out of your App Store images.

## Shot 4: Smart Redact

**Caption:** Blur emails, phone numbers, and keys in one click

**What it shows:** The editor with a capture of `contact.txt`. The email, phone, card, and API key lines are blurred, while "Customer: Jane Example" and the Notes line stay readable, so it's obvious only the sensitive lines were hidden.

**Steps**
1. Open `contact.txt`, press **⌘⇧2**, and capture the text.
2. In the editor: **Tools ▸ Smart Redact**. Wait for the "Redacted N items" toast.
3. Press **S** and click empty canvas to clear the selection, then click **Fit**.
4. Arrange the editor in the top-left 1440×900 and run `screencapture -T 10 -t jpg -R0,0,1440,900 ~/Desktop/04-redact.jpg`.

Optional: shoot a matching "before" version first (the same capture before Smart Redact) and combine the two side by side in your design tool before adding the caption.

## Shot 5: Lives in your menu bar, keeps everything organized

**Caption:** Always one hotkey away, every capture saved

**What it shows:** The Jack's Picker menu bar menu open (Capture Region, Repeat Last Region, Capture Window, Capture Full Screen with their shortcuts, Delayed Full Screen, Auto-copy After Capture). The floating HUD toolbar is visible, and behind it the editor with the Recents sidebar widened to show named, pinned captures (gold border) and a project list.

**Steps**
1. Click **History** on the HUD to open the editor. Drag the sidebar divider to widen Recents so thumbnails and names are easy to read.
2. Place the editor so it sits inside the **right-aligned** 1440×900 rectangle (see "How to take each final shot"). Drag the HUD by its logo so it floats over an empty corner of the editor.
3. Make sure one region capture was taken this session, so **Repeat Last Region** is enabled in the menu rather than greyed out.
4. Run `screencapture -T 10 -t jpg -R<x>,0,1440,900 ~/Desktop/05-menubar.jpg` with your computed `x`.
5. Right away, **right-click** the Jack's Picker menu bar icon to open its menu, and leave it open until the shutter sound.

---

## Before uploading

- All five files are the same size (e.g. 2880×1800): run `sips -g pixelWidth -g pixelHeight ~/Desktop/0*.jpg`.
- No real personal data, notifications, or third-party logos are visible.
- Nothing shown should be disabled or "coming soon". All HUD buttons, including **Scroll** and **GIF**, now work.
- Upload in order 1 → 5. The first one or two appear in search results, so lead with the hero and the region capture.
- Recording isn't in these five shots on purpose. While recording, the red "REC" border is excluded from all screen captures (content protection keeps it out of the video), so a screenshot would show only the HUD timer and **Stop** button. If you want a recording shot, add the border in your design tool.
