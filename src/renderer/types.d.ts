import type { RelayApi } from '../main/preload';

declare global {
  interface Window {
    relayApi: RelayApi;
  }
}

export {};
