#!/usr/bin/env node
/**
 * Packaged/display E2E probe for `browser_run` (2026-10-23).
 *
 * This probe needs BOTH a built desktop app and a display; the regular CI
 * environment has neither, so it REGISTERS ITS SKIP with a reason instead of
 * silently passing. Run it manually on a machine with Xvfb + a packaged build:
 *
 *   DISPLAY=:99 DSH_BROWSER_RUN_E2E=1 \
 *   DSH_BROWSER_RUN_APP=<path-to-packaged-binary> \
 *   node packages/host/browser/scripts/e2e-browser-run.mjs
 *
 * What it must prove when it can run:
 *  1. with `programEnabled:true`, `browser_run('return 1+1')` returns 2;
 *  2. `browser_run('while(true){}')` + abort stops within 1s and the NEXT
 *     browser tool responds in <1s (no lock left behind);
 *  3. the cancelled child has `exitCode !== null` (no zombie).
 */
const reason = !process.env.DISPLAY
  ? 'missing-display'
  : process.env.DSH_BROWSER_RUN_E2E !== '1'
    ? 'not-opted-in (set DSH_BROWSER_RUN_E2E=1)'
    : !process.env.DSH_BROWSER_RUN_APP
      ? 'missing-packaged-app (set DSH_BROWSER_RUN_APP)'
      : null

if (reason !== null) {
  console.log(`E2E-SKIP browser_run probe: ${reason}`)
  console.log('  (this is an ENVIRONMENT skip, not a feature skip: the Node-side probes')
  console.log('   cover the executor, the cancellation and the process exit)')
  process.exit(0)
}

console.error('e2e-browser-run: packaged probe is not wired to a build in this checkout')
console.error('use the desktop e2e harness (packages/host/desktop e2e:client) to attach over CDP')
process.exit(2)
