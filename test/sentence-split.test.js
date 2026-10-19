const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('public/text-segments.js', 'utf8'), sandbox);
const TS = sandbox.window.LcTextSegments;

test('a lowercase sentence after a period stays its own sentence', () => {
  const parts = TS.splitSegmentIntoSentences(
    'Neem contact op met de klantenservice. schakel het apparaat uit voordat u het reinigt.'
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'Neem contact op met de klantenservice.');
  assert.equal(parts[1], 'schakel het apparaat uit voordat u het reinigt.');
});

test('a model number with a period stays on the first sentence', () => {
  const parts = TS.splitSegmentIntoSentences(
    'Welkom bij de handleiding van de CaféPro 300. Lees deze handleiding zorgvuldig door voor gebruik.'
  );
  assert.equal(parts.length, 2);
  assert.equal(parts[0], 'Welkom bij de handleiding van de CaféPro 300.');
  assert.equal(parts[1], 'Lees deze handleiding zorgvuldig door voor gebruik.');
});

test('numbered steps still split before the number', () => {
  const parts = TS.splitSegmentIntoSentences('Do this first. 1. Turn the device on. 2. Fill the tank.');
  assert.equal(parts[0], 'Do this first.');
  assert.match(parts[1], /^1\./);
});
