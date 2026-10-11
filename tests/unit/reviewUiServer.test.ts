/**
 * Unit Tests for Review UI Static & Proxy HTTP Server (Build 9.2).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createReviewUiServer } from '../../src/reviewUi/staticServer.js';
import type { RunningReviewUiServer } from '../../src/reviewUi/types.js';

interface SimpleHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function makeRequest(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<SimpleHttpResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: data,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('Review UI: Static Server & HTTP Endpoints', () => {
  let uiServer: RunningReviewUiServer;

  beforeAll(async () => {
    // Listen on ephemeral port 0
    uiServer = await createReviewUiServer({
      host: '127.0.0.1',
      port: 0,
      apiUrl: 'http://127.0.0.1:3210',
    });
  });

  afterAll(async () => {
    if (uiServer) {
      await uiServer.stop();
    }
  });

  it('serves GET / with HTML shell and CSP headers', async () => {
    const res = await makeRequest(`${uiServer.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('<script type="module" src="/app.js"></script>');
  });

  it('serves GET /styles.css with CSS content type', async () => {
    const res = await makeRequest(`${uiServer.url}/styles.css`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.body).toContain('--bg-primary');
    expect(res.body).toContain('.ui-navbar');
  });

  it('serves GET /app.js with JS content type', async () => {
    const res = await makeRequest(`${uiServer.url}/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/javascript');
    expect(res.body).toContain('ReviewApiClient');
    expect(res.body).toContain('ReviewUiApp');
  });

  it('serves GET /health and HEAD /health', async () => {
    const getRes = await makeRequest(`${uiServer.url}/health`);
    expect(getRes.status).toBe(200);
    const parsed = JSON.parse(getRes.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.service).toBe('crashlab-review-ui');
    expect(parsed.readOnly).toBe(true);

    const headRes = await makeRequest(`${uiServer.url}/health`, { method: 'HEAD' });
    expect(headRes.status).toBe(200);
    expect(headRes.body).toBe('');
  });

  it('rejects mutation methods (POST, PUT, PATCH, DELETE) with 405 Method Not Allowed', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const res = await makeRequest(`${uiServer.url}/api/candidates`, { method });
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe('GET, HEAD');
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).toBe('method-not-allowed');
    }
  });

  it('rejects path traversal with 400 Bad Request', async () => {
    const res = await makeRequest(`${uiServer.url}/..%2f..%2fetc%2fpasswd`);
    expect(res.status).toBe(400);
    const parsed = JSON.parse(res.body);
    expect(parsed.error.code).toBe('invalid-path');
  });

  it('returns 502 when proxying to unreachable backing API', async () => {
    // Port 64999 is unlikely to be running an API server
    const serverWithBadApi = await createReviewUiServer({
      host: '127.0.0.1',
      port: 0,
      apiUrl: 'http://127.0.0.1:64999',
    });

    try {
      const res = await makeRequest(`${serverWithBadApi.url}/api/summary`);
      expect(res.status).toBe(502);
      const parsed = JSON.parse(res.body);
      expect(parsed.error.code).toBe('api-unavailable');
    } finally {
      await serverWithBadApi.stop();
    }
  });
});
