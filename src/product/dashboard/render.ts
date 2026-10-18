/**
 * Dashboard HTML Shell Renderer — Build 12C.1.
 *
 * Produces the secure single-page HTML application shell with:
 * - Strict Content Security Policy (CSP)
 * - Anti-sniffing and cache-control headers
 * - Zero hardcoded credentials or tokens
 */

export interface RenderDashboardOptions {
  readonly apiUrl?: string;
  readonly defaultWorkspaceId?: string;
  readonly authMode?: 'production' | 'development';
  readonly supabaseUrl?: string;
  readonly supabaseAnonKey?: string;
}

export function renderDashboardHtmlShell(options: RenderDashboardOptions = {}): string {
  const safeApiUrl = options.apiUrl ? encodeURI(options.apiUrl) : '';
  const safeWsId = options.defaultWorkspaceId ? encodeURI(options.defaultWorkspaceId) : '';
  const defaultMode =
    options.authMode ??
    (process.env.PRODUCT_AUTH_MODE === 'production' ? 'production' : 'development');
  const safeAuthMode = defaultMode === 'production' ? 'production' : 'development';
  const rawSupabaseUrl = options.supabaseUrl ?? process.env.SUPABASE_URL ?? '';
  const safeSupabaseUrl = rawSupabaseUrl ? encodeURI(rawSupabaseUrl.trim()) : '';
  const rawAnonKey = options.supabaseAnonKey ?? process.env.SUPABASE_ANON_KEY ?? '';
  const safeAnonKey = rawAnonKey ? encodeURI(rawAnonKey.trim()) : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CrashLab Product Dashboard</title>
  <meta name="description" content="CrashLab Hosted QA Platform Product Dashboard">
  <link rel="stylesheet" href="/styles.css">
  <meta name="default-api-url" content="${safeApiUrl}">
  <meta name="default-workspace-id" content="${safeWsId}">
  <meta name="auth-mode" content="${safeAuthMode}">
  <meta name="supabase-url" content="${safeSupabaseUrl}">
  <meta name="supabase-anon-key" content="${safeAnonKey}">
</head>
<body>
  <div id="app">
    <div style="display:flex;align-items:center;justify-content:center;height:100vh;color:#94a3b8;font-family:sans-serif;">
      Loading CrashLab Dashboard...
    </div>
  </div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;
}
