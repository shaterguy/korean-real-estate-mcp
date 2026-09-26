# korean-real-estate-mcp

Read-only Korean real-estate MCP candidate. It separates three kinds of values:

1. MOLIT RTMS reported transaction prices (`actual_transaction`).
2. Naver current registered-listing asking prices (`asking_listing` / aggregate summary).
3. MCP-computed comparisons and statistics (`computed`).

No user API key, login cookie, account token, or personal credential is required. Naver individual listing detail can be rate-limited; current aggregate inventory counts and asking ranges use the public mobile complex-list surface and remain separately represented.
