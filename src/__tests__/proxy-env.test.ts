import assert from 'node:assert/strict';
import test from 'node:test';

import { applyStandardProxyEnvFromCtiProxy } from '../lib/proxy-env';

test('applyStandardProxyEnvFromCtiProxy fills unset standard proxy keys from CTI_PROXY', () => {
  const env: Record<string, string | undefined> = {
    CTI_PROXY: 'http://127.0.0.1:1087',
  };
  applyStandardProxyEnvFromCtiProxy(env);
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:1087');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1087');
  assert.equal(env.ALL_PROXY, 'http://127.0.0.1:1087');
  assert.equal(env.http_proxy, 'http://127.0.0.1:1087');
});

test('applyStandardProxyEnvFromCtiProxy does not override explicit HTTP_PROXY', () => {
  const env: Record<string, string | undefined> = {
    CTI_PROXY: 'http://127.0.0.1:1087',
    HTTP_PROXY: 'http://10.0.0.1:8888',
  };
  applyStandardProxyEnvFromCtiProxy(env);
  assert.equal(env.HTTP_PROXY, 'http://10.0.0.1:8888');
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1087');
});

test('applyStandardProxyEnvFromCtiProxy no-op when CTI_PROXY unset', () => {
  const env: Record<string, string | undefined> = { HTTP_PROXY: 'http://x:1' };
  applyStandardProxyEnvFromCtiProxy(env);
  assert.equal(env.HTTP_PROXY, 'http://x:1');
});
