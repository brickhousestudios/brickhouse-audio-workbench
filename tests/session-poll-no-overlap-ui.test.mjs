import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../app/page.tsx', import.meta.url), 'utf8');

test('background shared-session polling never overlaps itself', () => {
  assert.match(source, /const sessionPollInFlight = useRef\(false\);/);
  assert.match(source, /const refresh = async \(\) => \{\s*if \(sessionPollInFlight\.current\) return;\s*sessionPollInFlight\.current = true;/);
  assert.match(source, /finally \{ sessionPollInFlight\.current = false; \}/);
  assert.match(source, /window\.setInterval\(refresh, 1500\)/);
});
