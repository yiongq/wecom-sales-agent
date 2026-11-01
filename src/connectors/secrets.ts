import { openJson, sealJson, type KeyRing, type Redacted } from '../channels/secrets.js';

export interface ConnectorSecrets {
  apiKey: string;
}

function connectorFields(value: unknown): ConnectorSecrets | null {
  if (value === null || typeof value !== 'object' || !('apiKey' in value) || typeof value.apiKey !== 'string' || !value.apiKey) return null;
  return { apiKey: value.apiKey };
}

export function sealConnectorSecrets(
  ring: KeyRing,
  aad: { tenantId: string; connectorId: string },
  secrets: ConnectorSecrets,
): { ct: Buffer; keyId: string } {
  return sealJson(ring, 'erp_connectors:v1', { tenantId: aad.tenantId, id: aad.connectorId }, { apiKey: secrets.apiKey });
}

export function openConnectorSecrets(
  ring: KeyRing,
  aad: { tenantId: string; connectorId: string },
  ct: Buffer,
  keyId: string,
): Redacted<ConnectorSecrets> {
  return openJson(ring, 'erp_connectors:v1', { tenantId: aad.tenantId, id: aad.connectorId }, ct, keyId, connectorFields);
}
