// Finding a browser to run the screen tests in.
//
// `npm run test:screens` is the only suite that needs one. It is a real
// renderer because the fault it exists to catch — a section throwing and
// taking the whole interface with it — is a rendering fault, and nothing
// short of a renderer can have it.
//
// A machine with no browser skips rather than fails, loudly, because a
// developer running the other thirteen suites on a laptop should not be
// stopped by a missing Chromium. Set SCREENS_REQUIRE_BROWSER=1 — which CI
// should — and a skip becomes a failure instead, so the guarantee cannot
// quietly stop being checked.

const fs = require('fs');
const path = require('path');

// Where Playwright's own download puts it, where this image puts it, and the
// usual system packages. First one that exists wins.
function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) {
    return process.env.CHROMIUM_PATH;
  }

  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers',
    path.join(process.env.HOME || '/root', '.cache/ms-playwright')].filter(Boolean);

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    let entries = [];
    try { entries = fs.readdirSync(root); } catch { continue; }
    // Newest build first, so a machine with several takes the current one.
    const builds = entries.filter((e) => /^chromium(_headless_shell)?(-|$)/.test(e)).sort().reverse();
    for (const build of builds) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell',
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const full = path.join(root, build, rel);
        if (fs.existsSync(full)) return full;
      }
    }
  }

  for (const system of ['/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']) {
    if (fs.existsSync(system)) return system;
  }
  return null;
}

function skip(why) {
  if (String(process.env.SCREENS_REQUIRE_BROWSER || '') === '1') {
    console.error('\nSCREENS_REQUIRE_BROWSER is set and ' + why);
    console.error('The screen tests are the only check that one broken section cannot take the');
    console.error('whole interface down. Refusing to pass without having run them.');
    process.exit(1);
  }
  console.log('\n  skipped — ' + why);
  console.log('  Install one with `npx playwright install chromium`, or point CHROMIUM_PATH at');
  console.log('  an existing Chrome. Set SCREENS_REQUIRE_BROWSER=1 to make this a failure.');
  console.log('\n0 passed, 0 failed (skipped)');
  process.exit(0);
}

let core = null;
try {
  core = require('playwright-core');
} catch {
  skip('playwright-core is not installed');
}

const executablePath = findChromium();
if (!executablePath) skip('no Chromium could be found on this machine');

// --no-sandbox because this runs as root in a container, which is the only
// place it ever runs unattended.
const chromium = {
  launch: (opts) => core.chromium.launch(Object.assign({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  }, opts || {}))
};

module.exports = { chromium, executablePath, findChromium };
