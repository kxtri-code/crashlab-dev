import { startFixtureServer, stopFixtureServer } from './tests/fixtures/server.js';
import { runScout } from './src/scout/scout.js';
import { classifyGoal } from './src/journey/classify.js';
import { matchRoles, rolesForJourney } from './src/journey/match.js';
import { extractElements } from './src/journey/scoutLoader.js';

const { server, origin } = await startFixtureServer();
try {
  const scout = await runScout({ url: `${origin}/contact`, headless: true, settleMs: 150, timeoutMs: 15000 });
  const c = classifyGoal('submit the form');
  console.log('journeyType:', c.journeyType);
  const elements = extractElements(scout);
  const matches = matchRoles(elements, rolesForJourney(c.journeyType), new Set());
  const sub = matches.get('submit_control');
  console.log('submit_control candidates:');
  for (const cand of sub?.candidates ?? []) {
    console.log(`  ${cand.elementId} score=${cand.score} text=${JSON.stringify(cand.element.text)} reasons=${cand.reasons.join(';')}`);
  }
  console.log('hidden:', sub?.hidden.map(c => c.elementId), 'disabled:', sub?.disabled.map(c => c.elementId));
} finally {
  await stopFixtureServer(server);
}
