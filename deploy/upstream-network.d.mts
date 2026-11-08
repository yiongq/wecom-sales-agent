export interface UpstreamNetwork {
  subnet: string;
  appIP: string;
  standbyIP: string;
}
export const DEFAULT_UPSTREAM: UpstreamNetwork;
export function validateUpstream(subnet: string, appIP: string, standbyIP: string, side?: boolean): UpstreamNetwork;
export function selectDrillUpstream(networks: unknown): UpstreamNetwork;
