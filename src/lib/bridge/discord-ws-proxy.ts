import { HttpsProxyAgent } from 'https-proxy-agent';
import { ProxyAgent } from 'undici';
import type { Agent } from 'node:http';

declare global {
  /** Set by configureDiscordGatewayProxy; read by patched @discordjs/ws (Gateway WebSocket). */
  // eslint-disable-next-line no-var
  var __CTI_DISCORD_WS_PROXY_AGENT__: Agent | undefined;
}

export function configureDiscordGatewayProxy(proxyUrl: string | undefined): void {
  if (!proxyUrl?.trim()) {
    globalThis.__CTI_DISCORD_WS_PROXY_AGENT__ = undefined;
    return;
  }
  globalThis.__CTI_DISCORD_WS_PROXY_AGENT__ = new HttpsProxyAgent(proxyUrl.trim());
}

/** Discord REST uses Undici; pass as `client.rest` options `agent`. */
export function buildDiscordRestProxyAgent(proxyUrl: string | undefined): ProxyAgent | undefined {
  if (!proxyUrl?.trim()) return undefined;
  return new ProxyAgent(proxyUrl.trim());
}
