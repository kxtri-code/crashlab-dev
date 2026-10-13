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
        try {
          const errData = await res.json();
          if (errData && errData.error && errData.error.message) {
            errMessage = errData.error.message;
          }
        } catch (_) {}
        throw new Error(errMessage);
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
          const [pRes, tRes, rRes] = await Promise.all([
            api.getJson(\`/api/v1/projects/\${id}?workspaceId=\${wsId}\`),
            api.getJson(\`/api/v1/projects/\${id}/targets?workspaceId=\${wsId}\`),
            api.getJson(\`/api/v1/projects/\${id}/runs?workspaceId=\${wsId}\`),
          ]);
          if (pRes.success) state.selectedProject = pRes.data;
          if (tRes.success) state.targets = tRes.data.targets || [];
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

  async function downloadArtifact(artifactId) {
    if (!state.currentWorkspace) return;
    const art = state.artifacts.find(a => a.id === artifactId);
    if (!art) return;

    try {
      const { blob } = await api.getBlob(\`/api/v1/artifacts/\${artifactId}/content?workspaceId=\${state.currentWorkspace.id}\`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = \`artifact-\${art.type}-\${art.id.slice(0, 8)}.\${art.contentType.includes('json') ? 'json' : 'bin'}\`;
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
          <span><strong>Safe-Test Mode Active</strong> &bull; Non-destructive only &bull; Financial & destructive actions permanently blocked.</span>
        </div>
        <div style="font-size:0.75rem;color:var(--text-dim);">
          <code>confirmedBug: false</code>
        </div>
      </div>
    \`;
  }

  function renderAuthView() {
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

    const runRows = state.runs.map(r => \`
      <tr>
        <td><a href="#/run-detail/\${escapeHtml(r.id)}" style="color:var(--text-main);font-family:var(--font-mono);font-size:0.8rem;">\${escapeHtml(r.id.slice(0, 14))}...</a></td>
        <td>\${renderStatusPill(r.status)}</td>
        <td>\${r.attemptCount || 1} / \${r.maxAttempts || 1}</td>
        <td style="font-size:0.75rem;color:var(--text-muted);">\${new Date(r.createdAt).toLocaleString()}</td>
        <td><a href="#/run-detail/\${escapeHtml(r.id)}" class="btn btn-secondary btn-sm">Details &rarr;</a></td>
      </tr>
    \`).join('');

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
            <h2 class="panel-title" style="font-size:1rem;margin-bottom:0.75rem;">Configured Targets</h2>
            \${targetList || '<p style="color:var(--text-dim);font-size:0.8rem;">No targets configured.</p>'}
          </div>
        </div>
        <div>
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
    \`;
  }

  function renderRunDetailView() {
    const run = state.selectedRun;
    if (!run) {
      return '<div class="state-box"><h3>Run not found.</h3></div>';
    }

    const q = state.selectedQueueItem;
    const isCancellable = ['queued', 'running'].includes(run.status);

    const candRows = state.candidates.map(c => \`
      <tr>
        <td><code>\${escapeHtml(c.candidateId || c.id)}</code></td>
        <td><code>\${escapeHtml(c.ruleId || 'N/A')}</code></td>
        <td><span style="font-weight:600;color:#fca5a5;">\${escapeHtml(c.classification)}</span></td>
        <td>\${c.reproduced ? '<span style="color:#f59e0b;">Yes (Signal recurs)</span>' : 'No'}</td>
        <td><span class="status-pill \${c.reviewStatus === 'unreviewed' ? 'created' : 'completed'}">\${escapeHtml(c.reviewStatus)}</span></td>
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
          <span><strong>Trust Invariant:</strong> <code>confirmedBug: false</code>. Automated findings are investigation leads, not confirmed application defects.</span>
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
          Triage CLI: <code>npm run review-state -- --candidate &lt;id&gt; --status investigating</code>
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
          <code>confirmedBug: false</code> is non-negotiable. CrashLab classifies unexpected responses and errors as candidate defects with complete execution provenance for human review. Automated systems cannot declare application bugs without authorized engineer confirmation.
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
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        state.error = null;
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
      });
    }
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
      state.apiUrl = metaApiUrl.content;
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
