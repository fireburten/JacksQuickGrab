# Jack's Picker Privacy Policy

**Effective date:** [EFFECTIVE DATE]

Jack's Picker is a screenshot and annotation app for Mac, made by Rind Works ("we", "us"). This policy explains what happens to your information when you use it. The short version: **we don't collect any of your data.** Everything the app creates stays on your Mac.

## What we collect

Nothing. Jack's Picker has:

- no accounts or sign-in
- no analytics, tracking, or advertising
- no crash reporting or third-party SDKs
- no servers of our own. It connects to the internet only when you send a capture to a service you've set up yourself (see **Sending to other services**).

We can't see your screenshots, recordings, text, or settings, and we never receive them.

## What the app stores on your Mac

- **Captures and recordings** are saved as regular image and video files in your **Pictures ▸ Jack's Picker** folder, or in another folder you choose in **Settings ▸ Storage**.
- **Annotations** (arrows, text, blur, and so on) are saved in a hidden `.annotations` folder inside that folder, so you can edit your markups later.
- **Settings** such as your hotkeys, auto-copy choice, pinned captures, projects, and editor preferences are stored in the app's private container on your Mac.
- **Linked folders:** if you link a project to a folder you choose, the app copies captures you add to that project into it and lists the images and videos already there. It only reads that folder and adds its own copies; it never renames, moves, or deletes your files there. Unlinking leaves the folder as it is.
- **Temporary copies:** when you share a capture or drag it into another app, a copy is written to the app's temporary folder so the receiving app can read it. These copies are deleted automatically after a day.
- **Search index:** so that search can find the words inside your screenshots, the app reads the text in them (on your Mac, see **Text recognition**) and keeps it in its private container. Turning off **Settings ▸ Storage ▸ Search text in captures** deletes it.
- **Brand settings:** the company name, colors and logo you add in **Settings ▸ Brand** are kept in the app's private container, together with a copy of the logo file.
- **Guides:** when you create a guide, the app saves the PDF, or a folder with the page and copies of your screenshots, where you choose. While making a PDF it briefly writes the page to its temporary folder and deletes it straight away. Guides don't load anything from the internet.
- **Thumbnails and pinned images** are windows on your Mac showing captures already saved in your captures folder. Dragging a thumbnail into another app gives that app a copy of the file, just as dragging it from Finder would.
- **Error log:** if something goes wrong, the app writes a short log of the error (the time, the error message, and the names of any files involved) to its private Logs folder. It is never sent anywhere. You can open it from **Settings ▸ Storage ▸ Diagnostic log**, for example to attach it to a support email yourself.

This data stays on your device. It doesn't leave your Mac unless you send it somewhere yourself, for example by copying, dragging, saving, or using the Share button (AirDrop, Mail, Messages, and so on). Anything you share is handled by the app or service you choose. If you use iCloud Drive, Time Machine, or another backup or sync service, those files may be included in it under that service's own terms.

## Sending to other services

Jack's Picker can send a capture to services your team already uses: Slack, Microsoft Teams, Jira, Linear, GitHub, or your own S3-compatible storage (such as Amazon S3 or Cloudflare R2). Nothing is sent until you set up a destination in **Settings ▸ Sharing** and then choose it from **Send to…**.

- **What's sent:** only the capture you chose (with your annotations), plus the title or message you type. It goes straight from your Mac to that service. It never passes through us.
- **Storage links:** Teams and GitHub can't receive image files, so for those the capture is first uploaded to the storage you set up, and the message shows it from there. Links to your storage either expire (from 1 hour to 7 days) or are public, depending on how you set that destination up.
- **Your keys and tokens** are encrypted with a key kept in your Mac's Keychain, and they're only sent to the service they belong to. They're never shown again after you save them.
- **Once it's there,** what you sent is handled under that service's own terms and your organization's settings for it. Deleting it from Jack's Picker doesn't delete it from the service.

Your organization can turn this feature off with a configuration profile (see **Settings from your organization**). To remove a destination and its keys, choose **Remove** next to it in **Settings ▸ Sharing**.

## Screen Recording permission

To take screenshots and screen recordings, macOS requires you to give Jack's Picker **Screen Recording** permission. The app only reads your screen when you start a capture or recording. You can turn this permission off at any time in **System Settings ▸ Privacy & Security ▸ Screen & System Audio Recording**.

## Sound and microphone

Screen recordings can include sound, but only if you turn it on with the 🔊 (your Mac's sound) or 🎙 (microphone) buttons next to Record. Both are off until you switch them on. The first time you turn on the microphone, macOS asks for your permission; you can change it any time in **System Settings ▸ Privacy & Security ▸ Microphone**. Sound is captured only while a recording is running and is saved only inside that recording file on your Mac. GIFs and screenshots never include sound.

## Camera

Screen recordings can show your camera in a small bubble in one corner, but only if you turn it on with the 📷 button next to Record (or in **Settings ▸ Recording**). It's off until you switch it on. The first time you do, macOS asks for your permission; you can change it any time in **System Settings ▸ Privacy & Security ▸ Camera**. The camera is on only while a screen recording is running, a small preview in the capture bar shows when it is, and its picture is saved only inside that recording file on your Mac. GIFs, scrolling captures and screenshots never include the camera.

## Text recognition (OCR)

Features that read text from an image use Apple's Vision framework, which runs **entirely on your Mac**. Images aren't sent anywhere to be processed. These features are Copy OCR Text, Copy Table for Excel, Copy Text from Screen, Smart Redact, the search index, and the optional check for sensitive information before you copy, share or save a capture. That check looks for things like email addresses, card numbers and passwords, and its results are only shown to you.

## Clipboard

Jack's Picker writes to your clipboard when you copy an image or text, or when you turn on auto-copy. It only reads your clipboard when you paste an image into the editor.

## Settings from your organization

If your Mac is managed by your organization, it can fix some of the app's settings with a configuration profile, for example turning on the sensitive-information check or stamping captures "Internal". The app reads those settings on your Mac; nothing is reported back to your organization or to us.

## Deleting your data

- **A single capture:** right-click it in the app's Recents sidebar and choose **Delete**. It moves to the Trash along with its annotations.
- **All captures:** delete the **Pictures ▸ Jack's Picker** folder (or the folder you chose in Settings) in Finder.
- **The search index:** turn off **Settings ▸ Storage ▸ Search text in captures**.
- **Settings:** quit and delete the app, then delete the `~/Library/Containers/com.rindworks.jackspicker` folder (in Finder, choose **Go ▸ Go to Folder…** and paste that path).

## Information Apple may share with us

If you've chosen to share analytics with app developers in your Mac's settings, Apple may give us aggregated, anonymous crash reports and usage statistics through App Store Connect. That data is handled under [Apple's Privacy Policy](https://www.apple.com/legal/privacy/), and you control it in **System Settings ▸ Privacy & Security ▸ Analytics & Improvements**.

## Children

Jack's Picker doesn't collect personal information from anyone, including children.

## Changes to this policy

If we change how the app handles data, we'll update this policy and its effective date. If a future version ever collects data, we'll explain what is collected before that version is released.

## Contact

Questions about this policy: Rind Works, [CONTACT EMAIL]
