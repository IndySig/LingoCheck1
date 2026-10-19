const test = require('node:test');
const assert = require('node:assert/strict');
const reset = require('../password-reset');

test('a reset token matches only the hash that was stored', function () {
  const issued = reset.createResetToken(1_000);
  const records = [{ id: 'r1', resetTokenHash: issued.hash, resetExpiresAt: issued.expiresAt }];
  assert.equal(reset.findResetRecord(records, issued.token, 1_000).id, 'r1');
  assert.equal(reset.findResetRecord(records, 'a'.repeat(64), 1_000), null);
});

test('an expired or replaced reset token cannot be used', function () {
  const first = reset.createResetToken(1_000);
  const second = reset.createResetToken(2_000);
  const records = [{ id: 'r1', resetTokenHash: second.hash, resetExpiresAt: second.expiresAt }];
  assert.equal(reset.findResetRecord(records, first.token, 2_000), null);
  assert.equal(reset.findResetRecord(records, second.token, second.expiresAt), null);
  assert.equal(reset.findResetRecord(records, second.token, second.expiresAt - 1).id, 'r1');
});

test('a malformed reset token is ignored', function () {
  const issued = reset.createResetToken();
  const records = [{ id: 'r1', resetTokenHash: issued.hash, resetExpiresAt: issued.expiresAt }];
  assert.equal(reset.findResetRecord(records, issued.token.slice(0, 32)), null);
  assert.equal(reset.findResetRecord(records, ''), null);
});
