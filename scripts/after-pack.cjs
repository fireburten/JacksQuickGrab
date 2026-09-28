// electron-builder afterPack hook: switches off Electron features the shipped app doesn't use
// ("fuses", baked into the Electron binary). Left on, any program could run its own code inside
// Jack's Picker, with the app's Screen Recording and Microphone access, through
// ELECTRON_RUN_AS_NODE, NODE_OPTIONS or --inspect. It runs before signing, so the release
// signature covers the change. Check a build with:
//   npx @electron/fuses read --app "dist/mac-arm64/Jack's Picker.app"
const path = require('path');
const { execFileSync } = require('child_process');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack({ electronPlatformName, appOutDir, packager }) {
  const mac = electronPlatformName === 'darwin' || electronPlatformName === 'mas';
  const name = packager.appInfo.productFilename;
  const app = mac ? path.join(appOutDir, `${name}.app`)
    : electronPlatformName === 'win32' ? path.join(appOutDir, `${name}.exe`)
    : path.join(appOutDir, packager.executableName);

  await flipFuses(app, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: false,   // done below, for just the binary that changed
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // electron-builder records app.asar's hash in Info.plist on macOS (not on Windows here).
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: mac,
    // GrantFileProtocolExtraPrivileges stays at Electron's default: the pages are file:// and
    // load captures from file:// URLs.
  });

  // Flipping edits Electron Framework, so it needs a fresh (ad hoc) signature or an unsigned
  // local build won't launch on Apple silicon. Only that binary is re-signed: a whole-bundle
  // `codesign --deep` fails inside iCloud Drive (~/Documents), which tags bundle folders with
  // Finder info. Release signing re-signs everything afterwards.
  if (mac) {
    const framework = path.join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Electron Framework');
    execFileSync('codesign', ['--sign', '-', '--force', '--preserve-metadata=entitlements,requirements,flags,runtime', framework]);
  }
};
