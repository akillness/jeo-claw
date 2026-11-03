import type { RESTOptions } from "@discordjs/rest";

/** Install only in the dedicated Discord process, before importing discord.js. */
export function installDiscordGatewayProxy(proxy: string): void {
  const NativeWebSocket = globalThis.WebSocket;
  class ProxyWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, { protocols, proxy });
    }
  }
  globalThis.WebSocket = ProxyWebSocket as typeof WebSocket;
}

export function discordProxyRequest(proxy: string): RESTOptions["makeRequest"] {
  return (url, init) => fetch(url, { ...init, proxy } as BunFetchRequestInit);
}
