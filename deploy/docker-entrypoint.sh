#!/bin/sh
set -eu

cat >/srv/config.js <<EOF
window.__JUNIMO_WEB_CONFIG__ = $(jq -n \
  --arg appName "${WEBUI_TITLE:-JunimoServer Control}" \
  --arg documentationUrl "${JUNIMO_DOCUMENTATION_URL:-https://stardew-valley-dedicated-server.github.io/server/features/rest-api.html}" \
  --arg defaultApiBaseUrl "${JUNIMO_DEFAULT_API_BASE_URL:-}" \
  --arg defaultMapApiBaseUrl "${JUNIMO_DEFAULT_MAP_API_BASE_URL:-}" \
  '{
    appName: $appName,
    documentationUrl: $documentationUrl,
    defaultApiBaseUrl: $defaultApiBaseUrl,
    defaultMapApiBaseUrl: $defaultMapApiBaseUrl,
    connectionMode: "direct"
  }');
EOF

exec "$@"
