from pathlib import Path

p = Path(__file__).resolve().parents[1] / "frontend" / "src" / "main.js"
t = p.read_text(encoding="utf-8")

t = t.replace("headers: { 'X-User-Id': this.userId }", "headers: authHeaders()")
t = t.replace("headers: { 'X-User-Id': this.identityId }", "headers: authHeaders()")
t = t.replace(
    """            headers: {
              'Content-Type': 'application/json',
              'X-User-Id': this.userId
            },""",
    """            headers: authHeaders({ 'Content-Type': 'application/json' }),""",
)
t = t.replace(
    """            headers: {
              'Content-Type': 'application/json',
              'X-User-Id': this.identityId
            },""",
    """            headers: authHeaders({ 'Content-Type': 'application/json' }),""",
)
t = t.replace(
    """              headers: {
                'Content-Type': 'application/json',
                'X-User-Id': this.userId
              },""",
    """              headers: authHeaders({ 'Content-Type': 'application/json' }),""",
)

t = t.replace("fetch(`${API_URL}/api/", "apiFetch(`/api/")
t = t.replace("apiFetch(`/api/auth/accounts", "fetch(`${API_URL}/api/auth/accounts")
t = t.replace("apiFetch(`/api/auth/login", "fetch(`${API_URL}/api/auth/login")

t = t.replace(
    "`${url}?userId=${encodeURIComponent(this.userId)}`",
    "`${url}?access_token=${encodeURIComponent(getAccessToken())}`",
)
t = t.replace(
    "`${API_URL}/api/calls/${this.callId}/${action}?userId=${encodeURIComponent(this.userId)}`",
    "`${API_URL}/api/calls/${this.callId}/${action}?access_token=${encodeURIComponent(getAccessToken())}`",
)

p.write_text(t, encoding="utf-8")
print("X-User-Id left:", t.count("X-User-Id"))
print("apiFetch:", t.count("apiFetch"))
