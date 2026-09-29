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

Under Apple's definition, "collect" means sending data off the device in a way that lets the developer or its third-party partners (SDKs and vendors whose code is in the app) access it. Jack's Picker never does that. It has no analytics, no crash reporting, no accounts, no SDKs, and no servers of ours. The only network requests are the optional **Send to…** feature: when the user sends a capture to a destination they set up themselves (their own S3-compatible storage, Slack, Jira, Linear, Teams or GitHub), the Mac talks to that service directly with the user's own credentials. We never receive or can access that data, and those services aren't our partners. Its windows only load pages bundled in the app, and its fonts are bundled too. Screenshots, recordings, and annotations are written only to the user's own Mac, in ~/Pictures/Jack's Picker, with editable annotation data in a hidden `.annotations` subfolder there. Settings (hotkeys, auto-copy, pins, projects, and editor preferences) stay in the app's sandbox container. Text recognition (Copy OCR Text, Copy Table for Excel, Smart Redact) runs on-device through Apple's Vision framework. The app reads screen contents only when the user starts a capture or recording (with the macOS Screen Recording permission), records system audio or the microphone only during a screen recording when the user has turned that on (microphone with the macOS Microphone permission), shows the camera in a screen recording only when the user has turned on 📷 (with the macOS Camera permission), and reads the clipboard only when the user pastes into the editor. Recorded audio and camera video are saved only inside the recording file on the user's Mac. The search index of text in screenshots, the brand logo and the error log stay in the app's container. Because nothing reaches us or any partner, no data type is collected.

Reminder: if a future version adds a network feature that reaches us or a partner, a crash reporter, analytics, or a third-party SDK, redo this questionnaire before that release.

---

## Export compliance (encryption)

**Answer: the app uses no non-exempt encryption.**

- Info.plist includes `ITSAppUsesNonExemptEncryption` = `false`, set in `package.json` under `build.mac.extendInfo`. With this key present, App Store Connect doesn't ask the encryption questions for each build.
- If App Store Connect asks anyway (for example, if the key is missing from a build):
  - "Does your app use encryption?" → **No**
  - Newer form ("What type of encryption algorithms does your app implement?") → **None of the algorithms mentioned above**
- Why: Jack's Picker doesn't implement its own encryption. **Send to…** uses standard HTTPS (TLS from the Electron/Chromium runtime), which is exempt. Its request signing for S3-compatible storage (HMAC-SHA256) is authentication, not encryption. Saved service credentials are protected with the macOS Keychain (Electron `safeStorage`), which is operating-system encryption.
- No export compliance documentation (CCATS / ERN) is needed.
