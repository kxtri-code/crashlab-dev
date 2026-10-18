/**
 * Controlled External Staging Pilot Fixture — Build 12H.
 *
 * Dedicated staging fixture safe for automated testing.
 * Contains ZERO customer data and communicates with ZERO external or production services.
 */

export const STAGING_PILOT_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CrashLab Controlled Staging Pilot Fixture</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      padding: 2.5rem 1rem;
      margin: 0;
      display: flex;
      justify-content: center;
    }
    .card {
      background: #1e293b;
      border-radius: 12px;
      padding: 2rem;
      max-width: 580px;
      width: 100%;
      border: 1px solid #334155;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .badge {
      display: inline-block;
      padding: 0.3rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid #10b981;
      margin-bottom: 1rem;
    }
    h1 {
      font-size: 1.5rem;
      margin: 0 0 0.5rem 0;
      color: #f8fafc;
    }
    p {
      color: #94a3b8;
      font-size: 0.925rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    .btn {
      background: #3b82f6;
      color: #ffffff;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.95rem;
      font-weight: 600;
      transition: background 0.15s ease;
    }
    .btn:hover {
      background: #2563eb;
    }
    .btn:active {
      transform: translateY(1px);
    }
    #status-output {
      margin-top: 1.5rem;
      padding: 0.85rem;
      background: #0f172a;
      border-radius: 6px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.85rem;
      border: 1px solid #334155;
      color: #38bdf8;
      min-height: 1.25rem;
    }
    .meta-box {
      margin-top: 1.5rem;
      padding: 0.75rem;
      border-radius: 6px;
      background: rgba(51, 65, 85, 0.3);
      font-size: 0.75rem;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Safe Staging Fixture &bull; Zero Customer Data</span>
    <h1>CrashLab Controlled Staging Pilot</h1>
    <p>
      Dedicated staging fixture for automated Playwright execution.
      Safe-test mode enforced. Non-destructive and isolated.
    </p>
    <div>
      <button id="btn-interact" class="btn" type="button">Trigger Staging Interaction</button>
    </div>
    <div id="status-output">Awaiting interaction...</div>
    <div class="meta-box">
      Environment: <code>staging</code> &bull; Owner Authorization: <code>AUTH-STAGING-PILOT-12H</code>
    </div>
  </div>
  <script>
    document.getElementById('btn-interact').addEventListener('click', function() {
      var out = document.getElementById('status-output');
      out.textContent = 'Interaction executed. Sending controlled defect probe...';
      console.log('Staging interaction triggered by test runner');
      try {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', '/staging-pilot/defect-probe', false);
        xhr.send();
        out.textContent = 'Controlled probe status: ' + xhr.status + ' ' + xhr.statusText;
        if (xhr.status >= 500) {
          console.error('Controlled Staging Defect: probe returned HTTP ' + xhr.status);
        }
      } catch (err) {
        out.textContent = 'Probe error: ' + (err.message || String(err));
        console.error('Controlled Staging Defect error: ' + (err.message || String(err)));
      }
    });
  </script>
</body>
</html>`;
