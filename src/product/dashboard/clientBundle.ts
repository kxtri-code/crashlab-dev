/**
 * Client JavaScript Application Bundle — Build 12J.1.
 *
 * Implements the browser single-page dashboard application:
 * - Clear, trustworthy, SaaS-grade operator UX
 * - In-memory bearer token management & Supabase Auth integration
 * - Authenticated API client (zero secret leaks, request ID propagation)
 * - Navigation routing (Overview, Projects, Security & Trust, Help / Pilot Guide)
 * - Safe polling engine with terminal auto-hydration and worker lease normalization
 * - Interactive Candidate Review UI with real-time state persistence
 * - Human-friendly labels with expandable technical detail disclosures
 * - Strict non-negotiable trust invariants: confirmed: false, confirmedBug: false
 * - Accessible artifact previewer & safe downloads
 * - Bounded preflight journey dispatch & idempotent run cancellation
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
    candidateUpdatingId: null,
    candidateUpdateFeedback: null,
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
    activeProjectTab: 'summary',
    loading: false,
    error: null,
    lastRequestId: null,
    route: 'overview', // 'auth' | 'overview' | 'projects' | 'run-detail' | 'security' | 'help'
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
            // Build 12J.1: Refetch fresh run, normalized queue status, artifacts, and candidates together
            try {
              const [freshRunRes, freshQRes, artRes, candRes] = await Promise.allSettled([
                api.getJson('/api/v1/runs/' + runId + '?workspaceId=' + wsId),
                api.getJson('/api/v1/runs/' + runId + '/queue?workspaceId=' + wsId),
                api.getJson('/api/v1/runs/' + runId + '/artifacts?workspaceId=' + wsId),
                api.getJson('/api/v1/runs/' + runId + '/candidates?workspaceId=' + wsId),
              ]);
              if (freshRunRes.status === 'fulfilled' && freshRunRes.value.success) {
                state.selectedRun = freshRunRes.value.data;
              }
              if (freshQRes.status === 'fulfilled' && freshQRes.value.success) {
                state.selectedQueueItem = freshQRes.value.data;
              }
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

  // --- Worker & Queue State Helper (Item 10) ---
  function getWorkerStatus(run, queueItem) {
    const runStatus = (run?.status || '').toLowerCase();
    const leaseOwner = queueItem?.leaseOwner || null;
    const qStatus = (queueItem?.queueStatus || '').toLowerCase();

    // Terminal run states: completed, partial, failed, blocked, cancelled
    if (['completed', 'partial', 'failed', 'blocked', 'cancelled'].includes(runStatus)) {
      return {
        label: 'Worker released',
        badgeClass: 'completed',
        detail: leaseOwner ? \`Worker: \${leaseOwner}\` : 'Worker released',
      };
    }

    if (runStatus === 'running' || qStatus === 'running') {
      if (leaseOwner) {
        return {
          label: 'Worker active',
          badgeClass: 'running',
          detail: \`Worker: \${leaseOwner}\`,
        };
      }
      return {
        label: 'Worker active',
        badgeClass: 'running',
        detail: 'Active lease',
      };
    }

    if (runStatus === 'queued' || qStatus === 'queued') {
      return {
        label: 'Waiting',
        badgeClass: 'queued',
        detail: 'Pending worker assignment',
      };
    }

    return {
      label: queueItem?.queueStatus ? escapeHtml(queueItem.queueStatus) : 'Waiting',
      badgeClass: 'neutral',
      detail: leaseOwner ? \`Worker: \${leaseOwner}\` : 'Unassigned',
    };
  }

  // --- Candidate Domain Helpers ---
  function getCandidateFriendlyInfo(ruleId, classification) {
    const r = (ruleId || '').toUpperCase();
    switch (r) {
      case 'HTTP_5XX':
        return {
          title: 'Server Error Response (HTTP 500)',
          explanation: 'The staging server returned an unexpected 5xx HTTP server response during page interaction.',
          severity: 'high',
        };
      case 'CONSOLE_ERROR':
        return {
          title: 'Browser Console Error',
          explanation: 'An unhandled JavaScript error or rejected promise was logged in the browser console.',
          severity: 'medium',
        };
      case 'DUPLICATE_REQUEST':
        return {
          title: 'Duplicate Network Request',
          explanation: 'Identical document or API requests were sent in rapid succession.',
          severity: 'low',
        };
      case 'FAILED_REQUEST':
        return {
          title: 'Network Resource Load Failure',
          explanation: 'A network request failed to load or the server connection was refused.',
          severity: 'high',
        };
      default:
        return {
          title: ruleId || 'Possible Defect Signal',
          explanation: classification ? \`Detected signal classification: \${classification}\` : 'An unexpected condition was detected during automated journey execution.',
          severity: 'medium',
        };
    }
  }

  function getArtifactFriendlyInfo(type) {
    const t = (type || '').toLowerCase();
    switch (t) {
      case 'execution':
        return { title: 'Execution report', badge: 'JSON', desc: 'Complete step-by-step browser timeline and event log' };
      case 'anomalies':
        return { title: 'Anomaly report', badge: 'JSON', desc: 'Raw anomalies captured by the automated detection engine' };
      case 'candidates':
        return { title: 'Candidate findings', badge: 'JSON', desc: 'Filtered, deduplicated candidate findings for human review' };
      case 'log':
        return { title: 'Run log', badge: 'LOG', desc: 'Playwright worker execution log with timestamped traces' };
      case 'reproduction':
        return { title: 'Reproduction report', badge: 'JSON', desc: 'Evidence from bounded multi-attempt signal verification' };
      case 'screenshot':
        return { title: 'Page screenshot', badge: 'IMG', desc: 'Visual capture of the browser viewport during test execution' };
      case 'trace':
        return { title: 'Execution trace', badge: 'ZIP', desc: 'Playwright execution trace file' };
      default:
        return { title: \`\${type} file\`, badge: 'DOC', desc: 'Evidence file produced during test execution' };
    }
  }

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

  // --- Candidate Review Action (Item 9) ---
  async function submitCandidateReview(candidateId, newStatus) {
    if (!state.currentWorkspace || !candidateId || !newStatus) return;

    state.candidateUpdatingId = candidateId;
    renderApp();

    try {
      const res = await api.postJson(\`/api/v1/candidates/\${candidateId}/review\`, {
        workspaceId: state.currentWorkspace.id,
        status: newStatus,
        notes: \`Review status updated to \${newStatus} by pilot operator\`,
      });

      if (res && res.success && res.data) {
        // Optimistically update candidate row in local state
        state.candidates = state.candidates.map(c => {
          if ((c.candidateId || c.id) === candidateId) {
            return {
              ...c,
              reviewStatus: newStatus,
              confirmed: false,
              confirmedBug: false,
            };
          }
          return c;
        });

        state.candidateUpdateFeedback = {
          candidateId,
          message: \`Status updated to \${newStatus}\`,
        };

        setTimeout(() => {
          if (state.candidateUpdateFeedback?.candidateId === candidateId) {
            state.candidateUpdateFeedback = null;
            renderApp();
          }
        }, 3500);
      } else {
        throw new Error(res.error?.message || 'Review update failed.');
      }
    } catch (err) {
      alert(\`Could not update candidate review: \${err.message}\`);
    } finally {
      state.candidateUpdatingId = null;
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
        let formatted = text;
        try {
          const parsed = JSON.parse(text);
          formatted = JSON.stringify(parsed, null, 2);
        } catch {}
        state.selectedArtifactContent = { type: 'text', content: formatted };
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

    const userName = state.currentUser ? (state.currentUser.name || state.currentUser.email || 'Pilot Operator') : 'Pilot Operator';
    const reqBadge = state.lastRequestId ? \`<span class="request-id-badge" title="Correlation Request ID">\${escapeHtml(state.lastRequestId)}</span>\` : '';

    return \`
      <header class="dash-navbar">
        <a href="#/overview" class="dash-brand">
          CrashLab <span class="badge">Private Beta</span>
        </a>
        <div class="dash-header-controls">
          \${reqBadge}
          <div class="workspace-selector-group" title="Current Workspace &amp; Role">
            <span style="font-size:0.75rem;color:var(--text-dim);font-weight:600;">WORKSPACE:</span>
            <select id="ws-select" class="workspace-select">
              \${wsOptions || '<option disabled selected>No Workspaces</option>'}
            </select>
            <span class="user-role-badge">Pilot Operator</span>
          </div>
          <div class="user-badge">
            <span style="font-weight:600;color:var(--text-main);">\${escapeHtml(userName)}</span>
            <button id="btn-logout" class="btn btn-secondary btn-sm" title="Sign out of CrashLab">Sign Out</button>
          </div>
        </div>
      </header>
    \`;
  }

  function renderSidebar() {
    const r = state.route;
    return \`
      <aside class="dash-sidebar">
        <div class="nav-section-title">Operations</div>
        <a href="#/overview" class="nav-item \${r === 'overview' ? 'active' : ''}">
          <span>📊</span> <span>Overview</span>
        </a>
        <a href="#/projects" class="nav-item \${r === 'projects' || r === 'project-detail' ? 'active' : ''}">
          <span>📁</span> <span>Projects</span>
        </a>
        <div class="nav-section-title" style="margin-top:0.75rem;">Assurance</div>
        <a href="#/security" class="nav-item \${r === 'security' ? 'active' : ''}">
          <span>🛡️</span> <span>Security &amp; Trust</span>
        </a>
        <a href="#/help" class="nav-item \${r === 'help' ? 'active' : ''}">
          <span>📖</span> <span>Help / Pilot Guide</span>
        </a>
      </aside>
    \`;
  }

  function renderTrustBanner() {
    return \`
      <div class="trust-banner">
        <div class="trust-banner-text">
          <span class="trust-banner-badge">Safe-Test Mode</span>
          <span>Safe-Test Mode is active. CrashLab reports investigation leads, not confirmed defects. Financial &amp; destructive operations are permanently prohibited.</span>
        </div>
        <details style="font-size:0.75rem;color:var(--text-dim);cursor:pointer;">
          <summary style="outline:none;user-select:none;">Technical trust details (TRUST INVARIANT)</summary>
          <div style="display:flex;gap:0.75rem;margin-top:0.4rem;">
            <code>confirmedBug: false</code>
            <code>confirmed: false</code>
          </div>
        </details>
      </div>
    \`;
  }

  function renderStatusPill(status, candidateCount = 0) {
    const s = String(status || 'created').toLowerCase();
    const isPulsing = s === 'running' || s === 'preflight';
    const pulseHtml = isPulsing ? '<span class="pulse-dot"></span>' : '';

    if (s === 'completed') {
      if (candidateCount > 0) {
        return \`<span class="status-pill partial">\${pulseHtml}Completed with possible issues</span>\`;
      }
      return \`<span class="status-pill completed">\${pulseHtml}Passed</span>\`;
    }
    if (s === 'running') {
      return \`<span class="status-pill running">\${pulseHtml}Running</span>\`;
    }
    if (s === 'queued') {
      return \`<span class="status-pill queued">\${pulseHtml}Queued</span>\`;
    }
    if (s === 'failed') {
      return \`<span class="status-pill failed">\${pulseHtml}Failed</span>\`;
    }
    if (s === 'blocked') {
      return \`<span class="status-pill blocked">\${pulseHtml}Blocked</span>\`;
    }
    if (s === 'cancelled') {
      return \`<span class="status-pill cancelled">\${pulseHtml}Cancelled</span>\`;
    }
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

  function renderProductionAuthView() {
    const errorHtml = state.error
      ? \`<div id="auth-error-banner" style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.75rem 1rem;border-radius:7px;margin-bottom:1.25rem;font-size:0.85rem;border:1px solid rgba(239,68,68,0.3);">\${escapeHtml(state.error)}</div>\`
      : '';

    const needsAnonKey = !state.supabaseAnonKey;
    const needsUrl = !state.supabaseUrl;

    return \`
      <div class="auth-wrapper">
        <div class="auth-card">
          <div class="auth-header">
            <h2>CrashLab</h2>
            <p>Sign in to your private beta workspace</p>
          </div>
          <div class="auth-notice-box">
            <strong>Supabase Authentication</strong><br>
            Access is restricted to authorized private beta pilot operators. Enter your credentials to access your testing workspace.
          </div>
          \${errorHtml}
          <form id="auth-form" autocomplete="on" novalidate>
            <div class="form-group">
              <label class="form-label" for="input-email">Email Address</label>
              <input id="input-email" class="form-input" type="email" placeholder="pilot-operator@company.test" autocomplete="email" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-password">Password</label>
              <input id="input-password" class="form-input" type="password" placeholder="••••••••••••" autocomplete="current-password" required>
            </div>
            <button id="btn-submit-auth" type="submit" class="btn btn-primary" style="width:100%;padding:0.75rem;font-size:0.95rem;margin-top:0.5rem;" \${state.authSubmitting ? 'disabled' : ''}>
              \${state.authSubmitting ? 'Signing in...' : 'Sign In'}
            </button>

            <!-- Advanced Connection Settings Disclosure -->
            <details style="margin-top:1.5rem;font-size:0.75rem;color:var(--text-dim);">
              <summary style="cursor:pointer;user-select:none;outline:none;">Advanced connection settings</summary>
              <div style="margin-top:1rem;padding-top:0.75rem;border-top:1px solid var(--border-subtle);">
                <div class="form-group">
                  <label class="form-label" for="input-token">Direct Supabase User JWT</label>
                  <input id="input-token" class="form-input" type="password" placeholder="eyJhbGci..." autocomplete="off">
                  <div class="form-help">Enter a normal authenticated user JWT directly if needed.</div>
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
                </div>
                \` : ''}
              </div>
            </details>
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
            <h2>CrashLab</h2>
            <p>Authenticated Product Dashboard</p>
          </div>
          <div class="auth-notice-box" style="background:rgba(245,158,11,0.1);border-color:rgba(245,158,11,0.3);color:#fbbf24;">
            <strong>Local development authentication — not production login.</strong><br>
            Generate a local development bearer token in your shell using:<br>
            <code style="display:inline-block;margin-top:0.4rem;padding:0.25rem 0.5rem;background:rgba(0,0,0,0.3);border-radius:4px;">npm run auth:token -- --user usr_test_owner</code>
          </div>
          \${state.error ? \`<div style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.error)}</div>\` : ''}
          <form id="auth-form">
            <div class="form-group">
              <label class="form-label" for="input-api-url">API Server URL</label>
              <input id="input-api-url" class="form-input" type="text" value="\${escapeHtml(state.apiUrl || window.location.origin)}" placeholder="http://127.0.0.1:3220">
            </div>
            <div class="form-group">
              <label class="form-label" for="input-token">Development Bearer Token</label>
              <input id="input-token" class="form-input" type="password" placeholder="eyJhbGciOi..." autocomplete="off" required>
              <div class="form-help">Token will be kept in-memory only and cleared on logout.</div>
            </div>
            <button id="btn-submit-auth" type="submit" class="btn btn-primary" style="width:100%;padding:0.75rem;font-size:0.95rem;">
              Connect &amp; Authenticate
            </button>
          </form>
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

  function renderOverviewView() {
    const userName = state.currentUser ? (state.currentUser.name || 'Pilot Operator') : 'Pilot Operator';
    const totalProjects = state.projects.length;

    // Tally runs and possible issues across projects if loaded
    let totalRuns = 0;
    let totalIssues = 0;
    let healthyRunsCount = 0;
    let latestRun = null;

    if (state.runs && state.runs.length > 0) {
      totalRuns = state.runs.length;
      latestRun = state.runs[0];
      for (const r of state.runs) {
        const issues = r.anomalyCount ?? r.candidateCount ?? 0;
        if (issues > 0) {
          totalIssues += issues;
        } else if (r.status === 'completed') {
          healthyRunsCount++;
        }
      }
    }

    // Dynamic Recommended Next Action Card
    let actionTitle = 'Run your first approved journey';
    let actionDesc = 'Select a project to trigger safe automated journey verification.';
    let actionBtnText = 'View Projects &rarr;';
    let actionBtnLink = '#/projects';

    if (latestRun) {
      const issues = latestRun.anomalyCount ?? latestRun.candidateCount ?? 0;
      if (issues > 0) {
        actionTitle = \`Review \${issues} possible issue\${issues > 1 ? 's' : ''} from your latest run\`;
        actionDesc = 'Automated signals detected. Review evidence before deciding whether they represent application issues.';
        actionBtnText = 'Open Run Report &rarr;';
        actionBtnLink = \`#/run-detail/\${latestRun.id}\`;
      } else if (latestRun.status === 'completed') {
        actionTitle = 'No action required — latest run passed';
        actionDesc = 'All journey steps completed cleanly with zero candidate signals detected.';
        actionBtnText = 'Inspect Run &rarr;';
        actionBtnLink = \`#/run-detail/\${latestRun.id}\`;
      } else if (latestRun.status === 'running') {
        actionTitle = 'Run is currently in progress';
        actionDesc = 'Headless Chromium is executing the approved journey. Real-time evidence is accumulating.';
        actionBtnText = 'Monitor Execution &rarr;';
        actionBtnLink = \`#/run-detail/\${latestRun.id}\`;
      }
    }

    const projectCards = state.projects.map(p => \`
      <div class="project-card" style="cursor:pointer;" onclick="location.hash='#/projects/\${escapeHtml(p.id)}'">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <h3 style="font-size:1.05rem;font-weight:600;color:var(--text-main);margin-bottom:0.25rem;">\${escapeHtml(p.name)}</h3>
          <span class="badge" style="background:rgba(14,165,233,0.1);color:#38bdf8;border:1px solid rgba(14,165,233,0.3);font-size:0.7rem;">Active</span>
        </div>
        <p style="font-size:0.825rem;color:var(--text-muted);margin-bottom:0.75rem;line-height:1.4;">\${escapeHtml(p.description || 'No description provided')}</p>
        <div style="display:flex;justify-content:space-between;align-items:center;padding-top:0.65rem;border-top:1px solid var(--border-subtle);font-size:0.78rem;">
          <span style="color:var(--text-dim);">Safe-Test: <strong style="color:#10b981;">Active</strong></span>
          <a href="#/projects/\${escapeHtml(p.id)}" class="btn btn-secondary btn-sm">Open Project &rarr;</a>
        </div>
        <details class="tech-details-disclosure" style="margin-top:0.5rem;" onclick="event.stopPropagation();">
          <summary class="tech-details-summary" style="padding:0.4rem 0.6rem;font-size:0.72rem;">Technical details</summary>
          <div class="tech-details-content" style="padding:0.5rem;font-size:0.75rem;">
            <div><strong>Project ID:</strong> <code>\${escapeHtml(p.id)}</code></div>
          </div>
        </details>
      </div>
    \`).join('');

    return \`
      <div class="page-header">
        <div>
          <div style="font-size:0.75rem;font-weight:600;color:#38bdf8;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.25rem;">Workspace Overview</div>
          <h1 class="page-title panel-title">Good morning, \${escapeHtml(userName)}</h1>
          <p class="page-subtitle">Review your latest staging test results and workspace activity.</p>
        </div>
        <div>
          <a href="#/projects" class="btn btn-primary">View Projects &rarr;</a>
        </div>
      </div>

      \${renderTrustBanner()}

      <!-- Summary Cards -->
      <div class="grid-cards">
        <div class="stat-card">
          <div class="title">Active Projects</div>
          <div class="value">\${totalProjects}</div>
          <div class="subtitle">Configured pilot workspaces</div>
        </div>
        <div class="stat-card">
          <div class="title">Recent Runs</div>
          <div class="value">\${totalRuns || state.projects.length}</div>
          <div class="subtitle">Automated journey executions</div>
        </div>
        <div class="stat-card">
          <div class="title">Possible Issues</div>
          <div class="value" style="color:\${totalIssues > 0 ? '#f59e0b' : '#10b981'};">\${totalIssues}</div>
          <div class="subtitle">\${totalIssues > 0 ? 'Investigation leads for review' : 'No issues detected'}</div>
        </div>
        <div class="stat-card">
          <div class="title">Healthy Runs</div>
          <div class="value" style="color:#10b981;">\${healthyRunsCount || (totalRuns > 0 ? totalRuns - (totalIssues > 0 ? 1 : 0) : 0)}</div>
          <div class="subtitle">Passed with zero anomalies</div>
        </div>
      </div>

      <!-- Recommended Next Action Card -->
      <div class="action-card">
        <div class="action-card-body">
          <div class="action-card-icon">⚡</div>
          <div>
            <div class="action-card-title">\${actionTitle}</div>
            <div class="action-card-desc">\${actionDesc}</div>
          </div>
        </div>
        <a href="\${actionBtnLink}" class="btn btn-primary" style="white-space:nowrap;">\${actionBtnText}</a>
      </div>

      <!-- Active Projects Section -->
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Workspace Projects</h2>
            <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">Authorized projects and targets in \${escapeHtml(state.currentWorkspace?.name || 'Workspace')}</p>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(300px, 1fr));gap:1rem;">
          \${projectCards || '<div style="color:var(--text-dim);padding:2rem;text-align:center;grid-column:1/-1;">No projects found in this workspace.</div>'}
        </div>
      </div>
    \`;
  }

  function renderProjectsView() {
    const projectCards = state.projects.map(p => \`
      <div class="panel" style="margin-bottom:1rem;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:1rem;">
          <div style="max-width:650px;">
            <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.35rem;">
              <h2 style="font-size:1.15rem;font-weight:600;color:var(--text-main);margin:0;">
                <a href="#/projects/\${escapeHtml(p.id)}" style="color:inherit;text-decoration:none;">\${escapeHtml(p.name)}</a>
              </h2>
              <span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid rgba(16,185,129,0.3);font-size:0.7rem;">Safe-Test Active</span>
            </div>
            <p style="font-size:0.85rem;color:var(--text-muted);line-height:1.5;margin-bottom:0.75rem;">\${escapeHtml(p.description || 'No project description.')}</p>
            <div style="display:flex;gap:1.5rem;font-size:0.8rem;color:var(--text-dim);">
              <span>Testing Environments: <strong style="color:var(--text-main);">Staging / Local</strong></span>
              <span>Safe-Test Mode: <strong style="color:#10b981;">Enforced</strong></span>
            </div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.75rem;">
            <a href="#/projects/\${escapeHtml(p.id)}" class="btn btn-primary">Open Project &rarr;</a>
          </div>
        </div>
        <details class="tech-details-disclosure" style="margin-top:1rem;">
          <summary class="tech-details-summary">Technical details</summary>
          <div class="tech-details-content">
            <div><strong>Project ID:</strong> <code>\${escapeHtml(p.id)}</code></div>
            <div><strong>Created:</strong> <span>\${new Date(p.createdAt).toLocaleString()}</span></div>
          </div>
        </details>
      </div>
    \`).join('');

    return \`
      <div class="page-header">
        <div>
          <h1 class="page-title panel-title">Projects</h1>
          <p class="page-subtitle">Manage your authorized test projects and target staging environments.</p>
        </div>
      </div>

      \${renderTrustBanner()}

      <div>
        \${projectCards || '<div class="state-box"><h3>No projects configured</h3><p>Contact your workspace administrator to set up projects.</p></div>'}
      </div>
    \`;
  }

  function renderProjectDetailView() {
    const p = state.selectedProject;
    if (!p) {
      return '<div class="state-box"><h3>Project not found</h3><p><a href="#/projects" class="btn btn-secondary">Back to Projects</a></p></div>';
    }

    const targetCards = state.targets.map(t => \`
      <div class="target-card" style="margin-bottom:0.75rem;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;">
          <div>
            <h4 style="font-size:0.95rem;font-weight:600;color:var(--text-main);margin-bottom:0.25rem;">\${escapeHtml(t.name)}</h4>
            <div style="font-size:0.8rem;color:var(--text-muted);">
              Testing Origin: <code style="color:#38bdf8;">\${escapeHtml(t.targetOrigin || t.targetUrl)}</code>
            </div>
          </div>
          <span class="status-pill \${t.environment === 'staging' ? 'preflight' : 'created'}">\${escapeHtml(t.environment)}</span>
        </div>
        <div style="margin-top:0.75rem;padding-top:0.5rem;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;font-size:0.75rem;">
          <span style="color:#10b981;">&bull; Safe-Test Status: Active</span>
        </div>
        <details class="tech-details-disclosure" style="margin-top:0.5rem;">
          <summary class="tech-details-summary" style="padding:0.35rem 0.6rem;font-size:0.72rem;">Technical details</summary>
          <div class="tech-details-content" style="padding:0.5rem;font-size:0.75rem;">
            <div><strong>Target ID:</strong> <code>\${escapeHtml(t.id)}</code></div>
            <div><strong>Authorization Reference:</strong> <code>\${escapeHtml(t.authorizationReference || 'None')}</code></div>
          </div>
        </details>
      </div>
    \`).join('');

    const journeyCards = state.journeys.map(j => {
      const tgt = state.targets.find(t => t.id === j.targetEnvironmentId) || state.targets[0];
      const hasTestData = Boolean(tgt && tgt.testDataReference);
      const testDataLabel = (j.requiresTestData || j.requiresCredentials)
        ? (hasTestData ? '<span style="color:#38bdf8;">&bull; Protected test data configured</span>' : '<span style="color:#f59e0b;">&bull; Protected test data missing</span>')
        : '<span style="color:var(--text-dim);">&bull; No credentials required</span>';

      return \`
        <div class="journey-card">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.5rem;">
            <div>
              <span class="badge" style="background:rgba(16,185,129,0.15);color:#34d399;border:1px solid #10b981;font-size:0.7rem;margin-right:0.5rem;">Approved journey</span>
              <span style="font-size:0.75rem;color:var(--text-dim);font-family:var(--font-mono);">ID: \${escapeHtml(j.id)}</span>
            </div>
            <span class="status-pill \${tgt && tgt.environment === 'staging' ? 'preflight' : 'created'}">\${escapeHtml(tgt ? tgt.environment : 'isolated')}</span>
          </div>
          <div style="font-weight:600;font-size:1rem;margin-bottom:0.4rem;color:var(--text-main);">
            \${escapeHtml(j.goal)}
          </div>
          <div style="font-size:0.825rem;color:var(--text-muted);margin-bottom:0.5rem;">
            Target Origin: <code style="color:#38bdf8;">\${escapeHtml(j.origin)}</code>
          </div>
          <div style="font-size:0.78rem;color:var(--text-dim);margin-bottom:0.85rem;line-height:1.4;">
            <strong>Allowed Actions:</strong> \${escapeHtml(j.allowedActions.join(', '))}
          </div>
          <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border-subtle);">
            <div style="font-size:0.78rem;">
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

    const runRows = state.runs.map(r => {
      const issueCount = r.anomalyCount ?? r.candidateCount ?? 0;
      return \`
        <tr>
          <td><a href="#/run-detail/\${escapeHtml(r.id)}" style="color:var(--text-main);font-family:var(--font-mono);font-size:0.82rem;text-decoration:none;"><strong>\${escapeHtml(r.id.slice(0, 14))}...</strong></a></td>
          <td>\${renderStatusPill(r.status, issueCount)}</td>
          <td>\${issueCount > 0 ? \`<span style="color:#f59e0b;font-weight:600;">\${issueCount} possible issue\${issueCount > 1 ? 's' : ''}</span>\` : '<span style="color:#10b981;">0</span>'}</td>
          <td>\${r.attemptCount || 1} / \${r.maxAttempts || 1}</td>
          <td style="font-size:0.78rem;color:var(--text-muted);">\${new Date(r.createdAt).toLocaleString()}</td>
          <td><a href="#/run-detail/\${escapeHtml(r.id)}" class="btn btn-secondary btn-sm">Details &rarr;</a></td>
        </tr>
      \`;
    }).join('');

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
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">Register Testing Environment</div>
          <div class="modal-body">
            <div class="execution-warning-box">
              <strong>Safe-Test Notice:</strong> Only dedicated non-production environments (staging, qa, demo, local) may be registered. Production targets are strictly prohibited.
            </div>
            \${state.targetError ? \`<div style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.targetError)}</div>\` : ''}
            <div class="form-group">
              <label class="form-label" for="input-target-name">Target Name</label>
              <input id="input-target-name" class="form-input" type="text" value="External Staging Pilot" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="select-target-env">Environment</label>
              <select id="select-target-env" class="form-input">
                <option value="staging" selected>staging</option>
                <option value="qa">qa</option>
                <option value="demo">demo</option>
                <option value="local">local</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-target-url">Target URL</label>
              <input id="input-target-url" class="form-input" type="url" value="https://crashlab-api.onrender.com/staging-pilot" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-target-origins">Allowed Origins</label>
              <input id="input-target-origins" class="form-input" type="text" value="https://crashlab-api.onrender.com" required>
            </div>
            <div class="form-group">
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
      <div class="modal-overlay">
        <div class="modal-card">
          <div class="modal-header">Create Approved Journey</div>
          <div class="modal-body">
            <div class="execution-warning-box">
              <strong>Human QA Review:</strong> Approved journeys declare explicit boundaries for automated exploration. Financial and destructive actions are permanently prohibited.
            </div>
            \${state.journeyError ? \`<div style="color:var(--status-failed);background:rgba(239,68,68,0.1);padding:0.6rem;border-radius:6px;margin-bottom:1rem;font-size:0.85rem;">\${escapeHtml(state.journeyError)}</div>\` : ''}
            <div class="form-group">
              <label class="form-label" for="select-journey-target">Testing Environment</label>
              <select id="select-journey-target" class="form-input">
                \${targetOptions}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-journey-goal">Human Goal / Intent</label>
              <input id="input-journey-goal" class="form-input" type="text" value="Verify staging pilot interaction and defect detection" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="input-journey-origin">Target Origin</label>
              <input id="input-journey-origin" class="form-input" type="url" value="\${escapeHtml(state.targets[0]?.targetOrigin || 'https://crashlab-api.onrender.com')}" required>
            </div>
            <div class="form-group">
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
      <div class="breadcrumb-nav">
        <a href="#/projects">&larr; Back to Projects</a>
        <span>/</span>
        <span>\${escapeHtml(p.name)}</span>
      </div>

      <div class="page-header">
        <div>
          <h1 class="page-title">\${escapeHtml(p.name)}</h1>
          <p class="page-subtitle">\${escapeHtml(p.description || 'Target Staging Verification Project')}</p>
        </div>
        <div style="display:flex;gap:0.75rem;">
          \${state.journeys.length > 0 ? \`
            <button class="btn btn-primary btn-open-run-modal" data-journey-id="\${escapeHtml(state.journeys[0].id)}">
              Run Journey &rarr;
            </button>
          \` : ''}
        </div>
      </div>

      \${renderTrustBanner()}

      <!-- Tabs Navigation -->
      <div class="tab-nav">
        <button class="tab-btn \${state.activeProjectTab === 'summary' ? 'active' : ''}" onclick="window.__CRASHLAB_SET_PROJECT_TAB('summary')">Summary</button>
        <button class="tab-btn \${state.activeProjectTab === 'targets' ? 'active' : ''}" onclick="window.__CRASHLAB_SET_PROJECT_TAB('targets')">Targets (\${state.targets.length})</button>
        <button class="tab-btn \${state.activeProjectTab === 'journeys' ? 'active' : ''}" onclick="window.__CRASHLAB_SET_PROJECT_TAB('journeys')">Approved Journeys (\${state.journeys.length})</button>
        <button class="tab-btn \${state.activeProjectTab === 'runs' ? 'active' : ''}" onclick="window.__CRASHLAB_SET_PROJECT_TAB('runs')">Recent Test Runs (\${state.runs.length})</button>
      </div>

      <!-- Tab Contents -->
      \${state.activeProjectTab === 'summary' ? \`
        <div style="display:grid;grid-template-columns:320px 1fr;gap:1.5rem;align-items:start;">
          <div>
            <div class="panel">
              <div class="panel-header">
                <h2 class="panel-title" style="font-size:1rem;margin:0;">Configured Targets</h2>
                <button id="btn-open-target-modal" class="btn btn-secondary btn-sm">+ Register Target</button>
              </div>
              \${targetCards || '<p style="color:var(--text-dim);font-size:0.8rem;">No targets configured.</p>'}
            </div>
          </div>
          <div>
            <div class="panel">
              <div class="panel-header">
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
                      <th>Possible Issues</th>
                      <th>Attempts</th>
                      <th>Created</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    \${runRows || '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:2rem;">No runs executed for this project.</td></tr>'}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      \` : ''}

      \${state.activeProjectTab === 'targets' ? \`
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Configured Targets</h2>
            <button id="btn-open-target-modal" class="btn btn-primary btn-sm">+ Register Target</button>
          </div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:1rem;">
            \${targetCards || '<p style="color:var(--text-dim);padding:1.5rem;">No testing environments registered yet.</p>'}
          </div>
        </div>
      \` : ''}

      \${state.activeProjectTab === 'journeys' ? \`
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Approved Journeys</h2>
            <button id="btn-open-journey-modal" class="btn btn-primary btn-sm" \${state.targets.length === 0 ? 'disabled' : ''}>+ Create Journey</button>
          </div>
          <div>
            \${journeyCards || '<p style="color:var(--text-dim);padding:1.5rem;">No approved journeys configured for this project.</p>'}
          </div>
        </div>
      \` : ''}

      \${state.activeProjectTab === 'runs' ? \`
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">Recent Test Runs</h2>
          </div>
          <div class="table-responsive">
            <table class="dash-table">
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Status</th>
                  <th>Possible Issues</th>
                  <th>Attempts</th>
                  <th>Created</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${runRows || '<tr><td colspan="6" style="text-align:center;color:var(--text-dim);padding:2rem;">No runs executed for this project.</td></tr>'}
              </tbody>
            </table>
          </div>
        </div>
      \` : ''}

      \${executionModal}
      \${targetModal}
      \${journeyModal}
    \`;
  }

  function renderRunDetailView() {
    const run = state.selectedRun;
    if (!run) {
      return '<div class="state-box"><h3>Run not found</h3><p><a href="#/projects" class="btn btn-secondary">Back to Projects</a></p></div>';
    }

    const q = state.selectedQueueItem;
    const isCancellable = ['queued', 'preflight', 'running', 'cancelling'].includes(run.status);
    const workerStatus = getWorkerStatus(run, q);

    const candidateCount = state.candidates.length;
    const hasIssues = candidateCount > 0;

    // Primary Summary Copy (Item 8)
    let primarySummary = 'Journey execution request is queued waiting for an available worker.';
    if (run.status === 'completed') {
      if (hasIssues) {
        primarySummary = \`\${candidateCount} possible signal\${candidateCount > 1 ? 's' : ''} detected. Review the evidence before deciding whether they represent one issue or multiple issues.\`;
      } else {
        primarySummary = 'No possible issues detected. The approved journey completed successfully.';
      }
    } else if (run.status === 'running') {
      primarySummary = 'Journey execution is currently active in headless Chromium. Real-time evidence is accumulating.';
    } else if (run.status === 'failed') {
      primarySummary = \`Execution encountered an error: \${escapeHtml(run.failureReason || 'Worker execution failed.')}\`;
    } else if (run.status === 'blocked') {
      primarySummary = \`Preflight safety check blocked execution: \${escapeHtml(run.blockedReason || 'Preflight refusal.')}\`;
    }

    // Candidate Review Cards (Item 9)
    const candidateCards = state.candidates.map(c => {
      const cId = c.candidateId || c.id;
      const info = getCandidateFriendlyInfo(c.ruleId, c.classification);
      const isUpdating = state.candidateUpdatingId === cId;
      const feedback = state.candidateUpdateFeedback?.candidateId === cId ? state.candidateUpdateFeedback.message : null;

      const reviewOptions = [
        { value: 'unreviewed', label: 'Unreviewed' },
        { value: 'investigating', label: 'Investigating' },
        { value: 'accepted', label: 'Accepted' },
        { value: 'dismissed', label: 'Dismissed' },
        { value: 'duplicate', label: 'Duplicate' },
        { value: 'resolved', label: 'Resolved' },
      ].map(opt => \`
        <option value="\${opt.value}" \${c.reviewStatus === opt.value ? 'selected' : ''}>\${opt.label}</option>
      \`).join('');

      return \`
        <div class="candidate-card" id="candidate-card-\${escapeHtml(cId)}">
          <div class="candidate-card-header">
            <div class="candidate-title-group">
              <span class="candidate-friendly-title">\${escapeHtml(info.title)}</span>
              <span class="candidate-rule-badge">\${escapeHtml(c.ruleId || 'UNKNOWN')}</span>
              <span class="candidate-severity-badge \${info.severity}">\${info.severity} priority</span>
            </div>
            <div>
              \${renderReviewStatusPill(c.reviewStatus)}
            </div>
          </div>

          <div class="candidate-desc">
            \${escapeHtml(info.explanation)}
          </div>

          <div class="candidate-meta-bar">
            <div class="candidate-evidence-ref">
              <span style="color:\${c.reproduced ? '#f59e0b' : '#34d399'};margin-right:1rem;">
                &bull; \${c.reproduced ? 'Signal reproduces across attempts' : 'Single occurrence signal'}
              </span>
              <span style="color:var(--text-dim);font-family:var(--font-mono);font-size:0.75rem;">
                Evidence ID: \${escapeHtml(cId)}
              </span>
            </div>

            <div class="candidate-review-controls">
              \${feedback ? \`<span class="candidate-feedback-toast">✓ \${escapeHtml(feedback)}</span>\` : ''}
              <label for="review-select-\${escapeHtml(cId)}" style="font-size:0.75rem;color:var(--text-dim);font-weight:600;">REVIEW ACTION:</label>
              <select class="candidate-review-select" id="review-select-\${escapeHtml(cId)}" data-candidate-id="\${escapeHtml(cId)}" \${isUpdating ? 'disabled' : ''}>
                \${reviewOptions}
              </select>
            </div>
          </div>

          <details class="tech-details-disclosure" style="margin-top:0.75rem;">
            <summary class="tech-details-summary" style="padding:0.35rem 0.6rem;font-size:0.72rem;">Technical details</summary>
            <div class="tech-details-content" style="padding:0.5rem;font-size:0.75rem;">
              <div><strong>Candidate ID:</strong> <code>\${escapeHtml(cId)}</code></div>
              <div><strong>Rule ID:</strong> <code>\${escapeHtml(c.ruleId || 'N/A')}</code></div>
              <div><strong>Classification:</strong> <code>\${escapeHtml(c.classification || 'unknown')}</code></div>
              <div><strong>Signal Reproduces:</strong> <span>\${c.reproduced ? 'Yes' : 'No'}</span></div>
              <div><strong>Trust Invariant:</strong> <code>confirmedBug: false &bull; confirmed: false</code></div>
            </div>
          </details>
        </div>
      \`;
    }).join('');

    // Evidence Artifact Cards (Item 11)
    const artifactCards = state.artifacts.map(a => {
      const info = getArtifactFriendlyInfo(a.type);
      return \`
        <div class="artifact-card">
          <div class="artifact-card-header">
            <span class="artifact-card-title">\${escapeHtml(info.title)}</span>
            <span class="badge" style="background:var(--bg-base);color:#38bdf8;border:1px solid var(--border-subtle);font-size:0.7rem;">\${info.badge}</span>
          </div>
          <div class="artifact-card-meta">\${escapeHtml(info.desc)}</div>
          <div style="font-size:0.75rem;color:var(--text-dim);display:flex;justify-content:space-between;align-items:center;">
            <span>\${escapeHtml(a.contentType)}</span>
            <span><strong>\${Math.round(a.byteSize / 1024)} KB</strong></span>
          </div>
          <div class="artifact-card-actions">
            <button class="btn btn-secondary btn-sm btn-inspect-artifact" data-id="\${escapeHtml(a.id)}">Preview</button>
            <button class="btn btn-secondary btn-sm btn-download-artifact" data-id="\${escapeHtml(a.id)}">Download</button>
          </div>
        </div>
      \`;
    }).join('');

    return \`
      <div class="breadcrumb-nav">
        <a href="#/projects">&larr; Back to Projects</a>
        <span>/</span>
        <a href="#/projects/\${escapeHtml(run.projectId)}">Project Runs</a>
        <span>/</span>
        <span>Run Report</span>
      </div>

      <div class="page-header">
        <div>
          <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.35rem;">
            <h1 class="page-title">\${escapeHtml(run.journeyId ? 'Journey Verification Run' : 'Test Run')}</h1>
            \${renderStatusPill(run.status, candidateCount)}
          </div>
          <p class="page-subtitle">\${primarySummary}</p>
        </div>
        <div>
          \${isCancellable ? \`<button id="btn-open-cancel" class="btn btn-danger btn-sm">Cancel Run</button>\` : ''}
        </div>
      </div>

      \${renderTrustBanner()}

      <h2 class="panel-title" style="font-size:1rem;margin:1rem 0 0.5rem 0;">Run Execution Details</h2>

      <!-- Summary Cards (Item 8) -->
      <div class="grid-cards">
        <div class="stat-card">
          <div class="title">Current Lifecycle Status</div>
          <div style="margin-top:0.35rem;">\${renderStatusPill(run.status, candidateCount)}</div>
          <div class="subtitle" style="margin-top:0.35rem;">Started: \${new Date(run.startedAt || run.createdAt).toLocaleTimeString()}</div>
        </div>
        <div class="stat-card">
          <div class="title">Worker Status</div>
          <div style="font-size:1.25rem;font-weight:700;color:var(--text-main);margin-top:0.25rem;">
            \${escapeHtml(workerStatus.label)}
          </div>
          <div class="subtitle">\${escapeHtml(workerStatus.detail)}</div>
        </div>
        <div class="stat-card">
          <div class="title">Possible Issues</div>
          <div class="value" style="color:\${hasIssues ? '#f59e0b' : '#10b981'};">
            \${candidateCount}
          </div>
          <div class="subtitle">\${hasIssues ? 'Signals requiring operator review' : 'Zero defects detected'}</div>
        </div>
        <div class="stat-card">
          <div class="title">Evidence Files</div>
          <div class="value">\${state.artifacts.length}</div>
          <div class="subtitle">Verified artifacts available</div>
        </div>
      </div>

      \${run.failureReason ? \`
        <div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:8px;padding:0.85rem 1.15rem;margin-bottom:1.5rem;color:#fca5a5;font-size:0.875rem;">
          <strong>Failure Reason:</strong> \${escapeHtml(run.failureReason)}
        </div>
      \` : ''}

      \${run.blockedReason ? \`
        <div style="background:rgba(220,38,38,0.1);border:1px solid rgba(220,38,38,0.4);border-radius:8px;padding:0.85rem 1.15rem;margin-bottom:1.5rem;color:#f87171;font-size:0.875rem;">
          <strong>Preflight Blocked Reason:</strong> \${escapeHtml(run.blockedReason)}
        </div>
      \` : ''}

      <!-- Possible Issues Section (Candidate Review UI) -->
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Possible Issues (\${candidateCount})</h2>
            <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">Automated defect signals detected during execution. Operator sign-off required.</p>
          </div>
        </div>

        \${hasIssues ? \`
          <div class="candidate-signals-banner">
            <span>ℹ️</span>
            <span>These signals may represent one underlying issue. Review them together before accepting separate findings.</span>
          </div>
        \` : ''}

        <div class="invariant-card">
          <span>&bull;</span>
          <span><strong>Trust Invariant:</strong> Candidate finding — not a confirmed defect. <code>confirmedBug: false</code> &bull; <code>confirmed: false</code>. Automated findings are investigation leads, not confirmed application defects. Human acceptance is not automated confirmation.</span>
        </div>

        <div>
          \${candidateCards || '<p style="color:var(--text-dim);padding:2rem;text-align:center;">No possible issues detected. All journey assertions passed successfully.</p>'}
        </div>
      </div>

      <!-- Evidence Files Section -->
      <div class="panel">
        <div class="panel-header">
          <div>
            <h2 class="panel-title">Evidence Files (\${state.artifacts.length})</h2>
            <p style="font-size:0.8rem;color:var(--text-muted);margin-top:0.2rem;">Complete provenance reports, network logs, and traces recorded in Safe-Test storage.</p>
          </div>
        </div>
        <div class="artifacts-grid">
          \${artifactCards || '<p style="color:var(--text-dim);padding:1.5rem;text-align:center;grid-column:1/-1;">No evidence files attached to this run.</p>'}
        </div>

        \${state.selectedArtifact ? \`
          <div class="panel" id="artifact-preview-panel" style="margin-top:1.25rem;border:1px solid #0ea5e9;background:var(--bg-card);box-shadow:0 4px 16px rgba(14,165,233,0.15);">
            <div class="panel-header" style="display:flex;justify-content:space-between;align-items:center;">
              <div>
                <span class="badge" style="background:rgba(14,165,233,0.15);color:#38bdf8;border:1px solid rgba(14,165,233,0.3);font-size:0.7rem;margin-right:0.5rem;">Evidence Preview</span>
                <span style="font-weight:600;color:var(--text-main);font-size:0.95rem;">\${escapeHtml(getArtifactFriendlyInfo(state.selectedArtifact.type).title)}</span>
                <span style="font-size:0.75rem;color:var(--text-dim);font-family:var(--font-mono);margin-left:0.5rem;">(\${escapeHtml(state.selectedArtifact.id.slice(0, 12))})</span>
              </div>
              <button id="btn-close-preview" class="btn btn-secondary btn-sm" title="Close (Escape)">&times; Close</button>
            </div>
            <div style="padding:1rem;">
              \${state.selectedArtifactLoading ? '<div style="padding:2rem;text-align:center;color:var(--text-dim);">Loading artifact content...</div>' : ''}
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
              <div style="display:flex;justify-content:flex-end;gap:0.75rem;margin-top:0.75rem;padding-top:0.75rem;border-top:1px solid var(--border-subtle);">
                <button class="btn btn-secondary btn-sm" onclick="state.selectedArtifact=null;renderApp();">Close</button>
                <button class="btn btn-primary btn-sm btn-download-artifact" data-id="\${escapeHtml(state.selectedArtifact.id)}">Download File</button>
              </div>
            </div>
          </div>
        \` : ''}
      </div>

      <!-- Technical Details Section -->
      <details class="tech-details-disclosure">
        <summary class="tech-details-summary">Technical details</summary>
        <div class="tech-details-content">
          <div class="tech-details-item"><strong>Run ID:</strong> <code>\${escapeHtml(run.id)}</code></div>
          <div class="tech-details-item"><strong>Request ID:</strong> <span class="request-id-badge">\${escapeHtml(run.requestId || state.lastRequestId || 'req_none')}</span></div>
          <div class="tech-details-item"><strong>Project ID:</strong> <code>\${escapeHtml(run.projectId)}</code></div>
          <div class="tech-details-item"><strong>Testing Environment:</strong> <code>\${escapeHtml(run.targetEnvironmentId)}</code></div>
          <div class="tech-details-item"><strong>Approved Journey:</strong> <code>\${escapeHtml(run.journeyId)}</code></div>
          <div class="tech-details-item"><strong>Safety Check:</strong> <span style="color:#10b981;">\${run.safeTestMode ? 'Safe-Test Enforced (Safe)' : 'Safe-Test Inactive'}</span></div>
          <div class="tech-details-item"><strong>Artifact Count:</strong> \${state.artifacts.length}</div>
          <div class="tech-details-item"><strong>Candidate Count:</strong> \${state.candidates.length}</div>
          <div class="tech-details-item"><strong>Anomaly Count:</strong> \${run.anomalyCount ?? state.candidates.length}</div>
          <div class="tech-details-item"><strong>Worker Lease:</strong> <span>\${escapeHtml(workerStatus.detail)}</span></div>
          <div class="tech-details-item"><strong>Created At:</strong> \${new Date(run.createdAt).toLocaleString()}</div>
          <div class="tech-details-item"><strong>Updated At:</strong> \${new Date(run.updatedAt).toLocaleString()}</div>
          <div class="tech-details-item"><strong>Failure / Blocked Reason:</strong> \${escapeHtml(run.failureReason || run.blockedReason || 'None')}</div>
        </div>
      </details>

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
      <div class="page-header">
        <div>
          <h1 class="page-title panel-title">Security &amp; Trust Model</h1>
          <p class="page-subtitle">Learn about CrashLab's core safety invariants and verification guarantees.</p>
        </div>
      </div>

      \${renderTrustBanner()}

      <div class="panel">
        <h2 class="panel-title" style="font-size:1.1rem;margin-bottom:0.75rem;">1. Mandatory Preflight Safety Gate</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;line-height:1.6;">
          Every asynchronous run must pass strict preflight validation before any browser process is launched.
          Runs targeting production environments or origins not listed in <code>allowedOrigins</code> are rejected with status <code>blocked</code>, launching zero browsers and issuing zero target network requests.
        </p>
      </div>

      <div class="panel">
        <h2 class="panel-title" style="font-size:1.1rem;margin-bottom:0.75rem;">2. Defect Confirmation Invariant</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;line-height:1.6;">
          <code>confirmedBug: false</code> &bull; <code>confirmed: false</code> is non-negotiable. Candidate finding — not a confirmed defect. Human acceptance is not automated confirmation. CrashLab classifies unexpected responses and errors as candidate defects with complete execution provenance for human review. Automated systems cannot declare application bugs without authorized engineer confirmation.
        </p>
      </div>

      <div class="panel">
        <h2 class="panel-title" style="font-size:1.1rem;margin-bottom:0.75rem;">3. Safe-Test Mode &amp; Action Boundaries</h2>
        <p style="color:var(--text-muted);font-size:0.875rem;line-height:1.6;">
          Safe-test mode is permanently active across all workers. Destructive actions (checkout, financial transfers, subscription mutations, password modifications, account deletions) are blocked before action dispatch.
        </p>
      </div>
    \`;
  }

  function renderHelpView() {
    return \`
      <div class="page-header">
        <div>
          <h1 class="page-title panel-title">Help &amp; Pilot Operator Guide</h1>
          <p class="page-subtitle">Everything you need to know about managing automated staging test runs.</p>
        </div>
      </div>

      <div class="panel">
        <h2 class="panel-title" style="font-size:1.1rem;margin-bottom:0.75rem;">Candidate Review Statuses</h2>
        <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:1rem;margin-top:1rem;">
          <div style="background:var(--bg-surface-elevated);padding:1rem;border-radius:8px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
              <span class="review-status-pill unreviewed">Unreviewed</span>
            </div>
            <p style="font-size:0.825rem;color:var(--text-muted);">Default status for newly detected signals awaiting operator evaluation.</p>
          </div>
          <div style="background:var(--bg-surface-elevated);padding:1rem;border-radius:8px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
              <span class="review-status-pill investigating">Investigating</span>
            </div>
            <p style="font-size:0.825rem;color:var(--text-muted);">Signal is actively being analyzed against logs and staging fixtures.</p>
          </div>
          <div style="background:var(--bg-surface-elevated);padding:1rem;border-radius:8px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
              <span class="review-status-pill accepted">Accepted</span>
            </div>
            <p style="font-size:0.825rem;color:var(--text-muted);">Operator confirmed the signal represents an issue to be addressed.</p>
          </div>
          <div style="background:var(--bg-surface-elevated);padding:1rem;border-radius:8px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
              <span class="review-status-pill dismissed">Dismissed</span>
            </div>
            <p style="font-size:0.825rem;color:var(--text-muted);">Signal is expected behavior or known non-issue in the staging environment.</p>
          </div>
          <div style="background:var(--bg-surface-elevated);padding:1rem;border-radius:8px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
              <span class="review-status-pill duplicate">Duplicate</span>
            </div>
            <p style="font-size:0.825rem;color:var(--text-muted);">Signal is redundant with another candidate finding in the same run.</p>
          </div>
          <div style="background:var(--bg-surface-elevated);padding:1rem;border-radius:8px;border:1px solid var(--border-subtle);">
            <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.35rem;">
              <span class="review-status-pill resolved">Resolved</span>
            </div>
            <p style="font-size:0.825rem;color:var(--text-muted);">Underlying issue was fixed and verified in subsequent test executions.</p>
          </div>
        </div>
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
      mainContent = '<div class="state-box"><h3>Loading CrashLab Dashboard...</h3><p style="color:var(--text-dim);font-size:0.85rem;">Retrieving workspace context securely.</p></div>';
    } else if (state.error) {
      mainContent = \`<div class="state-box error"><h3>Unable to Load View</h3><p>\${escapeHtml(state.error)}</p><p style="margin-top:1rem;"><a href="#/overview" class="btn btn-secondary btn-sm">Back to Overview</a></p></div>\`;
    } else {
      switch (state.route) {
        case 'overview':
          mainContent = renderOverviewView();
          break;
        case 'projects':
          const { id } = parseHash();
          mainContent = id ? renderProjectDetailView() : renderProjectsView();
          break;
        case 'run-detail':
          mainContent = renderRunDetailView();
          break;
        case 'security':
          mainContent = renderSecurityView();
          break;
        case 'help':
          mainContent = renderHelpView();
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

  // Expose tab switcher helper on window
  window.__CRASHLAB_SET_PROJECT_TAB = function(tabName) {
    state.activeProjectTab = tabName;
    renderApp();
  };

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

    // Candidate Review dropdown listeners
    document.querySelectorAll('.candidate-review-select').forEach(select => {
      select.addEventListener('change', (e) => {
        const candidateId = e.target.getAttribute('data-candidate-id');
        const newStatus = e.target.value;
        if (candidateId && newStatus) {
          submitCandidateReview(candidateId, newStatus);
        }
      });
    });

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

  // --- Keyboard & Overlay Event Listeners ---
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.selectedArtifact) {
        state.selectedArtifact = null;
        state.selectedArtifactContent = null;
        renderApp();
      } else if (state.cancelModalOpen) {
        state.cancelModalOpen = false;
        renderApp();
      } else if (state.executionModalOpen) {
        state.executionModalOpen = false;
        renderApp();
      } else if (state.targetModalOpen) {
        state.targetModalOpen = false;
        renderApp();
      } else if (state.journeyModalOpen) {
        state.journeyModalOpen = false;
        renderApp();
      }
    }
  });

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
