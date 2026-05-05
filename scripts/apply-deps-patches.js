#!/usr/bin/env node
/**
 * Postinstall script bundled with vocallabsai-sdk.
 *
 * Auto-applies the iOS hardware AEC (VPIO) patch to react-native-audio-api
 * in the host project's node_modules. Without this patch, callers using
 * vocallabsai-sdk on iOS hear echo when in speakerphone mode.
 *
 * The patch is idempotent — running it twice is safe — and version-pinned
 * to the exact react-native-audio-api version it targets.
 *
 * Failure is non-fatal: if the host has a different audio-api version, or
 * if the patch can't be applied for any reason, the SDK still installs
 * normally. Echo cancellation just won't be active until they patch
 * manually or upgrade audio-api to a version that bundles VPIO natively.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const TARGET_PACKAGE = 'react-native-audio-api';
const TARGET_VERSION = '0.11.7';
const PATCH_FILE = `react-native-audio-api+${TARGET_VERSION}.patch`;
const TARGET_FILE_REL = 'ios/audioapi/ios/system/AudioEngine.mm';
const PATCH_MARKER = 'setVoiceProcessingEnabled'; // already-patched marker

function findHostProjectRoot() {
  // We're in node_modules/vocallabsai-sdk/scripts/. Go up to host root.
  let dir = path.resolve(__dirname, '..', '..', '..');
  // If somehow nested deeper (workspaces, pnpm), walk up until we find one
  // that has its own node_modules and isn't itself inside node_modules.
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, 'package.json')) &&
      fs.existsSync(path.join(dir, 'node_modules')) &&
      !dir.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function main() {
  // Skip during dev installs of the SDK itself (no host node_modules above).
  if (process.env.VOCALLABS_SKIP_PATCHES === '1') {
    console.log('[vocallabsai-sdk] Skipping audio-api patch (env override).');
    return;
  }

  const root = findHostProjectRoot();
  if (!root) return; // SDK being developed/installed standalone — nothing to patch.

  const targetPkgPath = path.join(root, 'node_modules', TARGET_PACKAGE);
  if (!fs.existsSync(targetPkgPath)) return; // host doesn't use audio-api yet.

  // Version check — only apply if the patched file actually matches the version we know.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(targetPkgPath, 'package.json'), 'utf8'));
    if (pkg.version !== TARGET_VERSION) {
      console.warn(
        `[vocallabsai-sdk] react-native-audio-api version ${pkg.version} found ` +
        `(expected ${TARGET_VERSION}). Skipping AEC patch — speakerphone may echo.`
      );
      return;
    }
  } catch {
    return;
  }

  // Idempotency — already patched?
  const targetFile = path.join(targetPkgPath, TARGET_FILE_REL);
  try {
    const content = fs.readFileSync(targetFile, 'utf8');
    if (content.includes(PATCH_MARKER)) {
      console.log('[vocallabsai-sdk] AEC patch already applied — skipping.');
      return;
    }
  } catch {
    return;
  }

  // Apply.
  const patchPath = path.resolve(__dirname, '..', 'patches', PATCH_FILE);
  if (!fs.existsSync(patchPath)) {
    console.warn(`[vocallabsai-sdk] Patch file missing: ${patchPath}`);
    return;
  }

  try {
    execSync(`patch -p1 < "${patchPath}"`, { cwd: root, stdio: 'inherit' });
    console.log('[vocallabsai-sdk] ✅ Applied iOS AEC patch to react-native-audio-api');
  } catch (e) {
    console.warn(
      '[vocallabsai-sdk] ⚠️  Could not auto-apply AEC patch. ' +
      'Speakerphone mode may echo. Apply patches/' + PATCH_FILE + ' manually.'
    );
  }
}

main();
