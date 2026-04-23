# CHM Finance — Mobile Setup (Capacitor)

Package the web app as a native iOS + Android app via [Capacitor](https://capacitorjs.com).
Fastest path to Google Play / App Store without rewriting in React Native.

**Two modes** — pick one before first build:

| Mode     | WebView source                | Update path              | Use when                                   |
|----------|-------------------------------|--------------------------|--------------------------------------------|
| `remote` | https://chmup.top (live)      | Deploy backend → done    | Default. No store resubmission for UI changes. |
| `bundle` | `mobile/www` (offline copy)   | Rebuild + resubmit APK   | Need offline-first shell / no-network UX.  |

Current default: **remote**. Change via `CHM_MOBILE_MODE=bundle` env var.

---

## One-time setup

Prerequisites on your dev machine:

| Target   | You need                                          |
|----------|---------------------------------------------------|
| Android  | [Android Studio](https://developer.android.com/studio) (bundles SDK + ADB + emulator) |
| iOS      | macOS + Xcode ≥ 15 + CocoaPods (`brew install cocoapods`) |
| Both     | Node 18+, JDK 17+ (Android)                        |

Install deps:

```bash
cd mobile
npm install
```

Initialize Capacitor + add native platforms:

```bash
# Android (always)
npx cap add android

# iOS (macOS only)
npx cap add ios
```

This creates `mobile/android/` and `mobile/ios/` directories with native
projects. Commit these — they contain customizable native code (icons,
splash screens, signing configs).

---

## Running on a simulator / device

### Android

```bash
cd mobile
npm run build:www          # prep www/ (remote: no-op; bundle: copies frontend)
npx cap sync android       # sync config + plugins into native project

# Option A — open in Android Studio to run on emulator / device
npx cap open android

# Option B — direct CLI run (needs a booted emulator or USB device)
npx cap run android
```

### iOS

```bash
cd mobile
npm run build:www
npx cap sync ios
npx cap open ios           # opens Xcode; hit Play to run on simulator
```

---

## After UI changes on the website

- **Remote mode**: nothing to do. Mobile WebView already points at
  `chmup.top`; users refresh or re-open the app.
- **Bundle mode**: rebuild www + resync:
  ```bash
  CHM_MOBILE_MODE=bundle npm --prefix mobile run build:www
  cd mobile && npx cap sync
  ```
  Then reinstall the app on the device (or resubmit to the store for
  production release).

---

## Customising app icons + splash

Icons go in:
- Android: `mobile/android/app/src/main/res/mipmap-*/ic_launcher*.png`
- iOS: `mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/`

Recommended tool: [`@capacitor/assets`](https://github.com/ionic-team/capacitor-assets)
— drop a single `resources/icon.png` (1024×1024) + `resources/splash.png`
(2732×2732) and run `npx @capacitor/assets generate`.

---

## Publishing

### Google Play

1. Android Studio → **Build → Generate Signed Bundle / APK** → Android App Bundle
2. Upload `.aab` to [Play Console](https://play.google.com/console) → Internal
   testing → Production
3. Review privacy policy URL points at `https://chmup.top/privacy.html`
4. Fee: $25 one-time Google Developer account

### App Store

1. Apple Developer account: **$99/year** (required)
2. Xcode → **Product → Archive** → **Distribute → App Store Connect**
3. App Store Connect: screenshots (phone + tablet sizes), privacy nutrition
   label, review notes
4. Review typically 1–3 days

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| White screen on launch (remote mode) | Check `server.url` in `capacitor.config.ts` — must be full `https://` URL, not relative |
| `Network request failed` inside app | iOS: add your API domain to `NSAppTransportSecurity` exceptions in `Info.plist` (usually unnecessary when using real https certs) |
| Push notifications silent | You need a Firebase project (Android) + APNs cert (iOS) wired up to `@capacitor/push-notifications` — out of scope for this MVP |
| "Command not found: cap" | Run via `npx cap …` or install globally: `npm i -g @capacitor/cli` |
| App too big (>100 MB) | Bundle mode shouldn't cause this; check `mobile/www/` for accidentally-included `node_modules/` or backups |

---

## Future work

- **Deep links** (`chm://bot/123`) — add `appLinks` to Android manifest +
  Associated Domains to iOS entitlements
- **Native push** wired to our `push_subscriptions` table
- **Biometric auth** (FaceID / Fingerprint) for app-level unlock on top
  of existing JWT — Capacitor plugin `@aparajita/capacitor-biometric-auth`
- **Hermes / V8 tweaks** for performance if WebView feels sluggish — or
  migrate to React Native if we need true native UI
