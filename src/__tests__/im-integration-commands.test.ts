import test from 'node:test';
import assert from 'node:assert/strict';

import {
  validateOptionalHttpUrlForIntegration,
  resolveBlog2mediaBaseUrl,
} from '../lib/bridge/im-integration-commands';

test('validateOptionalHttpUrlForIntegration accepts http(s) URLs', () => {
  assert.equal(
    validateOptionalHttpUrlForIntegration('  https://example.com/x?q=1  '),
    'https://example.com/x?q=1',
  );
  assert.equal(validateOptionalHttpUrlForIntegration('http://127.0.0.1:9300/api'), 'http://127.0.0.1:9300/api');
});

test('validateOptionalHttpUrlForIntegration rejects non-http schemes', () => {
  assert.equal(validateOptionalHttpUrlForIntegration('ftp://a'), null);
  assert.equal(validateOptionalHttpUrlForIntegration('not a url'), null);
});

test('resolveBlog2mediaBaseUrl strips trailing slash', () => {
  const prev = process.env.BLOG2MEDIA_BASE_URL;
  process.env.BLOG2MEDIA_BASE_URL = 'http://localhost:9999/';
  try {
    assert.equal(resolveBlog2mediaBaseUrl(), 'http://localhost:9999');
  } finally {
    if (prev === undefined) delete process.env.BLOG2MEDIA_BASE_URL;
    else process.env.BLOG2MEDIA_BASE_URL = prev;
  }
});
