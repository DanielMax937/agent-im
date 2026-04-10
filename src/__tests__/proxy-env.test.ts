import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyStandardProxyEnvFromCtiProxy,
  applySubprocessProxyPolicyForRuntime,
  getCursorAgentLaunchMode,
  unsetStandardProxyEnv,
} from '../lib/proxy-env';

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

test('applyStandardProxyEnvFromCtiProxy force overwrites HTTP_PROXY', () => {
  const env: Record<string, string | undefined> = {
    CTI_PROXY: 'http://127.0.0.1:1087',
    HTTP_PROXY: 'http://10.0.0.1:8888',
  };
  applyStandardProxyEnvFromCtiProxy(env, { force: true });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:1087');
});

test('unsetStandardProxyEnv removes proxy keys', () => {
  const env: Record<string, string | undefined> = {
    HTTP_PROXY: 'http://a:1',
    http_proxy: 'http://a:1',
    PATH: '/usr/bin',
  };
  unsetStandardProxyEnv(env);
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.PATH, '/usr/bin');
});

test('applySubprocessProxyPolicyForRuntime claude unsets inherited HTTP_PROXY', () => {
  const env: Record<string, string | undefined> = {
    CTI_PROXY: 'http://127.0.0.1:1087',
    HTTP_PROXY: 'http://shell:1',
  };
  applySubprocessProxyPolicyForRuntime(env, 'claude');
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.CTI_PROXY, 'http://127.0.0.1:1087');
});

test('applySubprocessProxyPolicyForRuntime copilot forces CTI_PROXY into HTTP_PROXY', () => {
  const env: Record<string, string | undefined> = {
    CTI_PROXY: 'http://127.0.0.1:1087',
    HTTP_PROXY: 'http://old:1',
  };
  applySubprocessProxyPolicyForRuntime(env, 'copilot');
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:1087');
});

test('getCursorAgentLaunchMode reads CTI_CURSOR_AGENT_LAUNCH', () => {
  const prev = process.env.CTI_CURSOR_AGENT_LAUNCH;
  try {
    delete process.env.CTI_CURSOR_AGENT_LAUNCH;
    assert.equal(getCursorAgentLaunchMode(), 'standard');
    process.env.CTI_CURSOR_AGENT_LAUNCH = 'proxychains';
    assert.equal(getCursorAgentLaunchMode(), 'proxychains');
  } finally {
    if (prev === undefined) delete process.env.CTI_CURSOR_AGENT_LAUNCH;
    else process.env.CTI_CURSOR_AGENT_LAUNCH = prev;
  }
});
