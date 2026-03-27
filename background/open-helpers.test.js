const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeOpenTimestamp,
  getFallbackOpenFingerprint,
  getOpenIdentity,
  getLatestOpenTimestamp
} = require('./open-helpers.js');

test('normalizeOpenTimestamp parses seconds, milliseconds, ISO strings, and invalid values', () => {
  assert.equal(normalizeOpenTimestamp(1710000000), 1710000000);
  assert.equal(normalizeOpenTimestamp(1710000000123), 1710000000.123);
  assert.equal(normalizeOpenTimestamp('2024-03-10T12:34:56Z'), 1710074096);
  assert.equal(normalizeOpenTimestamp(''), null);
  assert.equal(normalizeOpenTimestamp('not-a-date'), null);
});

test('getFallbackOpenFingerprint is stable across object key order', () => {
  const first = getFallbackOpenFingerprint({
    recipient: 'alice@example.com',
    subject: 'Quarterly Update',
    city: 'New York',
    country: 'USA',
    opened_at: '2024-03-10T12:34:56Z'
  });
  const second = getFallbackOpenFingerprint({
    country: 'USA',
    subject: 'Quarterly Update',
    opened_at: '2024-03-10T12:34:56Z',
    city: 'New York',
    recipient: 'alice@example.com'
  });

  assert.equal(first, second);
});

test('getOpenIdentity prefers open_id and falls back to fingerprinted notification ids', () => {
  assert.deepEqual(
    getOpenIdentity({ open_id: 42 }),
    { dedupeKey: '42', notificationId: 'open-42' }
  );

  const fallbackIdentity = getOpenIdentity({
    recipient: 'alice@example.com',
    subject: 'Quarterly Update',
    opened_at: '2024-03-10T12:34:56Z'
  });

  assert.match(fallbackIdentity.dedupeKey, /^fingerprint:/);
  assert.match(fallbackIdentity.notificationId, /^open-fallback-/);
});

test('getLatestOpenTimestamp returns the newest parseable timestamp or preserves the watermark', () => {
  assert.equal(getLatestOpenTimestamp([
    { opened_at: '2024-03-10T12:34:50Z' },
    { timestamp: 1710074096 },
    { created_at: 'invalid-date' }
  ], 1710074000), 1710074096);

  assert.equal(getLatestOpenTimestamp([
    { created_at: 'invalid-date' }
  ], 1710074000), 1710074000);
});
