#!/usr/bin/env python3
"""Export construction-physics.com archive to Markdown via chrome-dev-mcp-server."""
from __future__ import annotations

import json
import re
import time
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

BASE = "http://127.0.0.1:9223"
OUT = Path(__file__).resolve().parent.parent / "exports" / "construction-physics-archive"
STATE = OUT / "state.json"


def api(path: str, body: dict) -> dict:
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.loads(r.read().decode())


def eval_fn(code: str):
    r = api("/api/evaluate_script", {"function": code})
    text = ""
    for item in r.get("content", []):
        if item.get("type") == "text":
            text += item.get("text", "")
    m = re.search(r"```json\n(.*?)\n```", text, re.DOTALL)
    if not m:
        raise RuntimeError(f"No json in response: {text[:500]}")
    return json.loads(m.group(1))


def md_filename(url: str, idx: int) -> str:
    slug = urlparse(url).path.rstrip("/").split("/")[-1] or f"post_{idx}"
    slug = re.sub(r"[^a-zA-Z0-9._-]+", "_", slug)[:100]
    return f"{idx:03d}_{slug}.md"


def main():
    OUT.mkdir(parents=True, exist_ok=True)

    print("Navigating to archive...")
    api("/api/navigate_page", {"type": "url", "url": "https://www.construction-physics.com/archive"})
    time.sleep(4)

    print("Scrolling until link count stable...")
    prev = -1
    stable = 0
    for i in range(80):
        api(
            "/api/evaluate_script",
            {
                "function": "() => { window.scrollTo(0, document.body.scrollHeight); return document.body.scrollHeight; }"
            },
        )
        time.sleep(1.4)
        cnt = eval_fn(
            """() => {
  const hrefs = new Set();
  document.querySelectorAll('a[href*="/p/"]').forEach(a => {
    try {
      const u = new URL(a.href);
      if (u.hostname.includes("construction-physics")) hrefs.add(u.origin + u.pathname.split("?")[0]);
    } catch (e) {}
  });
  return hrefs.size;
}"""
        )
        print(f"  iter {i+1} unique /p/ links: {cnt}")
        if cnt == prev:
            stable += 1
        else:
            stable = 0
        prev = cnt
        if stable >= 4:
            print(f"Stable at {cnt} links.")
            break

    hrefs = eval_fn(
        """() => {
  const hrefs = new Set();
  document.querySelectorAll('a[href*="/p/"]').forEach(a => {
    try {
      const u = new URL(a.href);
      if (u.hostname.includes("construction-physics")) hrefs.add(u.origin + u.pathname.split("?")[0]);
    } catch (e) {}
  });
  return [...hrefs].sort();
}"""
    )
    print(f"Collected {len(hrefs)} article URLs.")

    start = 0
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text())
            start = int(st.get("last_completed_index", -1)) + 1
            print(f"Resuming from index {start}")
        except Exception:
            pass

    for idx in range(start, len(hrefs)):
        url = hrefs[idx]

        print(f"[{idx+1}/{len(hrefs)}] {url}")
        api("/api/navigate_page", {"type": "url", "url": url})
        time.sleep(2.5)

        data = eval_fn(
            r"""() => {
  const main = document.querySelector("article") || document.querySelector("main") || document.body;
  const h1 = document.querySelector("h1");
  let title = h1 && h1.innerText ? h1.innerText.trim() : "";
  if (!title) title = document.title.replace(/\s*\|\s*Construction Physics.*$/i, "").trim();
  const raw = main && main.innerText ? main.innerText.trim() : "";
  const canonical = document.querySelector('link[rel="canonical"]');
  return { title, raw, url: canonical ? canonical.href : location.href };
}"""
        )
        title = data.get("title") or f"post_{idx}"
        raw = data.get("raw") or ""
        src_url = data.get("url") or url

        fname = md_filename(url, idx)
        final_path = OUT / fname
        if final_path.exists():
            print(f"  skip (file exists): {final_path.name}")
            STATE.write_text(
                json.dumps(
                    {
                        "last_completed_index": idx,
                        "total": len(hrefs),
                        "status": "running",
                        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    },
                    indent=2
                ),
                encoding="utf-8",
            )
            continue
        body = f"# {title}\n\nSource: {src_url}\n\n---\n\n{raw}\n"
        final_path.write_text(body, encoding="utf-8")
        STATE.write_text(
            json.dumps(
                {
                    "last_completed_index": idx,
                    "total": len(hrefs),
                    "status": "running",
                    "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                },
                indent=2
            ),
            encoding="utf-8",
        )

    STATE.write_text(
        json.dumps(
            {
                "last_completed_index": len(hrefs) - 1,
                "total": len(hrefs),
                "status": "done",
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2
        ),
        encoding="utf-8",
    )
    print(f"Done. Files in {OUT}")


if __name__ == "__main__":
    main()
