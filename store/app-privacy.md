# Jack's Picker — App Privacy & Export Compliance Answers

For App Store Connect ▸ App Privacy, and the encryption / export compliance question.

---

## App Privacy questionnaire

**Do you or your third-party partners collect data from this app?**
→ **No, we do not collect data from this app.**

The resulting label is **Data Not Collected**. Because of that answer, the per-category questions (Contact Info, Health & Fitness, Financial Info, Location, Sensitive Info, Contacts, User Content, Browsing History, Search History, Identifiers, Purchases, Usage Data, Diagnostics, Other Data) are skipped.

| Related question | Answer |
|---|---|
| Data used to track you | None |
| Data linked to you | None |
| Data not linked to you | None |
| Third-party SDKs (analytics, ads, crash reporting) | None included |
| Privacy Policy URL | Public URL where `store/privacy-policy.md` is hosted (required) |

### Justification

Under Apple's definition, "collect" means sending data off the device in a way that lets the developer or a third party access it. Jack's Picker never does that. The app makes no network requests at all: no analytics, no crash reporting, no accounts, and no servers. Its windows only load pages bundled in the app, and its fonts are bundled too. Screenshots, recordings, and annotations are written only to the user's own Mac, in ~/Pictures/Jack's Picker, with editable annotation data in a hidden `.annotations` subfolder there. Settings (hotkeys, auto-copy, pins, projects, and editor preferences) stay in the app's sandbox container. Text recognition (Copy OCR Text, Copy Table for Excel, Smart Redact) runs on-device through Apple's Vision framework. The app reads screen contents only when the user starts a capture or recording (with the macOS Screen Recording permission), records system audio or the microphone only during a screen recording when the user has turned that on (microphone with the macOS Microphone permission), and reads the clipboard only when the user pastes into the editor. Recorded audio is saved only inside the recording file on the user's Mac. Because nothing leaves the device, no data type is collected.

Reminder: if a future version adds any network feature, crash reporter, analytics, or third-party SDK, redo this questionnaire before that release.

---

## Export compliance (encryption)

**Answer: the app uses no non-exempt encryption.**

- Info.plist includes `ITSAppUsesNonExemptEncryption` = `false`, set in `package.json` under `build.mac.extendInfo`. With this key present, App Store Connect doesn't ask the encryption questions for each build.
- If App Store Connect asks anyway (for example, if the key is missing from a build):
  - "Does your app use encryption?" → **No**
  - Newer form ("What type of encryption algorithms does your app implement?") → **None of the algorithms mentioned above**
- Why: Jack's Picker doesn't implement or call any encryption, and it makes no network connections. The Electron/Chromium runtime includes standard TLS libraries, but the app never uses them. Even if it did, standard HTTPS/TLS encryption would be exempt.
- No export compliance documentation (CCATS / ERN) is needed.
