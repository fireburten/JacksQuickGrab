// What's still missing before an App Store build can be made and uploaded.
//   npm run check:release           everything the App Store upload needs
//   node scripts/check-release.cjs mas-dev   only what a local sandbox test build needs
// build:mas and build:mas-dev run this first and stop if something is missing.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const target = process.argv[2] === 'mas-dev' ? 'mas-dev' : 'mas';
const read = file => { try { return fs.readFileSync(path.join(ROOT, file), 'utf8'); } catch { return ''; } };
const exists = file => fs.existsSync(path.join(ROOT, file));
const succeeds = (cmd, args) => { try { execFileSync(cmd, args, { cwd: ROOT, stdio: 'ignore' }); return true; } catch { return false; } };

// iCloud Drive (Desktop & Documents) marks its root folder. App bundles built anywhere under it
// get tagged with Finder info, which codesign rejects ("…or similar detritus not allowed").
function insideICloudDrive(dir) {
  for (let d = dir; d !== path.dirname(d); d = path.dirname(d)) {
    if (succeeds('xattr', ['-p', 'com.apple.file-provider-domain-id', d])) return true;
  }
  return false;
}

const BUNDLE_ID = require(path.join(ROOT, 'package.json')).build.appId;
const checks = [
  {
    name: 'Project is outside iCloud Drive (signing fails inside it)',
    ok: process.platform !== 'darwin' || !insideICloudDrive(ROOT),
    fix: 'Move the repo out of ~/Documents and ~/Desktop (iCloud Drive), e.g. to ~/Developer/JacksQuickGrab. macOS tags app bundles there with Finder info, which codesign rejects.',
    for: ['mas', 'mas-dev'],
  },
  {
    name: 'Team ID in the app-group entitlement',
    ok: !read('build/entitlements.mas.plist').includes('TEAMID'),
    fix: 'In build/entitlements.mas.plist, replace TEAMID with your Team ID (developer.apple.com → Account → Membership).',
    for: ['mas', 'mas-dev'],
  },
  {
    name: 'Development provisioning profile',
    ok: exists('build/dev.provisionprofile'),
    fix: `Create a macOS App Development profile for ${BUNDLE_ID} that includes this Mac, and save it as build/dev.provisionprofile.`,
    for: ['mas-dev'],
  },
  {
    name: 'App Store provisioning profile',
    ok: exists('build/embedded.provisionprofile'),
    fix: `Create a Mac App Store distribution profile for ${BUNDLE_ID} and save it as build/embedded.provisionprofile.`,
    for: ['mas'],
  },
  {
    name: 'Privacy policy filled in',
    ok: !/\[(EFFECTIVE DATE|CONTACT EMAIL)\]/.test(read('store/privacy-policy.md')),
    fix: 'Fill in [EFFECTIVE DATE] and [CONTACT EMAIL] in store/privacy-policy.md, then run npm run build:privacy.',
    for: ['mas'],
  },
  {
    name: 'Published privacy page matches the policy',
    ok: succeeds(process.execPath, ['scripts/build-privacy-page.mjs', '--check']),
    fix: 'Run npm run build:privacy and commit docs/privacy.html (GitHub Pages serves it from docs/).',
    for: ['mas'],
  },
  {
    name: 'Contact email in the App Review notes',
    ok: !read('store/app-store-listing.md').includes('[CONTACT EMAIL]'),
    fix: 'Fill in [CONTACT EMAIL] in store/app-store-listing.md.',
    for: ['mas'],
  },
  {
    name: 'Security fuses tool installed',
    ok: exists('node_modules/@electron/fuses'),
    fix: 'Run npm install (scripts/after-pack.cjs needs @electron/fuses).',
    for: ['mas', 'mas-dev'],
  },
  {
    name: 'All changes committed (the build number is the commit count)',
    ok: succeeds('git', ['diff', '--quiet', 'HEAD']) && !execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: ROOT }).toString().trim(),
    fix: 'Commit your changes, so this upload gets a new, higher build number.',
    for: ['mas'],
  },
].filter(check => check.for.includes(target));

console.log(`Release check: ${target === 'mas' ? 'App Store upload' : 'local sandbox test build'}\n`);
for (const check of checks) {
  console.log(`  ${check.ok ? '✓' : '✗'} ${check.name}`);
  if (!check.ok) console.log(`      → ${check.fix}`);
}
const missing = checks.filter(check => !check.ok).length;
if (target === 'mas') {
  console.log('\n  Also in App Store Connect (not checked here): screenshots, the privacy policy URL');
  console.log('  (GitHub Pages → docs/privacy.html), a support URL, pricing, age rating and the App Privacy answers in store/app-privacy.md.');
}
console.log(missing ? `\n${missing} thing${missing === 1 ? '' : 's'} to do before this build.` : '\nReady to build.');
process.exit(missing ? 1 : 0);
