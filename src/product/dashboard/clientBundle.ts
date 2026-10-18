/**
 * Client JavaScript Application Bundle — Build 12C.1.
 *
 * Implements the browser single-page dashboard application:
 * - In-memory bearer token management
 * - Authenticated API client (zero secret leaks, request ID propagation)
 * - Navigation routing and reactive rendering
 * - Run lifecycle and queue status monitor
 * - Safe polling engine (stops on terminal states, visibility-aware, timer cleanup)
 * - Candidate triage viewer with strict trust invariants (confirmedBug: false)
 * - Safe artifact viewer (previews JSON/text/images, zero server paths leaked)
 * - Bounded run cancellation with confirmation modal
 */

export const CLIENT_JS_BUNDLE: string = `
(function() {
  'use strict';

  // --- HTML Escaping Utilities ---
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- State Container ---
  const state = {
    token: null,
    apiUrl: '',
    authMode: 'development',
    supabaseUrl: '',
    supabaseAnonKey: '',
    authSubmitting: false,
    currentUser: null,
    workspaces: [],
    currentWorkspace: null,
    projects: [],
    selectedProject: null,
    targets: [],
    journeys: [],
    runs: [],
    selectedRun: null,
    selectedQueueItem: null,
    candidates: [],
    artifacts: [],
    selectedArtifact: null,
    selectedArtifactContent: null,
    selectedArtifactLoading: false,
    cancelModalOpen: false,
    cancelSubmitting: false,
    executionModalOpen: false,
    executionModalJourney: null,
    executionModalTarget: null,
    executionModalAgreed: false,
    executionSubmitting: false,
    executionError: null,
    executionFailureReasons: [],
    targetModalOpen: false,
    targetSubmitting: false,
    targetError: null,
    journeyModalOpen: false,
    journeySubmitting: false,
    journeyError: null,
    loading: false,
    error: null,
    lastRequestId: null,
    route: 'overview', // 'auth' | 'overview' | 'projects' | 'runs' | 'run-detail' | 'security'
  };

  // --- API Client ---
  class ApiClient {
    constructor(getApiUrl, getToken) {
      this.getApiUrl = getApiUrl;
      this.getToken = getToken;
    }

    async request(path, options = {}) {
      const base = this.getApiUrl();
      const url = \`\${base}\${path}\`;
      const token = this.getToken();

      const headers = {
        'Accept': 'application/json',
        ...(options.headers || {}),
      };

      if (token) {
        headers['Authorization'] = \`Bearer \${token}\`;
      }

      if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
      }

      const res = await fetch(url, {
        ...options,
        headers,
      });

      const reqId = res.headers.get('x-request-id');
      if (reqId) {
        state.lastRequestId = reqId;
      }

      if (res.status === 401) {
        state.token = null;
        state.currentUser = null;
        state.route = 'auth';
        state.error = 'Authentication expired or invalid token. Please sign in again.';
        navigate('auth');
        renderApp();
        throw new Error(state.error);
      }

      if (!res.ok) {
        let errMessage = \`HTTP \${res.status} \${res.statusText}\`;
        let code = 'ERROR';
        let details = null;
        try {
          const errData = await res.json();
          if (errData && errData.error) {
            if (errData.error.message) errMessage = errData.error.message;
            if (errData.error.code) code = errData.error.code;
            if (errData.error.details) details = errData.error.details;
          }
        } catch (_) {}
        const err = new Error(errMessage);
        err.status = res.status;
        err.code = code;
        err.details = details;
        err.failureReasons = details && Array.isArray(details.failureReasons) ? details.failureReasons : [];
        throw err;
      }

      return res;
    }

    async getJson(path) {
      const res = await this.request(path, { method: 'GET' });
      const data = await res.json();
      if (data && data.requestId) {
        state.lastRequestId = data.requestId;
      }
      return data;
    }

    async postJson(path, body) {
      const res = await this.request(path, { method: 'POST', body });
      const data = await res.json();
      if (data && data.requestId) {
        state.lastRequestId = data.requestId;
      }
      return data;
    }

    async getBlob(path) {
      const res = await this.request(path, { method: 'GET' });
      const blob = await res.blob();
      return {
        blob,
        contentType: res.headers.get('content-type') || 'application/octet-stream',
        sha256: res.headers.get('x-artifact-sha256') || '',
      };
    }
  }

  const api = new ApiClient(
    () => state.apiUrl || window.location.origin,
    () => state.token
  );

  // --- Polling Manager ---
  class PollingManager {
    constructor() {
      this.timerId = null;
      this.isPolling = false;
      this.consecutiveFailures = 0;
      this.currentRunId = null;
    }

    start(runId) {
      this.stop();
      this.currentRunId = runId;
      this.consecutiveFailures = 0;
      this.scheduleNext(2500);
    }

    stop() {
      if (this.timerId) {
        clearTimeout(this.timerId);
        this.timerId = null;
      }
      this.isPolling = false;
      this.currentRunId = null;
    }

    scheduleNext(ms) {
      if (!this.currentRunId) return;
      this.timerId = setTimeout(() => this.poll(), ms);
    }

    async poll() {
      if (!this.currentRunId || !state.currentWorkspace || this.isPolling) {
        return;
      }

      // Pause polling if document tab is hidden
      if (document.visibilityState === 'hidden') {
        this.scheduleNext(3000);
        return;
      }

      this.isPolling = true;
      const runId = this.currentRunId;
      const wsId = state.currentWorkspace.id;

      try {
        const [runRes, queueRes] = await Promise.allSettled([
          api.getJson(\`/api/v1/runs/\${runId}?workspaceId=\${wsId}\`),
          api.getJson(\`/api/v1/runs/\${runId}/queue?workspaceId=\${wsId}\`),
        ]);

        if (runRes.status === 'fulfilled' && runRes.value.success) {
          state.selectedRun = runRes.value.data;
          this.consecutiveFailures = 0;

          // Check terminal state
          const terminalStatuses = ['completed', 'partial', 'failed', 'blocked', 'cancelled'];
          if (terminalStatuses.includes(state.selectedRun.status)) {
            this.stop();
            // Build 12G.1: Auto-fetch artifacts on terminal completion without requiring manual refresh
            try {
              const [artRes, candRes] = await Promise.allSettled([
                api.getJson('/api/v1/runs/' + runId + '/artifacts?workspaceId=' + wsId),
                api.getJson('/api/v1/runs/' + runId + '/candidates?workspaceId=' + wsId),
              ]);
              if (artRes.status === 'fulfilled' && artRes.value.success) {
                state.artifacts = artRes.value.data.artifacts || [];
              }
              if (candRes.status === 'fulfilled' && candRes.value.success) {
                state.candidates = candRes.value.data.candidates || [];
              }
            } catch {
              // Non-blocking fetch on terminal transition
            }
            renderApp();
            return;
          }
        } else {
          this.consecutiveFailures++;
        }

        if (queueRes.status === 'fulfilled' && queueRes.value.success) {
          state.selectedQueueItem = queueRes.value.data;
        }

        renderApp();
      } catch (err) {
        this.consecutiveFailures++;
      } finally {
        this.isPolling = false;
        if (this.currentRunId) {
          const backoff = Math.min(2500 * Math.pow(1.5, Math.min(this.consecutiveFailures, 4)), 10000);
          this.scheduleNext(backoff);
        }
      }
    }
  }

  const poller = new PollingManager();

  // --- Navigation & Routing ---
  function parseHash() {
    const raw = window.location.hash || '';
    let h = raw.startsWith('#') ? raw.slice(1) : raw;
    if (h.startsWith('/')) h = h.slice(1);
    const hash = h || 'overview';
    const parts = hash.split('/');
    return {
      path: parts[0] || 'overview',
      id: parts[1] || null,
      sub: parts[2] || null,
    };
  }

  function navigate(path) {
    if (window.location.hash === '#' + path) {
      handleRouteChange();
    } else {
      window.location.hash = '#' + path;
    }
  }

  window.addEventListener('hashchange', () => {
    poller.stop();
    handleRouteChange();
  });

  async function handleRouteChange() {
    const { path, id, sub } = parseHash();

    if (!state.token && path !== 'auth') {
      navigate('auth');
      return;
    }

    if (path !== 'auth') {
      state.error = null;
    }
    state.route = path;

    if (path === 'auth') {
      renderApp();
      return;
    }

    state.loading = true;
    renderApp();

    try {
      if (!state.currentUser) {
        const meRes = await api.getJson('/api/v1/me');
        if (meRes.success) {
          state.currentUser = meRes.data.user;
        }
      }

      if (state.workspaces.length === 0) {
        const wsRes = await api.getJson('/api/v1/workspaces');
        if (wsRes.success) {
          state.workspaces = wsRes.data.workspaces || [];
          if (!state.currentWorkspace && state.workspaces.length > 0) {
            state.currentWorkspace = state.workspaces[0];
          }
        }
      }

      const wsId = state.currentWorkspace?.id;

      if (wsId) {
        if (path === 'overview' || path === 'projects') {
          const prjRes = await api.getJson(\`/api/v1/projects?workspaceId=\${wsId}\`);
          if (prjRes.success) {
            state.projects = prjRes.data.projects || [];
          }
        }

        if (path === 'projects' && id) {
          const [pRes, tRes, jRes, rRes] = await Promise.all([
            api.getJson(\`/api/v1/projects/\${id}?workspaceId=\${wsId}\`),
            api.getJson(\`/api/v1/projects/\${id}/targets?workspaceId=\${wsId}\`),
            api.getJson(\`/api/v1/projects/\${id}/journeys?workspaceId=\${wsId}\`).catch(() => ({ success: true, data: { journeys: [] } })),
            api.getJson(\`/api/v1/projects/\${id}/runs?workspaceId=\${wsId}\`),
          ]);
          if (pRes.success) state.selectedProject = pRes.data;
          if (tRes.success) state.targets = tRes.data.targets || [];
          if (jRes.success) state.journeys = jRes.data.journeys || [];
          if (rRes.success) state.runs = rRes.data.runs || [];
        }

        if (path === 'run-detail' && id) {
          const [rRes, qRes, cRes, aRes] = await Promise.all([
            api.getJson(\`/api/v1/runs/\${id}?workspaceId=\${wsId}\`),
            api.getJson(\`/api/v1/runs/\${id}/queue?workspaceId=\${wsId}\`).catch(() => ({ success: false })),
            api.getJson(\`/api/v1/runs/\${id}/candidates?workspaceId=\${wsId}\`).catch(() => ({ success: true, data: { candidates: [] } })),
            api.getJson(\`/api/v1/runs/\${id}/artifacts?workspaceId=\${wsId}\`).catch(() => ({ success: true, data: { artifacts: [] } })),
          ]);

          if (rRes.success) {
            state.selectedRun = rRes.data;
            if (['queued', 'preflight', 'running', 'cancelling'].includes(state.selectedRun.status)) {
              poller.start(id);
            }
          }
          if (qRes.success) state.selectedQueueItem = qRes.data;
          if (cRes.success) state.candidates = cRes.data.candidates || [];
          if (aRes.success) state.artifacts = aRes.data.artifacts || [];
        }
      }
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      renderApp();
    }
  }

  // --- Safe Run Actions ---
  async function triggerCancelRun(runId) {
    if (!state.currentWorkspace) return;
    state.cancelSubmitting = true;
    renderApp();

    try {
      const res = await api.postJson(\`/api/v1/runs/\${runId}/cancel\`, {
        workspaceId: state.currentWorkspace.id,
        reason: 'Operator cancelled via product dashboard',
      });
      if (res.success) {
        state.selectedRun = res.data;
      }
      state.cancelModalOpen = false;
      poller.start(runId);
    } catch (err) {
      alert(\`Cancellation failed: \${err.message}\`);
    } finally {
      state.cancelSubmitting = false;
      renderApp();
    }
  }

  // --- Artifact Inspection & Download ---
  async function inspectArtifact(artifactId) {
    if (!state.currentWorkspace) return;
    const art = state.artifacts.find(a => a.id === artifactId);
    if (!art) return;

    state.selectedArtifact = art;
    state.selectedArtifactLoading = true;
    state.selectedArtifactContent = null;
    renderApp();

    try {
      const { blob, contentType } = await api.getBlob(\`/api/v1/artifacts/\${artifactId}/content?workspaceId=\${state.currentWorkspace.id}\`);
      if (contentType.includes('application/json') || contentType.includes('text/')) {
        const text = await blob.text();
        state.selectedArtifactContent = { type: 'text', content: text };
      } else if (contentType.startsWith('image/')) {
        const url = URL.createObjectURL(blob);
        state.selectedArtifactContent = { type: 'image', url };
      } else {
        state.selectedArtifactContent = { type: 'binary', size: blob.size };
      }
    } catch (err) {
      state.selectedArtifactContent = { type: 'error', error: err.message };
    } finally {
      state.selectedArtifactLoading = false;
      renderApp();
    }
  }

  // --- Artifact Filename Helper ---
  function resolveArtifactFilename(type, id, contentType) {
    const ct = (contentType || '').toLowerCase().trim();
    const t = (type || '').toLowerCase().trim();
    let ext = 'bin';
    if (ct.includes('application/json') || ct.includes('json') || t === 'execution' || t === 'anomalies') {
      ext = 'json';
    } else if (ct.includes('text/plain') || t === 'log') {
      ext = t === 'log' ? 'log' : 'txt';
    } else if (ct.includes('text/html')) {
      ext = 'html';
    } else if (ct.includes('text/csv')) {
      ext = 'csv';
    } else if (ct.includes('image/png')) {
      ext = 'png';
    } else if (ct.includes('image/jpeg') || ct.includes('image/jpg')) {
      ext = 'jpg';
    }
    const safeType = (type || 'artifact').replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeId = (id || '').slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '_') || '00000000';
    return 'artifact-' + safeType + '-' + safeId + '.' + ext;
  }

  async function downloadArtifact(artifactId) {
    if (!state.currentWorkspace) return;
    const art = state.artifacts.find(a => a.id === artifactId);
    if (!art) return;

    try {
      const { blob } = await api.getBlob(\`/api/v1/artifacts/\${artifactId}/content?workspaceId=\${state.currentWorkspace.id}\`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = resolveArtifactFilename(art.type, art.id, art.contentType);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (err) {
      alert(\`Download failed: \${err.message}\`);
    }
  }

  // --- Rendering Functions ---

  function renderNavbar() {
    const wsOptions = state.workspaces.map(w =>
      \`<option value="\${escapeHtml(w.id)}" \${state.currentWorkspace && state.currentWorkspace.id === w.id ? 'selected' : ''}>\${escapeHtml(w.name)}</option>\`
    ).join('');

    const userName = state.currentUser ? state.currentUser.name || state.currentUser.id : 'User';
    const reqBadge = state.lastRequestId ? \`<span class="request-id-badge" title="Correlation Request ID">\${escapeHtml(state.lastRequestId)}</span>\` : '';

    return \`
      <header class="dash-navbar">
        <a href="#/overview" class="dash-brand">
          CrashLab <span class="badge">Hosted MVP</span>
        </a>
        <div class="dash-header-controls">
          \${reqBadge}
          <div class="workspace-selector-group">
            <label for="ws-select" style="font-size:0.8rem;color:var(--text-dim);">Workspace:</label>
            <select id="ws-select" class="workspace-select">
              \${wsOptions || '<option disabled selected>No Workspaces</option>'}
            </select>
          </div>
          <div class="user-badge">
            <span style="font-weight:600;">\${escapeHtml(userName)}</span>
            <button id="btn-logout" class="btn btn-secondary btn-sm" title="Clear token and logout">Logout</button>
          </div>
        </div>
      </header>
    \`;
  }

  function renderSidebar() {
    const r = state.route;
    return \`
      <aside class="dash-sidebar">
        <div class="nav-section-title">Navigation</div>
        <a href="#/overview" class="nav-item \${r === 'overview' ? 'active' : ''}">📊 Overview</a>
        <a href="#/projects" class="nav-item \${r === 'projects' || r === 'project-detail' ? 'active' : ''}">📁 Projects</a>
        <a href="#/security" class="nav-item \${r === 'security' ? 'active' : ''}">🛡️ Security & Trust</a>
      </aside>
    \`;
  }

  function renderTrustBanner() {
    return \`
      <div class="trust-banner">
        <div class="trust-banner-text">
          <span class="trust-banner-badge">TRUST INVARIANT</span>
          <span><strong>Safe-Test Mode Active</strong> &bull; Candidate finding — not a confirmed defect &bull; Financial &amp; destructive actions permanently blocked.</span>
        </div>
        <div style="font-size:0.75rem;color:var(--text-dim);display:flex;gap:0.75rem;">
          <code>confirmedBug: false</code>
          <code>confirmed: false</code>
        </div>
      </div>
    \`;
  }

  function renderAuthView() {
    if (state.authMode === 'production') {
      return renderProductionAuthView();
    }
    return renderDevelopmentAuthView();
  }

  function renderProductionAuthView() {
    const errorHtml = state.error
      ? \`<div id="auth-error-banner" style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.error)}</div>\`
      : '';

    const needsAnonKey = !state.supabaseAnonKey;
    const needsUrl = !state.supabaseUrl;

    return \`
      <div class="auth-wrapper">
        <div class="auth-card">
          <div class="auth-header">
            <h2 style="font-size:1.5rem;font-weight:700;margin-bottom:0.5rem;">CrashLab Sign In</h2>
            <p style="color:var(--text-muted);font-size:0.875rem;">Private Beta &bull; Production Authentication</p>
          </div>
          <div class="auth-notice-box" style="border-left-color:var(--accent-primary, #38bdf8);">
            <strong>Supabase Authentication</strong><br>
            Sign in with your authorized test user or operator account to access your workspace.
          </div>
          \${errorHtml}
          <form id="auth-form" autocomplete="on" novalidate>
            <div class="form-group">
              <label class="form-label" for="input-email">Email Address</label>
              <input id="input-email" class="form-input" type="email" placeholder="operator@company.com" autocomplete="email">
            </div>
            <div class="form-group">
              <label class="form-label" for="input-password">Password</label>
              <input id="input-password" class="form-input" type="password" placeholder="••••••••••••" autocomplete="current-password">
            </div>
            \${needsUrl ? \`
            <div class="form-group">
              <label class="form-label" for="input-supabase-url">Supabase URL</label>
              <input id="input-supabase-url" class="form-input" type="url" placeholder="https://xyz.supabase.co">
            </div>
            \` : ''}
            \${needsAnonKey ? \`
            <div class="form-group">
              <label class="form-label" for="input-anon-key">Supabase Public Anon Key</label>
              <input id="input-anon-key" class="form-input" type="password" placeholder="eyJhbGci...">
              <div class="form-help">Enter the public anon key (never enter the service-role key).</div>
            </div>
            \` : ''}
            <button id="btn-submit-auth" type="submit" class="btn btn-primary" style="width:100%;padding:0.7rem;font-size:0.95rem;" \${state.authSubmitting ? 'disabled' : ''}>
              \${state.authSubmitting ? 'Signing in...' : 'Sign In'}
            </button>
            <div style="margin:1.25rem 0 1rem 0;text-align:center;position:relative;">
              <hr style="border:0;border-top:1px solid #334155;margin:0 0 -0.55rem 0;">
              <span style="background:#1e293b;padding:0 0.5rem;color:#64748b;font-size:0.75rem;text-transform:uppercase;letter-spacing:0.05em;">or sign in with user jwt</span>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-token">Supabase Authenticated User JWT</label>
              <input id="input-token" class="form-input" type="password" placeholder="eyJhbGci..." autocomplete="off">
              <div class="form-help">Enter a normal Supabase authenticated user JWT to access your workspace.</div>
            </div>
          </form>
        </div>
      </div>
    \`;
  }

  function renderDevelopmentAuthView() {
    return \`
      <div class="auth-wrapper">
        <div class="auth-card">
          <div class="auth-header">
            <h2 style="font-size:1.5rem;font-weight:700;margin-bottom:0.5rem;">CrashLab Sign In</h2>
            <p style="color:var(--text-muted);font-size:0.875rem;">Authenticated Product Dashboard</p>
          </div>
          <div class="auth-notice-box">
            <strong>Local development authentication — not production login.</strong><br>
            Generate a local development bearer token in your shell using:<br>
            <code style="display:inline-block;margin-top:0.35rem;padding:0.2rem 0.4rem;background:rgba(0,0,0,0.3);border-radius:4px;">npm run auth:token -- --user usr_test_owner</code>
          </div>
          \${state.error ? \`<div style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.error)}</div>\` : ''}
          <form id="auth-form">
            <div class="form-group">
              <label class="form-label" for="input-api-url">API Server URL</label>
              <input id="input-api-url" class="form-input" type="text" value="\${escapeHtml(state.apiUrl || window.location.origin)}" placeholder="http://127.0.0.1:3220">
              <div class="form-help">Address of the Product API server.</div>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-token">Development Bearer Token</label>
              <input id="input-token" class="form-input" type="password" placeholder="eyJhbGciOi..." autocomplete="off" required>
              <div class="form-help">Token will be kept in-memory only and cleared on logout.</div>
            </div>
            <button id="btn-submit-auth" type="submit" class="btn btn-primary" style="width:100%;padding:0.7rem;font-size:0.95rem;">
              Connect &amp; Authenticate
            </button>
          </form>
        </div>
      </div>
    \`;
  }

  function renderStatusPill(status) {
    const s = String(status || 'created').toLowerCase();
    const isPulsing = s === 'running' || s === 'preflight';
    const pulseHtml = isPulsing ? '<span class="pulse-dot"></span>' : '';
    return \`<span class="status-pill \${escapeHtml(s)}">\${pulseHtml}\${escapeHtml(s)}</span>\`;
  }

  function renderReviewStatusPill(status) {
    let s = String(status || 'unreviewed').toLowerCase().trim();
    if (s === 'confirmed' || s === 'confirmed_bug') {
      s = 'accepted';
    }
    const valid = ['open', 'investigating', 'accepted', 'dismissed', 'duplicate', 'resolved', 'unreviewed'];
    if (!valid.includes(s)) {
      s = 'unreviewed';
    }
    return \`<span class="review-status-pill \${escapeHtml(s)}">\${escapeHtml(s)}</span>\`;
  }

  function renderOverviewView() {
    const projectRows = state.projects.map(p => \`
      <tr>
        <td><strong><a href="#/projects/\${escapeHtml(p.id)}" style="color:var(--text-main);text-decoration:none;">\${escapeHtml(p.name)}</a></strong></td>
        <td>\${escapeHtml(p.description || 'No description')}</td>
        <td><code style="font-size:0.75rem;">\${escapeHtml(p.id)}</code></td>
        <td><a href="#/projects/\${escapeHtml(p.id)}" class="btn btn-secondary btn-sm">Inspect &rarr;</a></td>
      </tr>
    \`).join('');

    return \`
      <div class="panel-header">
        <h1 class="panel-title" style="font-size:1.35rem;">Workspace Overview</h1>
      </div>
      \${renderTrustBanner()}
      <div class="grid-cards">
        <div class="stat-card">
          <div class="title">Active Projects</div>
          <div class="value">\${state.projects.length}</div>
        </div>
        <div class="stat-card">
          <div class="title">Workspace Role</div>
          <div class="value" style="font-size:1.25rem;color:var(--status-completed);">Owner / Member</div>
        </div>
        <div class="stat-card">
          <div class="title">Target Environments</div>
          <div class="value" style="font-size:1.25rem;color:#38bdf8;">Isolated Staging / Local</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title">Projects</h2>
        </div>
        <div class="table-responsive">
          <table class="dash-table">
            <thead>
              <tr>
                <th>Project Name</th>
                <th>Description</th>
                <th>Project ID</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              \${projectRows || '<tr><td colspan="4" style="text-align:center;color:var(--text-dim);padding:2rem;">No projects found in this workspace.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    \`;
  }

  function renderProjectDetailView() {
    const p = state.selectedProject;
    if (!p) {
      return '<div class="state-box"><h3>Project not found.</h3></div>';
    }

    const targetList = state.targets.map(t => \`
      <div style="background:var(--bg-surface-elevated);padding:0.75rem;border-radius:6px;border:1px solid var(--border-subtle);margin-bottom:0.5rem;">
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>\${escapeHtml(t.name)}</strong>
          <span class="status-pill \${t.environment === 'staging' ? 'preflight' : 'created'}">\${escapeHtml(t.environment)}</span>
        </div>
        <div style="font-size:0.75rem;color:var(--text-dim);margin-top:0.25rem;">
          Origin: <code>\${escapeHtml(t.targetOrigin)}</code> &bull; Safe-Test: ACTIVE
        </div>
      </div>
    \`).join('');

    const journeyCards = state.journeys.map(j => {
      const tgt = state.targets.find(t => t.id === j.targetEnvironmentId) || state.targets[0];
      const hasTestData = Boolean(tgt && tgt.testDataReference);
      const testDataLabel = (j.requiresTestData || j.requiresCredentials)
        ? (hasTestData ? '<span style="color:#38bdf8;">&bull; Protected test data configured</span>' : '<span style="color:#f59e0b;">&bull; Protected test data missing</span>')
        : '<span style="color:var(--text-dim);">&bull; No credentials required</span>';

      return \`
        <div class="journey-card" style="background:var(--bg-surface-elevated);border:1px solid var(--border-subtle);border-radius:8px;padding:1rem;margin-bottom:0.75rem;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.4rem;">
            <div>
              <span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid #10b981;font-size:0.7rem;margin-right:0.5rem;">Approved journey</span>
              <span style="font-size:0.75rem;color:var(--text-dim);font-family:var(--font-mono);">ID: \${escapeHtml(j.id)}</span>
            </div>
            <span class="status-pill \${tgt && tgt.environment === 'staging' ? 'preflight' : 'created'}">\${escapeHtml(tgt ? tgt.environment : 'isolated')}</span>
          </div>
          <div style="font-weight:600;font-size:0.95rem;margin-bottom:0.35rem;color:var(--text-main);">
            \${escapeHtml(j.goal)}
          </div>
          <div style="font-size:0.8rem;color:var(--text-muted);margin-bottom:0.5rem;">
            Target Origin: <code style="color:#38bdf8;">\${escapeHtml(j.origin)}</code>
          </div>
          <div style="font-size:0.75rem;color:var(--text-dim);margin-bottom:0.75rem;line-height:1.4;">
            <strong>Allowed Actions:</strong> \${escapeHtml(j.allowedActions.join(', '))}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.5rem;">
            <div style="font-size:0.75rem;">
              <span style="color:#10b981;margin-right:0.75rem;">&bull; Safe-Test Mode: Enabled</span>
              \${testDataLabel}
            </div>
            <button class="btn btn-primary btn-sm btn-open-run-modal" data-journey-id="\${escapeHtml(j.id)}" id="btn-run-journey-\${escapeHtml(j.id)}">
              Run journey &rarr;
            </button>
          </div>
        </div>
      \`;
    }).join('');

    const runRows = state.runs.map(r => \`
      <tr>
        <td><a href="#/run-detail/\${escapeHtml(r.id)}" style="color:var(--text-main);font-family:var(--font-mono);font-size:0.8rem;">\${escapeHtml(r.id.slice(0, 14))}...</a></td>
        <td>\${renderStatusPill(r.status)}</td>
        <td>\${r.attemptCount || 1} / \${r.maxAttempts || 1}</td>
        <td style="font-size:0.75rem;color:var(--text-muted);">\${new Date(r.createdAt).toLocaleString()}</td>
        <td><a href="#/run-detail/\${escapeHtml(r.id)}" class="btn btn-secondary btn-sm">Details &rarr;</a></td>
      </tr>
    \`).join('');

    // Execution modal renderer
    const executionModal = state.executionModalOpen && state.executionModalJourney && state.executionModalTarget ? \`
      <div class="modal-overlay" id="modal-run-execution">
        <div class="modal-card modal-card-lg">
          <div class="modal-header" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Dispatch Approved Journey</span>
            <span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid #10b981;font-size:0.7rem;">Approved journey</span>
          </div>
          <div class="modal-body">
            \${state.executionError ? \`
              <div class="preflight-error-banner" id="preflight-error-banner">
                <strong>Preflight Refusal:</strong> \${escapeHtml(state.executionError)}
                \${state.executionFailureReasons && state.executionFailureReasons.length > 0 ? \`
                  <ul>
                    \${state.executionFailureReasons.map(re => \`<li>\${escapeHtml(re)}</li>\`).join('')}
                  </ul>
                \` : ''}
                <div style="margin-top:0.5rem;font-size:0.75rem;color:#fca5a5;">
                  Zero browser processes launched. Zero network requests issued to target.
                </div>
              </div>
            \` : ''}

            <div class="execution-warning-box">
              <strong>Preflight Safety Notice:</strong> The server runs the safety preflight gate before any browser launch. Production environments, payment operations, unapproved origins, and unsafe actions are unconditionally blocked.
            </div>

            <div class="execution-spec-list">
              <div class="execution-spec-item">
                <span class="execution-spec-label">Target Environment</span>
                <span class="execution-spec-value">\${escapeHtml(state.executionModalTarget.environment)}</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Target URL Origin</span>
                <span class="execution-spec-value">\${escapeHtml(state.executionModalJourney.origin)}</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Journey Goal</span>
                <span class="execution-spec-value" style="font-family:var(--font-sans);text-align:right;">\${escapeHtml(state.executionModalJourney.goal)}</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Safe-Test Mode</span>
                <span class="execution-spec-value" style="color:#10b981;">Enabled (Mandatory)</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Expected Actions</span>
                <span class="execution-spec-value">\${escapeHtml(state.executionModalJourney.allowedActions.join(', '))}</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Prohibited Actions</span>
                <span class="execution-spec-value" style="color:#fca5a5;">\${escapeHtml((state.executionModalJourney.forbiddenActions && state.executionModalJourney.forbiddenActions.length > 0 ? state.executionModalJourney.forbiddenActions : ['payment', 'checkout', 'modify_credentials', 'delete_account']).join(', '))}</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Test Data Status</span>
                <span class="execution-spec-value">\${
                  (state.executionModalJourney.requiresTestData || state.executionModalJourney.requiresCredentials)
                    ? (state.executionModalTarget.testDataReference ? 'Protected test data configured' : 'Protected test data missing')
                    : 'Protected test data not required'
                }</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Expected Browser Activity</span>
                <span class="execution-spec-value" style="font-family:var(--font-sans);">Isolated headless Chromium via worker queue</span>
              </div>
              <div class="execution-spec-item">
                <span class="execution-spec-label">Artifact Behavior</span>
                <span class="execution-spec-value" style="font-family:var(--font-sans);">Captures screenshots, logs, and trace evidence</span>
              </div>
            </div>

            <div class="confirmation-checkbox-group">
              <input type="checkbox" id="check-confirm-run" \${state.executionModalAgreed ? 'checked' : ''}>
              <label for="check-confirm-run">
                I explicitly confirm dispatching this approved journey against the designated non-production target origin under safe-test constraints.
              </label>
            </div>
          </div>
          <div class="modal-footer">
            <button id="btn-cancel-run-modal" class="btn btn-secondary">Cancel</button>
            <button id="btn-confirm-run" class="btn btn-primary" \${(!state.executionModalAgreed || state.executionSubmitting) ? 'disabled' : ''}>
              \${state.executionSubmitting ? 'Enqueuing...' : 'Run journey'}
            </button>
          </div>
        </div>
      </div>
    \` : '';

    const targetModal = state.targetModalOpen ? \`
      <div class="modal-backdrop">
        <div class="modal-card">
          <div class="modal-header">
            <h3 style="margin:0;font-size:1.15rem;">Register Target Environment</h3>
          </div>
          <div class="modal-body">
            <div class="execution-warning-box">
              <strong>Safe-Test Notice:</strong> Only dedicated non-production environments (staging, qa, demo, local) may be registered. Production targets are strictly prohibited.
            </div>
            \${state.targetError ? \`<div style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.targetError)}</div>\` : ''}
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-target-name">Target Name</label>
              <input id="input-target-name" class="form-input" type="text" value="External Staging Pilot" required>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="select-target-env">Environment</label>
              <select id="select-target-env" class="form-input">
                <option value="staging" selected>staging</option>
                <option value="qa">qa</option>
                <option value="demo">demo</option>
                <option value="local">local</option>
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-target-url">Target URL</label>
              <input id="input-target-url" class="form-input" type="url" value="https://crashlab-api.onrender.com/staging-pilot" required>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-target-origins">Allowed Origins</label>
              <input id="input-target-origins" class="form-input" type="text" value="https://crashlab-api.onrender.com" required>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-target-auth-ref">Owner Authorization Reference</label>
              <input id="input-target-auth-ref" class="form-input" type="text" value="AUTH-STAGING-PILOT-12H" required>
              <div class="form-help">Identifier verifying owner approval (no secret keys or tokens).</div>
            </div>
          </div>
          <div class="modal-footer">
            <button id="btn-cancel-target-modal" class="btn btn-secondary">Cancel</button>
            <button id="btn-submit-target" class="btn btn-primary" \${state.targetSubmitting ? 'disabled' : ''}>
              \${state.targetSubmitting ? 'Registering...' : 'Register Target'}
            </button>
          </div>
        </div>
      </div>
    \` : '';

    const targetOptions = state.targets.map(t => \`<option value="\${escapeHtml(t.id)}">\${escapeHtml(t.name)} (\${escapeHtml(t.environment)})</option>\`).join('');
    const journeyModal = state.journeyModalOpen ? \`
      <div class="modal-backdrop">
        <div class="modal-card">
          <div class="modal-header">
            <h3 style="margin:0;font-size:1.15rem;">Create Approved Journey</h3>
          </div>
          <div class="modal-body">
            <div class="execution-warning-box">
              <strong>Human QA Review:</strong> Approved journeys declare explicit boundaries for automated exploration. Financial and destructive actions are permanently prohibited.
            </div>
            \${state.journeyError ? \`<div style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.journeyError)}</div>\` : ''}
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="select-journey-target">Target Environment</label>
              <select id="select-journey-target" class="form-input">
                \${targetOptions}
              </select>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-journey-goal">Human Goal / Intent</label>
              <input id="input-journey-goal" class="form-input" type="text" value="Verify staging pilot interaction and defect detection" required>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-journey-origin">Target Origin</label>
              <input id="input-journey-origin" class="form-input" type="url" value="\${escapeHtml(state.targets[0]?.targetOrigin || 'https://crashlab-api.onrender.com')}" required>
            </div>
            <div class="form-group" style="margin-bottom:0.75rem;">
              <label class="form-label" for="input-journey-actions">Allowed Actions</label>
              <input id="input-journey-actions" class="form-input" type="text" value="navigate, click, interact" required>
            </div>
          </div>
          <div class="modal-footer">
            <button id="btn-cancel-journey-modal" class="btn btn-secondary">Cancel</button>
            <button id="btn-submit-journey" class="btn btn-primary" \${state.journeySubmitting ? 'disabled' : ''}>
              \${state.journeySubmitting ? 'Creating...' : 'Approve Journey'}
            </button>
          </div>
        </div>
      </div>
    \` : '';

    return \`
      <div class="panel-header">
        <div>
          <a href="#/projects" style="font-size:0.8rem;color:var(--accent-primary-hover);text-decoration:none;">&larr; Back to Projects</a>
          <h1 class="panel-title" style="font-size:1.35rem;margin-top:0.25rem;">\${escapeHtml(p.name)}</h1>
        </div>
      </div>
      \${renderTrustBanner()}
      <div style="display:grid;grid-template-columns:300px 1fr;gap:1.5rem;align-items:start;">
        <div>
          <div class="panel">
            <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;">
              <h2 class="panel-title" style="font-size:1rem;margin:0;">Configured Targets</h2>
              <button id="btn-open-target-modal" class="btn btn-secondary btn-sm">+ Register Target</button>
            </div>
            \${targetList || '<p style="color:var(--text-dim);font-size:0.8rem;">No targets configured.</p>'}
          </div>
        </div>
        <div>
          <div class="panel">
            <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;">
              <h2 class="panel-title" style="font-size:1rem;margin:0;">Approved Journeys</h2>
              <button id="btn-open-journey-modal" class="btn btn-secondary btn-sm" \${state.targets.length === 0 ? 'disabled' : ''}>+ Create Journey</button>
            </div>
            \${journeyCards || '<p style="color:var(--text-dim);font-size:0.85rem;padding:1rem;text-align:center;">No approved journeys found for this project.</p>'}
          </div>

          <div class="panel">
            <div class="panel-header">
              <h2 class="panel-title" style="font-size:1rem;">Recent Test Runs</h2>
            </div>
            <div class="table-responsive">
              <table class="dash-table">
                <thead>
                  <tr>
                    <th>Run ID</th>
                    <th>Status</th>
                    <th>Attempts</th>
                    <th>Created</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  \${runRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:2rem;">No runs executed for this project.</td></tr>'}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      \${executionModal}
      \${targetModal}
      \${journeyModal}
    \`;
  }

  function renderRunDetailView() {
    const run = state.selectedRun;
    if (!run) {
      return '<div class="state-box"><h3>Run not found.</h3></div>';
    }

    const q = state.selectedQueueItem;
    const isCancellable = ['queued', 'preflight', 'running', 'cancelling'].includes(run.status);

    const candRows = state.candidates.map(c => \`
      <tr>
        <td><code>\${escapeHtml(c.candidateId || c.id)}</code></td>
        <td><code>\${escapeHtml(c.ruleId || 'N/A')}</code></td>
        <td><span style="font-weight:600;color:#fca5a5;">\${escapeHtml(c.classification)}</span></td>
        <td>\${c.reproduced ? '<span style="color:#f59e0b;">Yes (Signal recurs)</span>' : 'No'}</td>
        <td>\${renderReviewStatusPill(c.reviewStatus)}</td>
      </tr>
    \`).join('');

    const artRows = state.artifacts.map(a => \`
      <tr>
        <td><code>\${escapeHtml(a.id.slice(0, 12))}</code></td>
        <td><span class="badge" style="background:var(--bg-surface-elevated);color:var(--text-main);border:1px solid var(--border-subtle);">\${escapeHtml(a.type)}</span></td>
        <td>\${escapeHtml(a.contentType)}</td>
        <td>\${Math.round(a.byteSize / 1024)} KB</td>
        <td>
          <button class="btn btn-secondary btn-sm btn-inspect-artifact" data-id="\${escapeHtml(a.id)}">Preview</button>
          <button class="btn btn-secondary btn-sm btn-download-artifact" data-id="\${escapeHtml(a.id)}">Download</button>
        </td>
      </tr>
    \`).join('');

    return \`
      <div class="panel-header">
        <div>
          <a href="#/projects/\${escapeHtml(run.projectId)}" style="font-size:0.8rem;color:var(--accent-primary-hover);text-decoration:none;">&larr; Back to Project Runs</a>
          <h1 class="panel-title" style="font-size:1.35rem;margin-top:0.25rem;">
            Run: <span style="font-family:var(--font-mono);">\${escapeHtml(run.id)}</span>
          </h1>
        </div>
        <div>
          \${isCancellable ? \`<button id="btn-open-cancel" class="btn btn-danger btn-sm">Cancel Run</button>\` : ''}
        </div>
      </div>
      \${renderTrustBanner()}

      <div class="grid-cards">
        <div class="stat-card">
          <div class="title">Current Lifecycle Status</div>
          <div style="margin-top:0.5rem;">\${renderStatusPill(run.status)}</div>
        </div>
        <div class="stat-card">
          <div class="title">Queue Lease Status</div>
          <div style="font-size:1.15rem;font-weight:700;color:\${q ? 'var(--status-queued)' : 'var(--text-dim)'};">
            \${q ? escapeHtml(q.queueStatus) : 'No active lease'}
          </div>
          <div style="font-size:0.75rem;color:var(--text-dim);">
            \${q && q.leaseOwner ? \`Worker: \${escapeHtml(q.leaseOwner)}\` : 'Unassigned'}
          </div>
        </div>
        <div class="stat-card">
          <div class="title">Execution Attempts</div>
          <div class="value">\${run.attemptCount || 1} <span style="font-size:0.9rem;color:var(--text-dim);font-weight:400;">/ \${run.maxAttempts || 1} max</span></div>
        </div>
        <div class="stat-card">
          <div class="title">Candidate Defects</div>
          <div class="value" style="color:\${state.candidates.length > 0 ? '#fca5a5' : 'var(--status-completed)'};">
            \${state.candidates.length}
          </div>
        </div>
      </div>

      <!-- Extended Run Monitor Specs -->
      <div class="panel" style="margin-top:1.5rem;">
        <div class="panel-header">
          <h2 class="panel-title" style="font-size:1rem;">Run Execution Details</h2>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(220px, 1fr));gap:1rem;font-size:0.85rem;">
          <div><strong style="color:var(--text-dim);">Run ID:</strong> <code style="font-size:0.78rem;">\${escapeHtml(run.id)}</code></div>
          <div><strong style="color:var(--text-dim);">Request ID:</strong> <code style="font-size:0.78rem;">\${escapeHtml(run.requestId || state.lastRequestId || 'N/A')}</code></div>
          <div><strong style="color:var(--text-dim);">Project ID:</strong> <code style="font-size:0.78rem;">\${escapeHtml(run.projectId)}</code></div>
          <div><strong style="color:var(--text-dim);">Target Environment:</strong> <code style="font-size:0.78rem;">\${escapeHtml(run.targetEnvironmentId)}</code></div>
          <div><strong style="color:var(--text-dim);">Approved Journey:</strong> <code style="font-size:0.78rem;">\${escapeHtml(run.journeyId)}</code></div>
          <div><strong style="color:var(--text-dim);">Verification Status:</strong> <span style="color:#10b981;">\${run.safeTestMode ? 'Safe-Test Enforced (Safe)' : 'Safe-Test Inactive'}</span></div>
          <div><strong style="color:var(--text-dim);">Artifact Count:</strong> \${state.artifacts.length}</div>
          <div><strong style="color:var(--text-dim);">Anomaly Count:</strong> \${run.anomalyCount ?? state.candidates.length}</div>
          <div><strong style="color:var(--text-dim);">Candidate Count:</strong> \${state.candidates.length}</div>
          <div><strong style="color:var(--text-dim);">Created At:</strong> \${new Date(run.createdAt).toLocaleString()}</div>
          <div><strong style="color:var(--text-dim);">Updated At:</strong> \${new Date(run.updatedAt).toLocaleString()}</div>
          <div><strong style="color:var(--text-dim);">Failure / Blocked Reason:</strong> \${escapeHtml(run.failureReason || run.blockedReason || 'None')}</div>
        </div>
      </div>

      \${run.failureReason ? \`
        <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1.5rem;color:#fca5a5;font-size:0.85rem;">
          <strong>Failure Reason:</strong> \${escapeHtml(run.failureReason)}
        </div>
      \` : ''}

      \${run.blockedReason ? \`
        <div style="background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.4);border-radius:6px;padding:0.75rem 1rem;margin-bottom:1.5rem;color:#f87171;font-size:0.85rem;">
          <strong>Preflight Blocked Reason:</strong> \${escapeHtml(run.blockedReason)}
        </div>
      \` : ''}

      <!-- Candidate Findings -->
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title" style="font-size:1rem;">Candidate Findings</h2>
        </div>
        <div class="invariant-card">
          <span>&bull;</span>
          <span><strong>Trust Invariant:</strong> Candidate finding — not a confirmed defect. <code>confirmedBug: false</code> &bull; <code>confirmed: false</code>. Automated findings are investigation leads, not confirmed application defects. Human acceptance is not automated confirmation.</span>
        </div>
        <div class="table-responsive">
          <table class="dash-table">
            <thead>
              <tr>
                <th>Candidate ID</th>
                <th>Rule ID</th>
                <th>Classification</th>
                <th>Signal Reproduces</th>
                <th>Human Review Status</th>
              </tr>
            </thead>
            <tbody>
              \${candRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:1.5rem;">Zero candidate findings detected in this run.</td></tr>'}
            </tbody>
          </table>
        </div>
        <div style="margin-top:1rem;font-size:0.75rem;color:var(--text-dim);">
          Triage CLI: <code>npm run review-state -- --candidate &lt;id&gt; --status investigating</code> (Statuses: open, investigating, accepted, dismissed, duplicate, resolved, unreviewed)
        </div>
      </div>

      <!-- Artifacts -->
      <div class="panel">
        <div class="panel-header">
          <h2 class="panel-title" style="font-size:1rem;">Evidence Artifacts</h2>
        </div>
        <div class="table-responsive">
          <table class="dash-table">
            <thead>
              <tr>
                <th>Artifact ID</th>
                <th>Type</th>
                <th>Content-Type</th>
                <th>Size</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              \${artRows || '<tr><td colspan="5" style="text-align:center;color:var(--text-dim);padding:1.5rem;">No artifacts attached to this run.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Artifact Preview Modal / Pane -->
      \${state.selectedArtifact ? \`
        <div class="panel" id="artifact-preview-panel">
          <div class="panel-header">
            <h3 class="panel-title" style="font-size:0.95rem;">
              Preview: \${escapeHtml(state.selectedArtifact.type)} (\${escapeHtml(state.selectedArtifact.id)})
            </h3>
            <button id="btn-close-preview" class="btn btn-secondary btn-sm">&times; Close</button>
          </div>
          \${state.selectedArtifactLoading ? '<div style="padding:1.5rem;text-align:center;color:var(--text-dim);">Fetching artifact payload...</div>' : ''}
          \${state.selectedArtifactContent && state.selectedArtifactContent.type === 'text' ? \`
            <div class="artifact-preview-box">\${escapeHtml(state.selectedArtifactContent.content)}</div>
          \` : ''}
          \${state.selectedArtifactContent && state.selectedArtifactContent.type === 'image' ? \`
            <div style="text-align:center;padding:1rem;">
              <img src="\${state.selectedArtifactContent.url}" class="artifact-image-preview" alt="Screenshot preview">
            </div>
          \` : ''}
          \${state.selectedArtifactContent && state.selectedArtifactContent.type === 'error' ? \`
            <div style="color:var(--status-failed);padding:1rem;">\${escapeHtml(state.selectedArtifactContent.error)}</div>
          \` : ''}
        </div>
      \` : ''}

      <!-- Cancel Run Modal -->
      \${state.cancelModalOpen ? \`
        <div class="modal-overlay">
          <div class="modal-card">
            <div class="modal-header">Confirm Run Cancellation</div>
            <div class="modal-body">
              Are you sure you want to cancel test run <code>\${escapeHtml(run.id)}</code>?<br><br>
              Execution will stop safely and all captured evidence will be preserved.
            </div>
            <div class="modal-footer">
              <button id="btn-cancel-modal-close" class="btn btn-secondary">Keep Running</button>
              <button id="btn-cancel-modal-confirm" class="btn btn-danger" \${state.cancelSubmitting ? 'disabled' : ''}>
                \${state.cancelSubmitting ? 'Cancelling...' : 'Confirm Cancellation'}
              </button>
            </div>
          </div>
        </div>
      \` : ''}
    \`;
  }

  function renderSecurityView() {
    return \`
      <div class="panel-header">
        <h1 class="panel-title" style="font-size:1.35rem;">Security &amp; Trust Model</h1>
      </div>
      \${renderTrustBanner()}
      <div class="panel">
        <h2 class="panel-title" style="font-size:1rem;margin-bottom:0.75rem;">1. Mandatory Preflight Safety Gate</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;line-height:1.6;">
          Every asynchronous run must pass strict preflight validation before any browser process is launched.
          Runs targeting production environments or origins not listed in <code>allowedOrigins</code> are rejected with status <code>blocked</code>, launching zero browsers and issuing zero target network requests.
        </p>
      </div>
      <div class="panel">
        <h2 class="panel-title" style="font-size:1rem;margin-bottom:0.75rem;">2. Defect Confirmation Invariant</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;line-height:1.6;">
          <code>confirmedBug: false</code> &bull; <code>confirmed: false</code> is non-negotiable. Candidate finding — not a confirmed defect. Human acceptance is not automated confirmation. CrashLab classifies unexpected responses and errors as candidate defects with complete execution provenance for human review. Automated systems cannot declare application bugs without authorized engineer confirmation.
        </p>
      </div>
      <div class="panel">
        <h2 class="panel-title" style="font-size:1rem;margin-bottom:0.75rem;">3. Safe-Test Mode &amp; Payment Guards</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;line-height:1.6;">
          Safe-test mode is permanently active. Forbidden actions (checkout, financial transfers, subscription mutations, password deletions) are blocked before action dispatch.
        </p>
      </div>
    \`;
  }

  // --- Main Application Render ---
  function renderApp() {
    const root = document.getElementById('app');
    if (!root) return;

    if (state.route === 'auth') {
      root.innerHTML = renderAuthView();
      bindAuthEvents();
      return;
    }

    let mainContent = '';
    if (state.loading && !state.selectedRun) {
      mainContent = '<div class="state-box"><h3>Loading...</h3></div>';
    } else if (state.error) {
      mainContent = \`<div class="state-box error"><h3>Error</h3><p>\${escapeHtml(state.error)}</p></div>\`;
    } else {
      switch (state.route) {
        case 'overview':
        case 'projects':
          const { id } = parseHash();
          mainContent = id ? renderProjectDetailView() : renderOverviewView();
          break;
        case 'run-detail':
          mainContent = renderRunDetailView();
          break;
        case 'security':
          mainContent = renderSecurityView();
          break;
        default:
          mainContent = renderOverviewView();
      }
    }

    root.innerHTML = \`
      \${renderNavbar()}
      <div class="dash-body">
        \${renderSidebar()}
        <main class="dash-main">
          \${mainContent}
        </main>
      </div>
    \`;

    bindGlobalEvents();
  }

  // --- DOM Event Binding ---
  function bindAuthEvents() {
    const form = document.getElementById('auth-form');
    if (!form) return;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      state.error = null;

      if (state.authMode === 'production') {
        const tokenInput = document.getElementById('input-token');
        const directToken = tokenInput ? tokenInput.value.trim() : '';

        if (directToken) {
          state.token = directToken;
          try {
            const parts = directToken.split('.');
            if (parts.length === 3) {
              const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
              state.currentUser = {
                id: payload.sub || 'user',
                email: payload.email || 'user@crashlab.internal',
                name: payload.user_metadata?.name || (payload.email ? payload.email.split('@')[0] : 'User'),
                status: 'active',
              };
            }
          } catch {}
          navigate('overview');
          return;
        }

        const emailInput = document.getElementById('input-email');
        const passwordInput = document.getElementById('input-password');
        const urlInput = document.getElementById('input-supabase-url');
        const anonKeyInput = document.getElementById('input-anon-key');

        const email = emailInput ? emailInput.value.trim() : '';
        const password = passwordInput ? passwordInput.value : '';
        const targetSupabaseUrl = state.supabaseUrl || (urlInput ? urlInput.value.trim() : '');
        const targetAnonKey = state.supabaseAnonKey || (anonKeyInput ? anonKeyInput.value.trim() : '');

        if (!email || !password) {
          state.error = 'Email and password (or Supabase User JWT) are required.';
          renderApp();
          return;
        }

        if (!targetSupabaseUrl) {
          state.error = 'Supabase URL is required.';
          renderApp();
          return;
        }

        if (!targetAnonKey) {
          state.error = 'Supabase public anon key is required.';
          renderApp();
          return;
        }

        state.authSubmitting = true;
        renderApp();

        try {
          const authEndpoint = \`\${targetSupabaseUrl.replace(/\\/+$/, '')}/auth/v1/token?grant_type=password\`;
          const res = await fetch(authEndpoint, {
            method: 'POST',
            headers: {
              'apikey': targetAnonKey,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email, password }),
          });

          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const msg = data.error_description || data.msg || data.message || \`Authentication failed (HTTP \${res.status})\`;
            throw new Error(msg);
          }

          if (!data.access_token) {
            throw new Error('Supabase authentication did not return an access token.');
          }

          state.token = data.access_token;
          state.currentUser = data.user ? {
            id: data.user.id,
            email: data.user.email,
            name: data.user.user_metadata?.name || (data.user.email ? data.user.email.split('@')[0] : 'User'),
            status: 'active',
          } : null;

          navigate('overview');
        } catch (err) {
          state.error = err.message || 'Authentication failed.';
        } finally {
          state.authSubmitting = false;
          renderApp();
        }
      } else {
        const urlInput = document.getElementById('input-api-url');
        const tokenInput = document.getElementById('input-token');
        if (urlInput) state.apiUrl = urlInput.value.trim();
        if (tokenInput) state.token = tokenInput.value.trim();

        if (!state.token) {
          state.error = 'Bearer token is required.';
          renderApp();
          return;
        }

        navigate('overview');
      }
    });
  }

  function bindGlobalEvents() {
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => {
        poller.stop();
        state.token = null;
        state.currentUser = null;
        state.currentWorkspace = null;
        navigate('auth');
      });
    }

    const wsSelect = document.getElementById('ws-select');
    if (wsSelect) {
      wsSelect.addEventListener('change', (e) => {
        const selectedId = e.target.value;
        const ws = state.workspaces.find(w => w.id === selectedId);
        if (ws) {
          state.currentWorkspace = ws;
          poller.stop();
          handleRouteChange();
        }
      });
    }

    // Run execution modal triggers
    document.querySelectorAll('.btn-open-run-modal').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const journeyId = e.currentTarget.getAttribute('data-journey-id');
        const journey = state.journeys.find(j => j.id === journeyId);
        if (!journey) return;
        const target = state.targets.find(t => t.id === journey.targetEnvironmentId) || state.targets[0];
        if (!target) {
          alert('No configured target environment found for journey.');
          return;
        }
        state.executionModalJourney = journey;
        state.executionModalTarget = target;
        state.executionModalAgreed = false;
        state.executionSubmitting = false;
        state.executionError = null;
        state.executionFailureReasons = [];
        state.executionModalOpen = true;
        renderApp();
      });
    });

    const checkConfirm = document.getElementById('check-confirm-run');
    if (checkConfirm) {
      checkConfirm.addEventListener('change', (e) => {
        state.executionModalAgreed = e.target.checked;
        const confirmBtn = document.getElementById('btn-confirm-run');
        if (confirmBtn) {
          confirmBtn.disabled = !state.executionModalAgreed || state.executionSubmitting;
        }
      });
    }

    const cancelRunModalBtn = document.getElementById('btn-cancel-run-modal');
    if (cancelRunModalBtn) {
      cancelRunModalBtn.addEventListener('click', () => {
        state.executionModalOpen = false;
        state.executionModalJourney = null;
        state.executionModalTarget = null;
        state.executionError = null;
        state.executionFailureReasons = [];
        renderApp();
      });
    }

    const confirmRunBtn = document.getElementById('btn-confirm-run');
    if (confirmRunBtn) {
      confirmRunBtn.addEventListener('click', async () => {
        if (!state.currentWorkspace || !state.selectedProject || !state.executionModalJourney || !state.executionModalTarget) {
          return;
        }
        state.executionSubmitting = true;
        state.executionError = null;
        state.executionFailureReasons = [];
        renderApp();

        try {
          const res = await api.postJson('/api/v1/runs', {
            workspaceId: state.currentWorkspace.id,
            projectId: state.selectedProject.id,
            targetEnvironmentId: state.executionModalTarget.id,
            journeyId: state.executionModalJourney.id,
          });

          if (res && res.success && res.data) {
            state.executionModalOpen = false;
            state.executionModalJourney = null;
            state.executionModalTarget = null;
            state.executionSubmitting = false;
            navigate(\`run-detail/\${res.data.id}\`);
          } else {
            throw new Error('Unexpected response format from API server.');
          }
        } catch (err) {
          state.executionSubmitting = false;
          state.executionError = err.message || 'Execution request failed.';
          state.executionFailureReasons = err.failureReasons && err.failureReasons.length > 0
            ? err.failureReasons
            : [err.message];
          renderApp();
        }
      });
    }

    // Target Registration modal triggers
    const openTargetModalBtn = document.getElementById('btn-open-target-modal');
    if (openTargetModalBtn) {
      openTargetModalBtn.addEventListener('click', () => {
        state.targetModalOpen = true;
        state.targetError = null;
        state.targetSubmitting = false;
        renderApp();
      });
    }

    const cancelTargetModalBtn = document.getElementById('btn-cancel-target-modal');
    if (cancelTargetModalBtn) {
      cancelTargetModalBtn.addEventListener('click', () => {
        state.targetModalOpen = false;
        state.targetError = null;
        renderApp();
      });
    }

    const submitTargetBtn = document.getElementById('btn-submit-target');
    if (submitTargetBtn) {
      submitTargetBtn.addEventListener('click', async () => {
        if (!state.currentWorkspace || !state.selectedProject) return;
        const nameInput = document.getElementById('input-target-name');
        const envInput = document.getElementById('select-target-env');
        const urlInput = document.getElementById('input-target-url');
        const originsInput = document.getElementById('input-target-origins');
        const authRefInput = document.getElementById('input-target-auth-ref');

        const name = nameInput ? nameInput.value.trim() : '';
        const environment = envInput ? envInput.value.trim() : 'staging';
        const targetUrl = urlInput ? urlInput.value.trim() : '';
        const allowedOrigins = originsInput
          ? originsInput.value.split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const authorizationReference = authRefInput ? authRefInput.value.trim() : '';

        if (!name || !targetUrl) {
          state.targetError = 'Name and Target URL are required.';
          renderApp();
          return;
        }

        state.targetSubmitting = true;
        state.targetError = null;
        renderApp();

        try {
          const res = await api.postJson('/api/v1/projects/' + state.selectedProject.id + '/targets', {
            workspaceId: state.currentWorkspace.id,
            name,
            environment,
            targetUrl,
            allowedOrigins,
            authorizationReference,
          });
          if (res && res.success && res.data) {
            state.targets.push(res.data);
            state.targetModalOpen = false;
            state.targetSubmitting = false;
            renderApp();
          } else {
            throw new Error(res.error?.message || 'Failed to register target.');
          }
        } catch (err) {
          state.targetSubmitting = false;
          state.targetError = err.message || 'Target registration failed.';
          renderApp();
        }
      });
    }

    // Journey Creation modal triggers
    const openJourneyModalBtn = document.getElementById('btn-open-journey-modal');
    if (openJourneyModalBtn) {
      openJourneyModalBtn.addEventListener('click', () => {
        state.journeyModalOpen = true;
        state.journeyError = null;
        state.journeySubmitting = false;
        renderApp();
      });
    }

    const cancelJourneyModalBtn = document.getElementById('btn-cancel-journey-modal');
    if (cancelJourneyModalBtn) {
      cancelJourneyModalBtn.addEventListener('click', () => {
        state.journeyModalOpen = false;
        state.journeyError = null;
        renderApp();
      });
    }

    const selectJourneyTarget = document.getElementById('select-journey-target');
    if (selectJourneyTarget) {
      selectJourneyTarget.addEventListener('change', (e) => {
        const tId = e.target.value;
        const tgt = state.targets.find(t => t.id === tId);
        const originInput = document.getElementById('input-journey-origin');
        if (tgt && originInput) {
          originInput.value = tgt.targetOrigin;
        }
      });
    }

    const submitJourneyBtn = document.getElementById('btn-submit-journey');
    if (submitJourneyBtn) {
      submitJourneyBtn.addEventListener('click', async () => {
        if (!state.currentWorkspace || !state.selectedProject) return;
        const targetSelect = document.getElementById('select-journey-target');
        const goalInput = document.getElementById('input-journey-goal');
        const originInput = document.getElementById('input-journey-origin');
        const actionsInput = document.getElementById('input-journey-actions');

        const targetEnvironmentId = targetSelect ? targetSelect.value : (state.targets[0]?.id || '');
        const goal = goalInput ? goalInput.value.trim() : '';
        const origin = originInput ? originInput.value.trim() : '';
        const allowedActions = actionsInput
          ? actionsInput.value.split(',').map(s => s.trim()).filter(Boolean)
          : ['navigate', 'click'];

        if (!targetEnvironmentId || !goal || !origin) {
          state.journeyError = 'Target, Goal, and Origin are required.';
          renderApp();
          return;
        }

        state.journeySubmitting = true;
        state.journeyError = null;
        renderApp();

        try {
          const res = await api.postJson('/api/v1/projects/' + state.selectedProject.id + '/journeys', {
            workspaceId: state.currentWorkspace.id,
            targetEnvironmentId,
            goal,
            origin,
            allowedActions,
          });
          if (res && res.success && res.data) {
            state.journeys.push(res.data);
            state.journeyModalOpen = false;
            state.journeySubmitting = false;
            renderApp();
          } else {
            throw new Error(res.error?.message || 'Failed to create journey.');
          }
        } catch (err) {
          state.journeySubmitting = false;
          state.journeyError = err.message || 'Journey creation failed.';
          renderApp();
        }
      });
    }

    // Cancel modal trigger
    const openCancelBtn = document.getElementById('btn-open-cancel');
    if (openCancelBtn) {
      openCancelBtn.addEventListener('click', () => {
        state.cancelModalOpen = true;
        renderApp();
      });
    }

    const closeCancelBtn = document.getElementById('btn-cancel-modal-close');
    if (closeCancelBtn) {
      closeCancelBtn.addEventListener('click', () => {
        state.cancelModalOpen = false;
        renderApp();
      });
    }

    const confirmCancelBtn = document.getElementById('btn-cancel-modal-confirm');
    if (confirmCancelBtn && state.selectedRun) {
      confirmCancelBtn.addEventListener('click', () => {
        triggerCancelRun(state.selectedRun.id);
      });
    }

    // Artifact inspection triggers
    document.querySelectorAll('.btn-inspect-artifact').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        if (id) inspectArtifact(id);
      });
    });

    document.querySelectorAll('.btn-download-artifact').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const id = e.target.getAttribute('data-id');
        if (id) downloadArtifact(id);
      });
    });

    const closePreviewBtn = document.getElementById('btn-close-preview');
    if (closePreviewBtn) {
      closePreviewBtn.addEventListener('click', () => {
        state.selectedArtifact = null;
        state.selectedArtifactContent = null;
        renderApp();
      });
    }
  }

  // --- Initial Bootstrap ---
  function init() {
    const metaApiUrl = document.querySelector('meta[name="default-api-url"]');
    if (metaApiUrl && metaApiUrl.content) {
      state.apiUrl = decodeURI(metaApiUrl.content);
    }
    const metaAuthMode = document.querySelector('meta[name="auth-mode"]');
    if (metaAuthMode && metaAuthMode.content) {
      state.authMode = metaAuthMode.content;
    }
    const metaSupabaseUrl = document.querySelector('meta[name="supabase-url"]');
    if (metaSupabaseUrl && metaSupabaseUrl.content) {
      state.supabaseUrl = decodeURI(metaSupabaseUrl.content);
    }
    const metaSupabaseAnonKey = document.querySelector('meta[name="supabase-anon-key"]');
    if (metaSupabaseAnonKey && metaSupabaseAnonKey.content) {
      state.supabaseAnonKey = decodeURI(metaSupabaseAnonKey.content);
    }

    if (!state.token) {
      state.route = 'auth';
      navigate('auth');
      renderApp();
    } else {
      handleRouteChange();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
`;
