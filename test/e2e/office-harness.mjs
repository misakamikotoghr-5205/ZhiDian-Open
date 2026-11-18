// Shared by the office end-to-end scripts: starts the real app (scripted brain, no model) and
// runs office actions in it through the same object the UI uses.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron: electron } = require('playwright');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * @returns {Promise<{
 *   work: string,                              an empty temporary folder for fixtures and results
 *   offers(input): Promise<string[]>,          ids of the actions offered for { files } or { text }
 *   run(id, input): Promise<{ offers: string[], result?: object, error?: string }>,
 *   ok(id, input): Promise<{ offers: string[], result: object }>,   like run, throws on error
 *   close(): Promise<void>
 * }>}
 */
export async function launchOffice() {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-office-')));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'zhidian-office-ud-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ seenIntro: true, mcp: { enabled: false }, actions: { ambient: false } }));
  const app = await electron.launch({
    executablePath: require('electron'), // in plain Node this is the path of the Electron binary
    args: ['--no-sandbox', repo, '--rehearse'],
    env: { ...process.env, NODE_OPTIONS: '', ZHIDIAN_TEST: '1', ZHIDIAN_USER_DATA: userData, ZHIDIAN_LOCAL_DIR: path.join(userData, 'local') },
  });
  await (await app.firstWindow()).waitForLoadState('domcontentloaded');
  // Converter integration can exercise both real policy tiers without loading multi-GB
  // inference weights. Hardware selection and default-tier enforcement have separate tests.
  const policyTier = process.env.ZHIDIAN_OFFICE_TEST_TIER;
  if (policyTier) {
    if (!['small', 'large'].includes(policyTier)) throw new Error('Invalid ZHIDIAN_OFFICE_TEST_TIER');
    await app.evaluate((_electron, tier) => { globalThis.__zhidian.office.getTier = () => tier; }, policyTier);
    console.log(`Office converter integration policy fixture: ${policyTier}`);
  }
  const run = (id, input, opts = {}) =>
    app.evaluate(async (_e, [actionId, given, options]) => {
      const office = globalThis.__zhidian.office;
      const context = office.context(given);
      if (!context) return { offers: [], error: 'nothing to act on in this selection' };
      const offers = office.offers(context).map((o) => o.id);
      if (!offers.includes(actionId)) return { offers, error: `"${actionId}" is not offered for this selection; offered: ${offers.join(', ')}` };
      try {
        return { offers, result: await office.run(actionId, context, options || {}) };
      } catch (err) {
        return { offers, error: String(err?.message ?? err) };
      }
    }, [id, input, opts]);
  return {
    work,
    run,
    offers: (input) => app.evaluate((_e, given) => {
      const office = globalThis.__zhidian.office;
      const context = office.context(given);
      return context ? office.offers(context).map((o) => o.id) : [];
    }, input),
    ok: async (id, input, opts) => {
      const r = await run(id, input, opts);
      if (r.error) throw new Error(`${id}: ${r.error}`);
      return r;
    },
    close: () => app.close().catch(() => {}),
  };
}

