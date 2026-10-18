/**
 * Artifact Utility Functions — Build 12G.1.
 *
 * Provides safe, deterministic resolution of artifact download filenames and extensions:
 * - text/plain -> .txt or .log (based on artifact type)
 * - application/json -> .json
 * - safe fallback for unknown content types -> .bin
 */

/**
 * Resolves appropriate file extension for an artifact based on its type and contentType.
 */
export function resolveArtifactExtension(type: string, contentType?: string | null): string {
  const ct = (contentType || '').toLowerCase().trim();
  const t = (type || '').toLowerCase().trim();

  // 1. JSON payloads
  if (ct.includes('application/json') || ct.includes('json') || t === 'execution' || t === 'anomalies') {
    return 'json';
  }

  // 2. Plain text / logs
  if (ct.includes('text/plain') || t === 'log') {
    return t === 'log' ? 'log' : 'txt';
  }

  // 3. Common media / web formats
  if (ct.includes('text/html')) return 'html';
  if (ct.includes('text/csv')) return 'csv';
  if (ct.includes('image/png')) return 'png';
  if (ct.includes('image/jpeg') || ct.includes('image/jpg')) return 'jpg';
  if (ct.includes('image/webp')) return 'webp';
  if (ct.includes('application/pdf')) return 'pdf';

  // 4. Safe fallback for unknown content types
  return 'bin';
}

/**
 * Builds a sanitized, deterministic download filename for an artifact.
 */
export function resolveArtifactFilename(type: string, id: string, contentType?: string | null): string {
  const safeType = (type || 'artifact').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeId = (id || '').slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '_') || '00000000';
  const ext = resolveArtifactExtension(type, contentType);
  return `artifact-${safeType}-${safeId}.${ext}`;
}
