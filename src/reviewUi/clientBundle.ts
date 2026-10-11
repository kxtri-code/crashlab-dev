/**
 * Browser Client Application Bundle (Build 9.2).
 *
 * Self-contained ES module executed in the browser.
 * Handles client-side routing, API fetching, template rendering, and user interactions.
 */

export const CLIENT_JS_BUNDLE = `
/**
 * CrashLab Review UI Client Script.
 * Read-Only Browser Interface for candidate inspection.
 */

// Helper functions for escaping
function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\\r/g, '&#13;')
    .replace(/\\n/g, '&#10;');
}

function safeId(value) {
  if (!value) return 'none';
  return String(value).toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
}

function formatTimestamp(isoString) {
  if (!isoString) return 'Never / Not recorded';
  try {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return escapeHtml(isoString);
    return d.toISOString().replace('T', ' ').replace(/\\.\\d{3}Z$/, ' UTC');
  } catch (e) {
    return escapeHtml(isoString);
  }
}

// Read-Only API client
class ReviewApiClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\\/+$/, '') : '';
  }

  async request(endpoint, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      throw new Error('CrashLab Review UI is strictly read-only. Mutation method "' + method + '" is prohibited.');
    }

    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : '/' + endpoint;
    const url = new URL(this.baseUrl ? (this.baseUrl + cleanEndpoint) : cleanEndpoint, window.location.origin);

    if (options.query) {
      for (const [key, val] of Object.entries(options.query)) {
        if (val !== undefined && val !== null && val !== '') {
          url.searchParams.set(key, String(val));
        }
      }
    }

    const res = await fetch(url.toString(), {
      method,
      headers: { Accept: 'application/json' }
    });

    if (!res.ok) {
      let code = 'http-error';
      let message = 'Request failed with status ' + res.status;
      try {
        const body = await res.json();
        if (body.error) {
          code = body.error.code || code;
          message = body.error.message || message;
        }
      } catch (_) {}
      const err = new Error(message);
      err.code = code;
      err.status = res.status;
      throw err;
    }

    if (method === 'HEAD') return {};
    return await res.json();
  }

  getHealth() { return this.request('/health'); }
  getSummary() { return this.request('/api/summary'); }
  getCandidates(filters = {}) { return this.request('/api/candidates', { query: filters }); }
  getCandidateDetail(id) { return this.request('/api/candidates/' + encodeURIComponent(id)); }
  getCandidateHistory(id) { return this.request('/api/candidates/' + encodeURIComponent(id) + '/history'); }
  getBaselines(filters = {}) { return this.request('/api/baselines', { query: filters }); }
  getBaselineDetail(id) { return this.request('/api/baselines/' + encodeURIComponent(id)); }
  getCurrentRun() { return this.request('/api/runs/current'); }
  getReproductionRun() { return this.request('/api/runs/reproduction'); }
}

// Renderers
function renderNavbar(activeRoute, health, apiUrl) {
  const isHealthy = health && health.ok === true;
  const statusColor = isHealthy ? 'var(--status-healthy)' : 'var(--status-unhealthy)';
  const statusText = isHealthy ? 'API Online' : 'API Connecting...';

  return '<header class="ui-navbar">' +
    '<div class="navbar-brand">' +
      '<a href="#/" class="brand-link">' +
        '<span class="brand-name">CrashLab</span>' +
        '<span class="brand-sub">Review UI</span>' +
      '</a>' +
      '<span class="badge badge-readonly" id="readonly-indicator">READ-ONLY</span>' +
    '</div>' +
    '<nav class="navbar-links" aria-label="Main Navigation">' +
      '<a href="#/" class="nav-item ' + (activeRoute === 'overview' ? 'active' : '') + '">Overview</a>' +
      '<a href="#/candidates" class="nav-item ' + (activeRoute === 'candidates' ? 'active' : '') + '">Candidates</a>' +
      '<a href="#/baselines" class="nav-item ' + (activeRoute === 'baselines' ? 'active' : '') + '">Baselines</a>' +
      '<a href="#/runs" class="nav-item ' + (activeRoute === 'runs' ? 'active' : '') + '">Runs</a>' +
    '</nav>' +
    '<div class="navbar-status" title="Backing Review API at ' + escapeAttr(apiUrl) + '">' +
      '<span class="status-dot" style="background-color: ' + statusColor + ';"></span>' +
      '<span class="status-label">' + escapeHtml(statusText) + '</span>' +
    '</div>' +
  '</header>';
}

function renderTopBanners() {
  return '<div class="banner-container">' +
    '<div class="banner banner-readonly">' +
      '<span class="banner-icon">ℹ</span>' +
      '<div class="banner-content">' +
        '<strong>Read-Only Review Mode:</strong> ' +
        'This interface does not mutate files or call write endpoints. All candidate findings are review leads requiring human evaluation. To record review decisions, use <code>npm run review-state</code>.' +
      '</div>' +
    '</div>' +
    '<div class="banner banner-invariant">' +
      '<span class="banner-icon">🛡</span>' +
      '<div class="banner-content">' +
        '<strong>Trust Invariant:</strong> ' +
        '<code>confirmedBug: false</code> &amp; <code>confirmed: false</code> across all candidate reports. Candidates are not automatically confirmed bugs.' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderClassificationBadge(classification) {
  const norm = safeId(classification);
  return '<span class="badge badge-classification badge-' + norm + '">' + escapeHtml(classification) + '</span>';
}

function renderReviewStatusBadge(status) {
  const norm = safeId(status);
  const isUnreviewed = status === 'unreviewed';
  const label = isUnreviewed ? '⚠ Unreviewed' : status;
  return '<span class="badge badge-status badge-status-' + norm + '">' + escapeHtml(label) + '</span>';
}

function renderReproductionBadge(reproduced, classification) {
  if (reproduced) {
    const text = classification ? 'Reproduced (' + classification + ')' : 'Reproduced';
    return '<span class="badge badge-reproduced-yes">' + escapeHtml(text) + '</span>';
  }
  return '<span class="badge badge-reproduced-no">Unreproduced</span>';
}

function renderOverview(summary) {
  const total = summary.totalCandidates || 0;
  const unreviewed = (summary.byReviewStatus && summary.byReviewStatus['unreviewed']) || 0;
  const novel = (summary.byClassification && summary.byClassification['novel']) || 0;
  const reintroduced = (summary.byClassification && summary.byClassification['reintroduced']) || 0;
  const persistent = (summary.byClassification && summary.byClassification['persistent']) || 0;
  const resolved = (summary.byClassification && summary.byClassification['resolved']) || 0;
  const changed = (summary.byClassification && summary.byClassification['changed']) || 0;
  const reproduced = summary.reproducedCount || 0;

  let limsHtml = '';
  if (summary.baseline && summary.baseline.limitations && summary.baseline.limitations.length > 0) {
    limsHtml = '<div class="panel-card panel-limitations">' +
      '<h3>Deterministic Limitations &amp; Caveats</h3>' +
      '<ul>' +
        summary.baseline.limitations.map(lim => '<li>' + escapeHtml(lim) + '</li>').join('') +
      '</ul>' +
    '</div>';
  }

  return '<div class="view-content view-overview">' +
    '<div class="view-header">' +
      '<h2>Candidate Review Overview</h2>' +
      '<p class="view-description">Deterministic assessment of current run against baseline.</p>' +
    '</div>' +

    '<div class="metrics-grid">' +
      '<div class="metric-card metric-total">' +
        '<div class="metric-title">Total Candidates</div>' +
        '<div class="metric-value" id="metric-total-candidates">' + total + '</div>' +
        '<div class="metric-foot">Candidate defect leads</div>' +
      '</div>' +
      '<div class="metric-card metric-unreviewed ' + (unreviewed > 0 ? 'highlight-unreviewed' : '') + '">' +
        '<div class="metric-title">Unreviewed</div>' +
        '<div class="metric-value" id="metric-unreviewed-candidates">' + unreviewed + '</div>' +
        '<div class="metric-foot">Awaiting human review</div>' +
      '</div>' +
      '<div class="metric-card metric-novel">' +
        '<div class="metric-title">Novel Findings</div>' +
        '<div class="metric-value" id="metric-novel-candidates">' + novel + '</div>' +
        '<div class="metric-foot">New signals absent in baseline</div>' +
      '</div>' +
      '<div class="metric-card metric-reintroduced">' +
        '<div class="metric-title">Reintroduced</div>' +
        '<div class="metric-value" id="metric-reintroduced-candidates">' + reintroduced + '</div>' +
        '<div class="metric-foot">Signals recurring from ancestors</div>' +
      '</div>' +
      '<div class="metric-card metric-reproduced">' +
        '<div class="metric-title">Reproduced</div>' +
        '<div class="metric-value" id="metric-reproduced-candidates">' + reproduced + '</div>' +
        '<div class="metric-foot">Confirmed recurring in rerun</div>' +
      '</div>' +
      '<div class="metric-card metric-persistent">' +
        '<div class="metric-title">Persistent / Changed</div>' +
        '<div class="metric-value">' + (persistent + changed) + '</div>' +
        '<div class="metric-foot">' + persistent + ' persistent, ' + changed + ' changed</div>' +
      '</div>' +
    '</div>' +

    '<div class="cards-grid">' +
      '<div class="panel-card">' +
        '<h3>Review State Distribution</h3>' +
        '<table class="data-table">' +
          '<thead><tr><th>Status</th><th>Count</th><th>Action</th></tr></thead>' +
          '<tbody>' +
            '<tr><td>' + renderReviewStatusBadge('unreviewed') + '</td><td><strong>' + unreviewed + '</strong></td><td><a href="#/candidates?reviewStatus=unreviewed">Inspect &rarr;</a></td></tr>' +
            '<tr><td>' + renderReviewStatusBadge('open') + '</td><td>' + ((summary.byReviewStatus && summary.byReviewStatus['open']) || 0) + '</td><td><a href="#/candidates?reviewStatus=open">Inspect &rarr;</a></td></tr>' +
            '<tr><td>' + renderReviewStatusBadge('investigating') + '</td><td>' + ((summary.byReviewStatus && summary.byReviewStatus['investigating']) || 0) + '</td><td><a href="#/candidates?reviewStatus=investigating">Inspect &rarr;</a></td></tr>' +
            '<tr><td>' + renderReviewStatusBadge('accepted') + '</td><td>' + ((summary.byReviewStatus && summary.byReviewStatus['accepted']) || 0) + '</td><td><a href="#/candidates?reviewStatus=accepted">Inspect &rarr;</a></td></tr>' +
            '<tr><td>' + renderReviewStatusBadge('dismissed') + '</td><td>' + ((summary.byReviewStatus && summary.byReviewStatus['dismissed']) || 0) + '</td><td><a href="#/candidates?reviewStatus=dismissed">Inspect &rarr;</a></td></tr>' +
            '<tr><td>' + renderReviewStatusBadge('duplicate') + '</td><td>' + ((summary.byReviewStatus && summary.byReviewStatus['duplicate']) || 0) + '</td><td><a href="#/candidates?reviewStatus=duplicate">Inspect &rarr;</a></td></tr>' +
            '<tr><td>' + renderReviewStatusBadge('resolved') + '</td><td>' + ((summary.byReviewStatus && summary.byReviewStatus['resolved']) || 0) + '</td><td><a href="#/candidates?reviewStatus=resolved">Inspect &rarr;</a></td></tr>' +
          '</tbody>' +
        '</table>' +
      '</div>' +

      '<div class="panel-card">' +
        '<h3>Baseline &amp; Provenance Context</h3>' +
        '<dl class="meta-list">' +
          '<dt>Selected Baseline</dt><dd><code>' + escapeHtml((summary.baseline && summary.baseline.selectedBaselineId) || 'None (no baseline selected)') + '</code></dd>' +
          '<dt>Selection Mode</dt><dd><code>' + escapeHtml((summary.baseline && summary.baseline.selectionMode) || 'none') + '</code></dd>' +
          '<dt>Comparison Classification</dt><dd>' + escapeHtml((summary.baseline && summary.baseline.comparisonClassification) || 'unknown') + '</dd>' +
          '<dt>Target Origin</dt><dd><code>' + escapeHtml((summary.provenance && summary.provenance.targetOrigin) || 'Not recorded') + '</code></dd>' +
          '<dt>Journey Hash</dt><dd><code>' + escapeHtml((summary.provenance && summary.provenance.journeyHash) || 'Not recorded') + '</code></dd>' +
          '<dt>Environment Fingerprint</dt><dd><code>' + escapeHtml((summary.provenance && summary.provenance.environmentFingerprint) || 'Not recorded') + '</code></dd>' +
        '</dl>' +
      '</div>' +
    '</div>' +

    limsHtml +

    '<div class="actions-bar">' +
      '<a href="#/candidates" class="btn btn-primary" id="btn-view-candidates">View All Candidates &rarr;</a>' +
    '</div>' +
  '</div>';
}

function renderCandidateList(data, filters = {}) {
  const candidates = data.candidates || [];
  const currentClassification = filters.classification || '';
  const currentStatus = filters.reviewStatus || '';
  const currentKind = filters.kind || '';

  let listContent = '';
  if (candidates.length === 0) {
    listContent = '<div class="empty-state" id="empty-candidates-notice">' +
      '<h3>No candidates match the selected filters</h3>' +
      '<p>Try resetting filters or adjusting query criteria.</p>' +
    '</div>';
  } else {
    listContent = '<div class="table-wrapper">' +
      '<table class="data-table candidate-table" id="candidates-table">' +
        '<thead><tr>' +
          '<th>Candidate ID</th>' +
          '<th>Rule &amp; Kind</th>' +
          '<th>Classification</th>' +
          '<th>Review Status</th>' +
          '<th>Reproduction</th>' +
          '<th>Signal Message</th>' +
          '<th>Action</th>' +
        '</tr></thead>' +
        '<tbody>' +
          candidates.map(c =>
            '<tr class="candidate-row" data-candidate-id="' + escapeAttr(c.candidateId) + '">' +
              '<td>' +
                '<a href="#/candidates/' + encodeURIComponent(c.candidateId) + '" class="candidate-id-link">' +
                  '<code>' + escapeHtml(c.candidateId) + '</code>' +
                '</a>' +
                '<div class="candidate-alias">alias: <code>' + escapeHtml(c.id) + '</code></div>' +
              '</td>' +
              '<td><strong>' + escapeHtml(c.ruleId) + '</strong><div class="text-muted">' + escapeHtml(c.kind) + '</div></td>' +
              '<td>' + renderClassificationBadge(c.classification) + '</td>' +
              '<td>' + renderReviewStatusBadge(c.reviewStatus) + '</td>' +
              '<td>' + renderReproductionBadge(c.reproduced, c.reproductionClassification) + '</td>' +
              '<td class="signal-message-cell">' + escapeHtml(c.message) + '</td>' +
              '<td>' +
                '<a href="#/candidates/' + encodeURIComponent(c.candidateId) + '" class="btn btn-sm btn-inspect" data-candidate-id="' + escapeAttr(c.candidateId) + '">' +
                  'Inspect &rarr;' +
                '</a>' +
              '</td>' +
            '</tr>'
          ).join('') +
        '</tbody>' +
      '</table>' +
    '</div>';
  }

  return '<div class="view-content view-candidates">' +
    '<div class="view-header">' +
      '<h2>Candidate Findings</h2>' +
      '<p class="view-description">Review candidate defect leads produced by deterministic comparison.</p>' +
    '</div>' +

    '<div class="filter-bar" id="candidate-filters">' +
      '<div class="filter-group">' +
        '<label for="filter-classification">Classification:</label>' +
        '<select id="filter-classification" class="filter-select">' +
          '<option value="" ' + (currentClassification === '' ? 'selected' : '') + '>All Classifications</option>' +
          '<option value="novel" ' + (currentClassification === 'novel' ? 'selected' : '') + '>Novel</option>' +
          '<option value="reintroduced" ' + (currentClassification === 'reintroduced' ? 'selected' : '') + '>Reintroduced</option>' +
          '<option value="persistent" ' + (currentClassification === 'persistent' ? 'selected' : '') + '>Persistent</option>' +
          '<option value="resolved" ' + (currentClassification === 'resolved' ? 'selected' : '') + '>Resolved</option>' +
          '<option value="changed" ' + (currentClassification === 'changed' ? 'selected' : '') + '>Changed</option>' +
          '<option value="unknown" ' + (currentClassification === 'unknown' ? 'selected' : '') + '>Unknown</option>' +
        '</select>' +
      '</div>' +

      '<div class="filter-group">' +
        '<label for="filter-status">Review Status:</label>' +
        '<select id="filter-status" class="filter-select">' +
          '<option value="" ' + (currentStatus === '' ? 'selected' : '') + '>All Statuses</option>' +
          '<option value="unreviewed" ' + (currentStatus === 'unreviewed' ? 'selected' : '') + '>Unreviewed</option>' +
          '<option value="open" ' + (currentStatus === 'open' ? 'selected' : '') + '>Open</option>' +
          '<option value="investigating" ' + (currentStatus === 'investigating' ? 'selected' : '') + '>Investigating</option>' +
          '<option value="accepted" ' + (currentStatus === 'accepted' ? 'selected' : '') + '>Accepted</option>' +
          '<option value="dismissed" ' + (currentStatus === 'dismissed' ? 'selected' : '') + '>Dismissed</option>' +
          '<option value="duplicate" ' + (currentStatus === 'duplicate' ? 'selected' : '') + '>Duplicate</option>' +
          '<option value="resolved" ' + (currentStatus === 'resolved' ? 'selected' : '') + '>Resolved</option>' +
        '</select>' +
      '</div>' +

      '<div class="filter-group">' +
        '<label for="filter-kind">Kind:</label>' +
        '<select id="filter-kind" class="filter-select">' +
          '<option value="" ' + (currentKind === '' ? 'selected' : '') + '>All Kinds</option>' +
          '<option value="http" ' + (currentKind === 'http' ? 'selected' : '') + '>HTTP</option>' +
          '<option value="console" ' + (currentKind === 'console' ? 'selected' : '') + '>Console</option>' +
          '<option value="page-error" ' + (currentKind === 'page-error' ? 'selected' : '') + '>Page Error</option>' +
          '<option value="expectation" ' + (currentKind === 'expectation' ? 'selected' : '') + '>Expectation</option>' +
        '</select>' +
      '</div>' +

      '<div class="filter-group filter-actions">' +
        '<button id="btn-reset-filters" class="btn btn-secondary">Reset Filters</button>' +
      '</div>' +
    '</div>' +

    '<div class="filter-summary">' +
      '<span id="candidate-count-summary">Showing <strong>' + (data.returnedCount || 0) + '</strong> of <strong>' + (data.totalCount || 0) + '</strong> candidates</span>' +
    '</div>' +

    listContent +
  '</div>';
}

function renderCandidateDetail(c) {
  const h = c.humanReviewState || {};
  const evidence = c.evidence || { currentAnomalyIds: [], reproductionResultIds: [] };
  const provenance = c.provenance || {};

  return '<div class="view-content view-candidate-detail">' +
    '<div class="breadcrumb">' +
      '<a href="#/candidates">&larr; Back to Candidates</a>' +
    '</div>' +

    '<div class="detail-header">' +
      '<div class="detail-title-group">' +
        '<h2>Candidate: <code>' + escapeHtml(c.candidateId) + '</code></h2>' +
        '<div class="alias-tag">Alias: <code>' + escapeHtml(c.id) + '</code></div>' +
      '</div>' +
      '<div class="detail-badges">' +
        renderClassificationBadge(c.classification) +
        renderReviewStatusBadge(c.reviewStatus) +
        renderReproductionBadge(c.reproduced, c.reproductionClassification) +
      '</div>' +
    '</div>' +

    '<!-- The 4-Way Visual Separation -->' +
    '<div class="separation-grid">' +

      '<!-- Panel 1: Automatic Calculated Result -->' +
      '<div class="separation-card card-calculated" id="panel-calculated-result">' +
        '<div class="card-header">' +
          '<span class="card-tag">1</span>' +
          '<h3>Automatic Calculated Result</h3>' +
        '</div>' +
        '<div class="card-body">' +
          '<dl class="meta-list">' +
            '<dt>Rule ID</dt><dd><code>' + escapeHtml(c.ruleId) + '</code></dd>' +
            '<dt>Signal Kind</dt><dd><code>' + escapeHtml(c.kind) + '</code></dd>' +
            '<dt>Automatic Classification</dt><dd>' + renderClassificationBadge(c.classification) + '</dd>' +
            '<dt>Reproduction Status</dt><dd>' + renderReproductionBadge(c.reproduced, c.reproductionClassification) + '</dd>' +
            '<dt>Step Order</dt><dd>' + (c.stepOrder !== null && c.stepOrder !== undefined ? 'Step ' + c.stepOrder : 'Global / Unassigned') + '</dd>' +
            '<dt>Requires Investigation</dt><dd>' + (c.requiresInvestigation ? 'Yes' : 'No') + '</dd>' +
            '<dt>Signal Key Hash</dt><dd><code>' + escapeHtml(evidence.relatedBaselineSignalKey || 'Derived from current run') + '</code></dd>' +
          '</dl>' +
        '</div>' +
      '</div>' +

      '<!-- Panel 2: Human Review State -->' +
      '<div class="separation-card card-review-state" id="panel-human-review-state">' +
        '<div class="card-header">' +
          '<span class="card-tag">2</span>' +
          '<h3>Human Review State</h3>' +
        '</div>' +
        '<div class="card-body">' +
          '<dl class="meta-list">' +
            '<dt>Current Review Status</dt><dd>' + renderReviewStatusBadge(h.currentStatus || 'unreviewed') + '</dd>' +
            '<dt>Reviewer</dt><dd>' + (h.reviewer ? escapeHtml(h.reviewer) : '<em>None (unassigned)</em>') + '</dd>' +
            '<dt>Revision</dt><dd>#' + (h.revision || 0) + '</dd>' +
            '<dt>First Seen</dt><dd>' + formatTimestamp(h.firstSeenAt) + '</dd>' +
            '<dt>Last Updated</dt><dd>' + formatTimestamp(h.lastUpdatedAt) + '</dd>' +
            '<dt>Duplicate Of</dt><dd>' + (h.duplicateOf ? '<code>' + escapeHtml(h.duplicateOf) + '</code>' : '<em>Not duplicate</em>') + '</dd>' +
            '<dt>Latest Note</dt><dd class="note-box">' + (h.latestNote ? escapeHtml(h.latestNote) : '<em>No review notes recorded.</em>') + '</dd>' +
          '</dl>' +
          '<div class="history-link-container">' +
            '<a href="#/candidates/' + encodeURIComponent(c.candidateId) + '/history" class="btn btn-secondary btn-sm" id="btn-view-history">' +
              'View History Timeline (' + (h.eventCount || 0) + ' events) &rarr;' +
            '</a>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<!-- Panel 3: Supporting Evidence & Provenance -->' +
      '<div class="separation-card card-evidence" id="panel-supporting-evidence">' +
        '<div class="card-header">' +
          '<span class="card-tag">3</span>' +
          '<h3>Supporting Evidence &amp; Provenance</h3>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="evidence-block">' +
            '<strong>Observed Signal Message:</strong>' +
            '<pre class="code-preview message-preview">' + escapeHtml(c.message) + '</pre>' +
          '</div>' +
          '<dl class="meta-list">' +
            '<dt>Current Anomaly IDs</dt><dd>' + (evidence.currentAnomalyIds && evidence.currentAnomalyIds.length > 0 ? evidence.currentAnomalyIds.map(id => '<code>' + escapeHtml(id) + '</code>').join(', ') : 'None') + '</dd>' +
            '<dt>Reproduction Result IDs</dt><dd>' + (evidence.reproductionResultIds && evidence.reproductionResultIds.length > 0 ? evidence.reproductionResultIds.map(id => '<code>' + escapeHtml(id) + '</code>').join(', ') : 'None') + '</dd>' +
            '<dt>Target Origin</dt><dd><code>' + escapeHtml(provenance.targetOrigin || 'Not recorded') + '</code></dd>' +
            '<dt>Journey Hash</dt><dd><code>' + escapeHtml(provenance.journeyHash || 'Not recorded') + '</code></dd>' +
            '<dt>Application Build ID</dt><dd><code>' + escapeHtml(provenance.applicationBuildId || 'Not recorded') + '</code></dd>' +
          '</dl>' +
        '</div>' +
      '</div>' +

      '<!-- Panel 4: Limitations & Invariants -->' +
      '<div class="separation-card card-limitations" id="panel-limitations-invariants">' +
        '<div class="card-header">' +
          '<span class="card-tag">4</span>' +
          '<h3>Limitations &amp; Invariants</h3>' +
        '</div>' +
        '<div class="card-body">' +
          '<div class="invariant-box">' +
            '<strong>Trust Invariant:</strong>' +
            '<div class="invariant-check"><code>confirmedBug: false</code></div>' +
            '<div class="invariant-check"><code>confirmed: false</code></div>' +
            '<p>Candidate findings are deterministic signals for human triage, never automatically verified defects.</p>' +
          '</div>' +
          (c.knownLimitations && c.knownLimitations.length > 0
            ? '<div class="limitations-list"><strong>Known Limitations:</strong><ul>' + c.knownLimitations.map(lim => '<li>' + escapeHtml(lim) + '</li>').join('') + '</ul></div>'
            : '<p class="text-muted">No specific comparison limitations declared for this candidate.</p>'
          ) +
        '</div>' +
      '</div>' +

    '</div>' +

    '<!-- CLI Review Command Generator -->' +
    '<div class="cli-command-card" id="cli-command-section">' +
      '<div class="cli-card-header">' +
        '<h3>Record Review Decision via CLI</h3>' +
        '<p class="text-muted">Review state writes are append-only via the CLI to maintain a reproducible audit trail.</p>' +
      '</div>' +

      '<div class="cli-builder-form">' +
        '<div class="form-row">' +
          '<div class="form-group">' +
            '<label for="cli-status-select">Transition Status:</label>' +
            '<select id="cli-status-select" class="form-control" data-candidate-id="' + escapeAttr(c.candidateId) + '">' +
              '<option value="open">open (Awaiting triage)</option>' +
              '<option value="investigating">investigating (Active triage)</option>' +
              '<option value="accepted">accepted (Valid issue / known)</option>' +
              '<option value="dismissed">dismissed (Not an issue)</option>' +
              '<option value="duplicate">duplicate (Redundant finding)</option>' +
              '<option value="resolved">resolved (Addressed / Expected)</option>' +
            '</select>' +
          '</div>' +

          '<div class="form-group">' +
            '<label for="cli-reviewer-input">Reviewer Name:</label>' +
            '<input type="text" id="cli-reviewer-input" class="form-control" value="operator" placeholder="e.g. qa-lead" />' +
          '</div>' +
        '</div>' +

        '<div class="form-group">' +
          '<label for="cli-notes-input">Review Notes:</label>' +
          '<input type="text" id="cli-notes-input" class="form-control" placeholder="Explain the triage decision..." value="Reviewed in Build 9.2 UI" />' +
        '</div>' +

        '<div class="cli-code-container">' +
          '<pre class="cli-snippet"><code id="cli-command-preview">npm run review-state -- --candidate ' + escapeHtml(c.candidateId) + ' --status open --reviewer "operator" --notes "Reviewed in Build 9.2 UI"</code></pre>' +
          '<button id="btn-copy-cli" class="btn btn-primary" data-candidate-id="' + escapeAttr(c.candidateId) + '">' +
            'Copy CLI Command' +
          '</button>' +
        '</div>' +
        '<div id="copy-confirmation" class="copy-confirmation hidden" role="status" aria-live="polite">' +
          '✓ Copied to clipboard! Run this in your terminal.' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderCandidateHistory(h) {
  const events = h.events || [];
  let timelineContent = '';

  if (h.unreviewed || events.length === 0) {
    timelineContent = '<div class="empty-state" id="empty-history-notice">' +
      '<h3>Unreviewed Candidate</h3>' +
      '<p>No human review decisions have been recorded yet for this candidate.</p>' +
      '<p class="text-muted">Use <code>npm run review-state</code> to record the first decision.</p>' +
    '</div>';
  } else {
    timelineContent = '<div class="timeline" id="history-timeline">' +
      events.map((evt, idx) =>
        '<div class="timeline-node" id="history-event-' + escapeAttr(evt.eventId) + '">' +
          '<div class="timeline-marker">' + (idx + 1) + '</div>' +
          '<div class="timeline-card">' +
            '<div class="timeline-card-header">' +
              '<div>' +
                '<strong>' + (evt.previousStatus ? escapeHtml(evt.previousStatus) : 'unreviewed') + ' &rarr; ' + escapeHtml(evt.newStatus) + '</strong> ' +
                '<span class="badge badge-sm badge-outline">Rev #' + evt.revision + '</span>' +
              '</div>' +
              '<div class="timeline-time">' + formatTimestamp(evt.timestamp) + '</div>' +
            '</div>' +
            '<dl class="meta-list timeline-meta">' +
              '<dt>Event ID</dt><dd><code>' + escapeHtml(evt.eventId) + '</code></dd>' +
              '<dt>Reviewer</dt><dd>' + (evt.reviewer ? escapeHtml(evt.reviewer) : '<em>None</em>') + '</dd>' +
              (evt.note ? '<dt>Note</dt><dd class="note-box">' + escapeHtml(evt.note) + '</dd>' : '') +
              (evt.reason ? '<dt>Reason</dt><dd>' + escapeHtml(evt.reason) + '</dd>' : '') +
              (evt.duplicateOf ? '<dt>Duplicate Of</dt><dd><code>' + escapeHtml(evt.duplicateOf) + '</code></dd>' : '') +
              '<dt>Trust Invariant</dt><dd><code>confirmed: false</code></dd>' +
            '</dl>' +
          '</div>' +
        '</div>'
      ).join('') +
    '</div>';
  }

  return '<div class="view-content view-candidate-history">' +
    '<div class="breadcrumb">' +
      '<a href="#/candidates/' + encodeURIComponent(h.candidateId) + '">&larr; Back to Candidate Detail</a>' +
    '</div>' +
    '<div class="detail-header">' +
      '<div>' +
        '<h2>Review History: <code>' + escapeHtml(h.candidateId) + '</code></h2>' +
        '<p class="view-description">Append-only audit trail from <code>events.jsonl</code>.</p>' +
      '</div>' +
      '<div>' + renderReviewStatusBadge(h.currentStatus || 'unreviewed') + '</div>' +
    '</div>' +
    timelineContent +
  '</div>';
}

function renderBaselineList(data) {
  const baselines = data.baselines || [];
  return '<div class="view-content view-baselines">' +
    '<div class="view-header">' +
      '<h2>Baseline Registry</h2>' +
      '<p class="view-description">Deterministic known-good baselines recorded in the repository.</p>' +
    '</div>' +
    '<div class="filter-summary"><span>Total Baselines: <strong>' + (data.totalCount || 0) + '</strong></span></div>' +
    '<div class="table-wrapper">' +
      '<table class="data-table" id="baselines-table">' +
        '<thead><tr>' +
          '<th>Baseline ID</th><th>Name</th><th>Status</th><th>Verification</th><th>Lineage Depth</th><th>Created At</th><th>Action</th>' +
        '</tr></thead>' +
        '<tbody>' +
          baselines.map(b =>
            '<tr>' +
              '<td><code>' + escapeHtml(b.baselineId) + '</code></td>' +
              '<td>' + escapeHtml(b.name) + '</td>' +
              '<td><span class="badge badge-status-' + safeId(b.status) + '">' + escapeHtml(b.status) + '</span></td>' +
              '<td><code>' + escapeHtml(b.verificationCoverage) + '</code></td>' +
              '<td>' + b.lineageDepth + '</td>' +
              '<td>' + formatTimestamp(b.createdAt) + '</td>' +
              '<td><a href="#/baselines/' + encodeURIComponent(b.baselineId) + '" class="btn btn-sm btn-inspect">View Detail &rarr;</a></td>' +
            '</tr>'
          ).join('') +
        '</tbody>' +
      '</table>' +
    '</div>' +
  '</div>';
}

function renderBaselineDetail(b) {
  const lineage = b.lineage || { ancestors: [] };
  const verification = b.verification || {};

  return '<div class="view-content view-baseline-detail">' +
    '<div class="breadcrumb"><a href="#/baselines">&larr; Back to Baselines</a></div>' +
    '<div class="detail-header">' +
      '<div><h2>Baseline: <code>' + escapeHtml(b.baselineId) + '</code></h2><div class="text-muted">' + escapeHtml(b.name) + '</div></div>' +
      '<div><span class="badge badge-status-' + safeId(b.status) + '">' + escapeHtml(b.status) + '</span></div>' +
    '</div>' +
    '<div class="cards-grid">' +
      '<div class="panel-card">' +
        '<h3>Baseline Attributes</h3>' +
        '<dl class="meta-list">' +
          '<dt>Target Origin</dt><dd><code>' + escapeHtml(b.targetOrigin || 'Not recorded') + '</code></dd>' +
          '<dt>Journey Hash</dt><dd><code>' + escapeHtml(b.journeyHash) + '</code></dd>' +
          '<dt>Verification Coverage</dt><dd><code>' + escapeHtml(verification.coverage) + '</code> (complete: ' + (verification.complete ? 'true' : 'false') + ')</dd>' +
          '<dt>Application Build ID</dt><dd><code>' + escapeHtml(b.applicationBuildId || 'Not recorded') + '</code></dd>' +
          '<dt>Created At</dt><dd>' + formatTimestamp(b.createdAt) + '</dd>' +
        '</dl>' +
      '</div>' +
      '<div class="panel-card">' +
        '<h3>Lineage &amp; Heritage</h3>' +
        '<dl class="meta-list">' +
          '<dt>Parent Baseline ID</dt><dd>' + (lineage.parentBaselineId ? '<code>' + escapeHtml(lineage.parentBaselineId) + '</code>' : '<em>Root baseline</em>') + '</dd>' +
          '<dt>Root Baseline ID</dt><dd><code>' + escapeHtml(lineage.rootBaselineId) + '</code></dd>' +
          '<dt>Lineage Depth</dt><dd>' + lineage.depth + '</dd>' +
          '<dt>Ancestor Chain</dt><dd>' + (lineage.ancestors && lineage.ancestors.length > 0 ? lineage.ancestors.map(a => '<code>' + escapeHtml(a) + '</code>').join(' &rarr; ') : 'None') + '</dd>' +
        '</dl>' +
      '</div>' +
    '</div>' +
    '<div class="panel-card"><h3>Rationale</h3><p>' + escapeHtml(b.rationale) + '</p></div>' +
  '</div>';
}

function renderRuns(current, repro) {
  const hasRepro = repro && repro.status;
  return '<div class="view-content view-runs">' +
    '<div class="view-header">' +
      '<h2>Execution Run Context</h2>' +
      '<p class="view-description">Provenance and telemetry from the current execution and reproduction attempts.</p>' +
    '</div>' +
    '<div class="cards-grid">' +
      '<div class="panel-card" id="panel-current-run">' +
        '<h3>Current Execution Run</h3>' +
        (current ?
          '<dl class="meta-list">' +
            '<dt>Run Status</dt><dd><span class="badge badge-status-open">' + escapeHtml(current.status) + '</span></dd>' +
            '<dt>Total Steps</dt><dd>' + current.stepCounts.total + ' (' + current.stepCounts.passed + ' passed, ' + current.stepCounts.failed + ' failed, ' + current.stepCounts.blocked + ' blocked)</dd>' +
            '<dt>Verification Coverage</dt><dd><code>' + escapeHtml((current.verification && current.verification.coverage) || 'none') + '</code></dd>' +
            '<dt>Anomaly Count</dt><dd>' + current.anomalyCount + '</dd>' +
            '<dt>Target Origin</dt><dd><code>' + escapeHtml((current.provenance && current.provenance.targetOrigin) || 'Not recorded') + '</code></dd>' +
            '<dt>Journey Hash</dt><dd><code>' + escapeHtml((current.provenance && current.provenance.journeyHash) || 'Not recorded') + '</code></dd>' +
            '<dt>Application Build ID</dt><dd><code>' + escapeHtml((current.provenance && current.provenance.applicationBuildId) || 'Not recorded') + '</code></dd>' +
          '</dl>' :
          '<p class="text-muted">No current run context available.</p>'
        ) +
      '</div>' +
      '<div class="panel-card" id="panel-repro-run">' +
        '<h3>Reproduction Run Context</h3>' +
        (hasRepro ?
          '<dl class="meta-list">' +
            '<dt>Reproduction Status</dt><dd><span class="badge badge-reproduced-yes">' + escapeHtml(repro.status) + '</span></dd>' +
            '<dt>Total Steps</dt><dd>' + repro.stepCounts.total + ' (' + repro.stepCounts.passed + ' passed, ' + repro.stepCounts.failed + ' failed)</dd>' +
            '<dt>Reproduced Signals</dt><dd>' + ((repro.reproductionSummary && repro.reproductionSummary.reproduced) || 0) + ' reproduced, ' + ((repro.reproductionSummary && repro.reproductionSummary.notReproduced) || 0) + ' not reproduced</dd>' +
          '</dl>' :
          '<p class="text-muted">No reproduction report was supplied or reproduction was not executed.</p>'
        ) +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderError(code, message) {
  return '<div class="view-content view-error">' +
    '<div class="panel-card panel-error" id="error-container">' +
      '<h3>Error: ' + escapeHtml(code) + '</h3>' +
      '<p>' + escapeHtml(message) + '</p>' +
      '<div class="actions-bar"><a href="#/" class="btn btn-primary">&larr; Return to Overview</a></div>' +
    '</div>' +
  '</div>';
}

// Router & Controller
class ReviewUiApp {
  constructor() {
    const rawApiUrl = document.body.getAttribute('data-api-url') || '';
    this.displayApiUrl = rawApiUrl || window.location.origin;
    // When served by UI server, API requests route relatively through /api/ to avoid cross-origin CORS blocks
    this.apiUrl = '';
    this.client = new ReviewApiClient(this.apiUrl);
    this.appEl = document.getElementById('app');
    this.health = null;
  }

  async init() {
    window.addEventListener('hashchange', () => this.handleRoute());
    await this.fetchHealth();
    await this.handleRoute();
  }

  async fetchHealth() {
    try {
      this.health = await this.client.getHealth();
    } catch (_) {
      this.health = { ok: false };
    }
  }

  parseHash() {
    const raw = window.location.hash.slice(1) || '/';
    const [pathPart, queryPart] = raw.split('?');
    const path = pathPart || '/';
    const query = {};
    if (queryPart) {
      const searchParams = new URLSearchParams(queryPart);
      for (const [k, v] of searchParams.entries()) {
        query[k] = v;
      }
    }
    return { path, query };
  }

  async handleRoute() {
    const { path, query } = this.parseHash();
    let activeNav = 'overview';
    let contentHtml = '';

    try {
      // 1. Overview
      if (path === '/' || path === '/overview') {
        activeNav = 'overview';
        const summary = await this.client.getSummary();
        contentHtml = renderOverview(summary);
      }
      // 2. Candidates list
      else if (path === '/candidates') {
        activeNav = 'candidates';
        const data = await this.client.getCandidates(query);
        contentHtml = renderCandidateList(data, query);
      }
      // 3. Candidate detail or history
      else if (path.startsWith('/candidates/')) {
        activeNav = 'candidates';
        const rest = path.slice('/candidates/'.length);
        const parts = rest.split('/');
        const candidateId = decodeURIComponent(parts[0]);

        if (parts.length === 2 && parts[1] === 'history') {
          const history = await this.client.getCandidateHistory(candidateId);
          contentHtml = renderCandidateHistory(history);
        } else if (parts.length === 1) {
          const detail = await this.client.getCandidateDetail(candidateId);
          contentHtml = renderCandidateDetail(detail);
        } else {
          contentHtml = renderError('not-found', 'Route not found: ' + path);
        }
      }
      // 4. Baselines list
      else if (path === '/baselines') {
        activeNav = 'baselines';
        const data = await this.client.getBaselines(query);
        contentHtml = renderBaselineList(data);
      }
      // 5. Baseline detail
      else if (path.startsWith('/baselines/')) {
        activeNav = 'baselines';
        const baselineId = decodeURIComponent(path.slice('/baselines/'.length));
        const detail = await this.client.getBaselineDetail(baselineId);
        contentHtml = renderBaselineDetail(detail);
      }
      // 6. Runs
      else if (path === '/runs') {
        activeNav = 'runs';
        const [current, repro] = await Promise.all([
          this.client.getCurrentRun().catch(() => null),
          this.client.getReproductionRun().catch(() => null)
        ]);
        contentHtml = renderRuns(current, repro);
      }
      // 7. 404
      else {
        contentHtml = renderError('not-found', 'Route not found: ' + path);
      }
    } catch (err) {
      contentHtml = renderError(err.code || 'error', err.message || String(err));
    }

    const fullHtml = renderNavbar(activeNav, this.health, this.displayApiUrl || this.apiUrl) +
      renderTopBanners() +
      contentHtml;

    this.appEl.innerHTML = fullHtml;
    this.attachEventListeners(activeNav, path, query);
  }

  attachEventListeners(activeNav, path, query) {
    // Candidates filters
    if (activeNav === 'candidates' && path === '/candidates') {
      const classSelect = document.getElementById('filter-classification');
      const statusSelect = document.getElementById('filter-status');
      const kindSelect = document.getElementById('filter-kind');
      const resetBtn = document.getElementById('btn-reset-filters');

      const updateFilters = () => {
        const newParams = new URLSearchParams();
        if (classSelect && classSelect.value) newParams.set('classification', classSelect.value);
        if (statusSelect && statusSelect.value) newParams.set('reviewStatus', statusSelect.value);
        if (kindSelect && kindSelect.value) newParams.set('kind', kindSelect.value);
        const qStr = newParams.toString();
        window.location.hash = '#/candidates' + (qStr ? '?' + qStr : '');
      };

      if (classSelect) classSelect.addEventListener('change', updateFilters);
      if (statusSelect) statusSelect.addEventListener('change', updateFilters);
      if (kindSelect) kindSelect.addEventListener('change', updateFilters);
      if (resetBtn) {
        resetBtn.addEventListener('click', () => {
          window.location.hash = '#/candidates';
        });
      }
    }

    // Candidate detail CLI snippet updater & copy
    if (path.startsWith('/candidates/') && !path.endsWith('/history')) {
      const statusSelect = document.getElementById('cli-status-select');
      const reviewerInput = document.getElementById('cli-reviewer-input');
      const notesInput = document.getElementById('cli-notes-input');
      const snippetCode = document.getElementById('cli-command-preview');
      const copyBtn = document.getElementById('btn-copy-cli');
      const confirmBox = document.getElementById('copy-confirmation');

      const candidateId = statusSelect ? statusSelect.getAttribute('data-candidate-id') : '';

      const updateSnippet = () => {
        if (!snippetCode || !statusSelect || !reviewerInput || !notesInput) return;
        const status = statusSelect.value || 'open';
        const reviewer = (reviewerInput.value || 'operator').replace(/"/g, '\\\\\\"');
        const notes = (notesInput.value || '').replace(/"/g, '\\\\\\"');
        const cmd = 'npm run review-state -- --candidate ' + candidateId + ' --status ' + status + ' --reviewer "' + reviewer + '" --notes "' + notes + '"';
        snippetCode.textContent = cmd;
      };

      if (statusSelect) statusSelect.addEventListener('change', updateSnippet);
      if (reviewerInput) reviewerInput.addEventListener('input', updateSnippet);
      if (notesInput) notesInput.addEventListener('input', updateSnippet);

      if (copyBtn && snippetCode) {
        copyBtn.addEventListener('click', async () => {
          const text = snippetCode.textContent || '';
          let copied = false;
          if (navigator.clipboard && navigator.clipboard.writeText) {
            try {
              await navigator.clipboard.writeText(text);
              copied = true;
            } catch (_) {}
          }
          if (!copied) {
            try {
              const ta = document.createElement('textarea');
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              copied = true;
            } catch (_) {}
          }
          if (confirmBox) {
            confirmBox.classList.remove('hidden');
            setTimeout(() => {
              confirmBox.classList.add('hidden');
            }, 3000);
          }
        });
      }
    }
  }
}

// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  const app = new ReviewUiApp();
  app.init().catch(err => {
    console.error('Review UI failed to initialize:', err);
  });
});
`;
