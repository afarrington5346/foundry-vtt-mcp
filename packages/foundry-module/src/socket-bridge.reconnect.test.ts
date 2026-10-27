/**
 * The bridge must find its way back to the MCP server after the server restarts
 * (it does whenever Claude Desktop restarts). Before 0.8.6.5 a WebRTC bridge never
 * noticed the server had gone, and any bridge gave up after 5 attempts; both left
 * the GM reloading Foundry by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fakes: Array<{
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  lose: (reason: string) => void;
}> = [];
let serverUp = true;

vi.mock('./webrtc-connection.js', () => ({
  WebRTCConnection: class {
    private onDisconnect: ((reason: string) => void) | undefined;
    connect = vi.fn(async (_onMessage: unknown, onDisconnect?: (reason: string) => void) => {
      if (!serverUp) throw new Error('Failed to fetch');
      this.onDisconnect = onDisconnect;
    });
    disconnect = vi.fn();
    constructor() {
      fakes.push({
        connect: this.connect,
        disconnect: this.disconnect,
        lose: reason => this.onDisconnect?.(reason),
      });
    }
  },
}));

const { SocketBridge } = await import('./socket-bridge.js');

const config = {
  enabled: true,
  serverHost: 'localhost',
  serverPort: 31415,
  namespace: '/foundry-mcp',
  reconnectAttempts: 5,
  reconnectDelay: 1000,
  connectionTimeout: 10,
  debugLogging: false,
  connectionType: 'webrtc' as const,
};

describe('SocketBridge reconnection (WebRTC)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { location: { protocol: 'https:' } });
    fakes.length = 0;
    serverUp = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reconnects when an established connection is lost', async () => {
    const bridge = new SocketBridge(config);
    await bridge.connect();
    expect(bridge.isConnected()).toBe(true);

    fakes[0].lose('data channel closed');

    expect(bridge.isConnected()).toBe(false);
    expect(fakes[0].disconnect).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fakes).toHaveLength(2);
    expect(bridge.isConnected()).toBe(true);
  });

  it('keeps retrying past the attempt limit until the server is back', async () => {
    serverUp = false;
    const bridge = new SocketBridge(config);
    await expect(bridge.connect()).rejects.toThrow();

    // 1+2+4+8+16 s of fast attempts, then three more at the 30 s cap
    await vi.advanceTimersByTimeAsync(31_000 + 3 * 30_000);
    expect(fakes.length).toBeGreaterThan(config.reconnectAttempts + 1);
    expect(bridge.isConnected()).toBe(false);

    serverUp = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bridge.isConnected()).toBe(true);
  });

  it('stops retrying after disconnect()', async () => {
    serverUp = false;
    const bridge = new SocketBridge(config);
    await expect(bridge.connect()).rejects.toThrow();

    bridge.disconnect();
    const attempts = fakes.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fakes).toHaveLength(attempts);
  });

  it('ignores a loss reported by a connection it already replaced', async () => {
    const bridge = new SocketBridge(config);
    await bridge.connect();
    fakes[0].lose('ICE failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(bridge.isConnected()).toBe(true);

    fakes[0].lose('peer connection closed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fakes).toHaveLength(2);
    expect(bridge.isConnected()).toBe(true);
  });
});
