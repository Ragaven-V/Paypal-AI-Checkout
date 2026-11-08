// Thin JSON fetch helpers. They resolve to { ok, status, data } and never throw on HTTP errors.

async function parse(res) {
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

export async function getJSON(url) {
  return parse(await fetch(url));
}

export async function postJSON(url, body) {
  return parse(await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }));
}
