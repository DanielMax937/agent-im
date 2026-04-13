#!/usr/bin/env python3
"""
Export Weibo mobile profile (m.weibo.cn) feed to Markdown via chrome-dev-mcp-server.

Uses REST API at CDS_BASE_URL (default http://127.0.0.1:9223). Each post opens via a tap on
`.weibo-text` (navigates to https://m.weibo.cn/detail/<id>) and becomes one .md file. Images
are downloaded into `images/` next to the markdown (no hotlinked sinaimg URLs in the output).

Prerequisites: chrome-dev-mcp-server running (e.g. local-service start chrome-dev-mcp-server).

If the profile URL redirects to login, open https://m.weibo.cn/u/<uid> without extra query
params (visitor flow) or log in once in that Chrome profile.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse, urlunparse

ROOT_DIR = Path(__file__).resolve().parent.parent


def _merge_api_text(resp: dict) -> str:
    parts: list[str] = []
    for item in resp.get("content", []):
        if item.get("type") == "text":
            parts.append(item.get("text", ""))
    return "".join(parts)


def api(base: str, path: str, body: dict, timeout: float = 120.0) -> dict:
    req = urllib.request.Request(
        f"{base.rstrip('/')}{path}",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode())


def eval_json(base: str, function_body: str, timeout: float = 120.0):
    r = api(base, "/api/evaluate_script", {"function": function_body}, timeout=timeout)
    text = _merge_api_text(r)
    m = re.search(r"```json\n(.*?)\n```", text, re.DOTALL)
    if not m:
        raise RuntimeError(f"No JSON in evaluate_script response: {text[:800]}")
    return json.loads(m.group(1))


def normalize_profile_url(url: str) -> str:
    """Keep scheme, host, path, and query (mobile weibo uses query for launch context)."""
    p = urlparse(url.strip())
    if not p.scheme:
        p = urlparse("https://" + url.strip())
    return urlunparse((p.scheme, p.netloc, p.path, "", p.query, ""))


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _request_headers() -> dict[str, str]:
    return {
        "User-Agent": (
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
            "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
        ),
        "Referer": "https://m.weibo.cn/",
    }


def download_image_to_file(url: str, dest_stem: Path) -> Path:
    """Write image bytes to dest_stem + extension from Content-Type; return final path."""
    req = urllib.request.Request(url, headers=_request_headers(), method="GET")
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
        ct = (r.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    ext = mimetypes.guess_extension(ct or "") or ".jpg"
    if ext in (".jpe", ".jpeg"):
        ext = ".jpg"
    dest = dest_stem.with_suffix(ext)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


def images_to_local_markdown(
    text: str,
    img_urls: list[str],
    images_dir: Path,
    detail_id: str,
) -> tuple[str, list[str]]:
    """Append local image markdown lines; return (body, errors)."""
    errs: list[str] = []
    blocks: list[str] = [text.rstrip()]
    for j, u in enumerate(img_urls):
        if not u or u.startswith("data:"):
            continue
        stem = images_dir / f"{detail_id}_{j:02d}"
        try:
            saved = download_image_to_file(u, stem)
            rel_with_ext = Path("images") / saved.name
            blocks.append(f"\n\n![]({rel_with_ext.as_posix()})\n")
        except (urllib.error.URLError, OSError, ValueError) as e:
            errs.append(f"{u}: {e}")
            blocks.append(f"\n\n<!-- image download failed: {u} -->\n")
    return "\n".join(blocks), errs


CLICK_EXPAND_FEED_JS = r"""() => {
  let n = 0;
  document.querySelectorAll('.card-wrap a, .card-wrap span, .card-wrap button').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t === '展开') {
      el.click();
      n += 1;
    }
  });
  return n;
}"""

COUNT_CARDS_JS = r"""() => {
  return document.querySelectorAll('.card-wrap').length;
}"""

EXTRACT_DETAIL_JS = r"""() => {
  const expand = [...document.querySelectorAll('a, span, button, div')].find(
    (el) => (el.textContent || '').trim() === '展开'
  );
  if (expand) expand.click();
  window.scrollTo(0, document.body.scrollHeight);
  const titleEl =
    document.querySelector('.m-text-cut') ||
    document.querySelector('header h3') ||
    document.querySelector('h1');
  const title = titleEl ? titleEl.innerText.trim() : document.title;
  const time = document.querySelector('.time')?.textContent?.trim() || '';
  const from_ = document.querySelector('.from')?.textContent?.trim() || '';
  const box = document.querySelector('.weibo-text') || document.querySelector('article');
  const text = box && box.innerText ? box.innerText.trim() : '';
  const article = document.querySelector('article.weibo-main');
  const urls = [];
  if (article) {
    [...article.querySelectorAll('img')].forEach((i) => {
      const topHeader = i.closest('header.weibo-top');
      if (topHeader) return;
      if (i.closest('.url-icon')) return;
      if (i.closest('.vipicon') || i.classList.contains('vipicon')) return;
      const s = i.src || '';
      if (!s || s.includes('face.t.sinajs.cn')) return;
      if (s.includes('h5.sinaimg.cn/upload') && (i.naturalWidth || 0) < 80) return;
      urls.push(s);
    });
  }
  const url = location.href;
  return { title, time, from: from_, text, imgs: [...new Set(urls)], url };
}"""


def click_card_weibo_text_js(idx: int) -> str:
    return f"""() => {{
  const idx = {idx};
  const cards = [...document.querySelectorAll('.card-wrap')];
  if (idx < 0 || idx >= cards.length) return {{ ok: false, n: cards.length, err: 'bad idx' }};
  const card = cards[idx];
  const pick = (c) =>
    c.querySelector('article.weibo-main .weibo-og .weibo-text') ||
    c.querySelector('article .weibo-text') ||
    c.querySelector('.weibo-text');
  const el = pick(card);
  if (!el) return {{ ok: false, n: cards.length, err: 'no weibo-text' }};
  el.click();
  return {{ ok: true, n: cards.length }};
}}"""


def scroll_feed_js() -> str:
    return r"""() => {
  window.scrollTo(0, document.body.scrollHeight);
  return document.body.scrollHeight;
}"""


def detail_id_from_url(url: str) -> str | None:
    m = re.search(r"/detail/(\d+)", url)
    if m:
        return m.group(1)
    m = re.search(r"/status/(\d+)", url)
    if m:
        return m.group(1)
    return None


def load_state(state_path: Path) -> dict:
    if not state_path.exists():
        return {}
    try:
        return json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_state(state_path: Path, state: dict) -> None:
    state = dict(state)
    state["updated_at"] = now_iso()
    state_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def initial_state(profile_url: str, requested_pages: int, target_scrolls: int) -> dict:
    return {
        "profile_url": profile_url,
        "requested_pages": requested_pages,
        "target_scrolls": target_scrolls,
        "last_scrolls_completed": 0,
        "exported_detail_ids": [],
        "written_files": [],
        "status": "running",
    }


def ensure_selected_page(base: str, url: str) -> None:
    api(base, "/api/new_page", {"url": url, "timeout": 60000})


def list_pages_text(base: str) -> str:
    return _merge_api_text(api(base, "/api/list_pages", {}))


def main() -> None:
    ap = argparse.ArgumentParser(description="Export Weibo profile feed to Markdown (chrome-dev-mcp-server).")
    ap.add_argument(
        "profile_url",
        nargs="?",
        default="https://m.weibo.cn/u/1645776681",
        help="Profile URL (m.weibo.cn/u/UID), query string preserved",
    )
    ap.add_argument(
        "--pages",
        type=int,
        default=1,
        help="How many feed pages to load via infinite scroll (1 = no extra scroll)",
    )
    ap.add_argument(
        "--scrolls",
        type=int,
        default=None,
        help="Override: how many times to scroll to bottom (default: pages - 1)",
    )
    ap.add_argument(
        "--out",
        type=Path,
        default=ROOT_DIR / "exports" / "weibo-profile",
        help="Output directory for .md files",
    )
    ap.add_argument(
        "--base-url",
        default="http://127.0.0.1:9223",
        help="chrome-dev-mcp-server base URL",
    )
    ap.add_argument(
        "--resume",
        action="store_true",
        help="Resume from state.json by replaying recorded scrolls - 1 and skipping exported detail ids",
    )
    ap.add_argument(
        "--reset-state",
        action="store_true",
        help="Delete existing state.json before export starts",
    )
    args = ap.parse_args()
    base = args.base_url
    profile_url = normalize_profile_url(args.profile_url)

    scrolls = args.scrolls if args.scrolls is not None else max(0, int(args.pages) - 1)

    args.out.mkdir(parents=True, exist_ok=True)
    images_dir = args.out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    state_path = args.out / "state.json"

    if args.reset_state and state_path.exists():
        state_path.unlink()
        print(f"Deleted state: {state_path}")

    state = initial_state(profile_url, args.pages, scrolls)
    saved = load_state(state_path) if args.resume else {}
    if args.resume and saved:
        saved_profile = normalize_profile_url(saved.get("profile_url", ""))
        if saved_profile and saved_profile != profile_url:
            raise RuntimeError(
                f"State profile mismatch: state={saved_profile} current={profile_url}. "
                "Use --reset-state to start fresh."
            )
        state.update(saved)
        state["requested_pages"] = args.pages
        state["target_scrolls"] = scrolls
        state["status"] = "running"
        print(f"Resuming from state: {state_path}")
    else:
        save_state(state_path, state)

    print(f"Open page: {profile_url}")
    ensure_selected_page(base, profile_url)
    time.sleep(3.0)
    print(list_pages_text(base))

    try:
        n_exp = eval_json(base, CLICK_EXPAND_FEED_JS)
        if n_exp:
            print(f"Clicked 展开 on feed: {n_exp} time(s)")
            time.sleep(1.0)
    except Exception as e:
        print(f"Note: feed expand click: {e}")

    replay_scrolls = 0
    if args.resume and saved:
        replay_scrolls = max(0, int(state.get("last_scrolls_completed", 0)) - 1)
        replay_scrolls = min(replay_scrolls, scrolls)
        print(f"Replay scrolls for resume: {replay_scrolls}")

    exported_detail_ids = set(state.get("exported_detail_ids", []))
    written_files = list(state.get("written_files", []))

    for i in range(scrolls):
        print(f"Infinite scroll {i + 1}/{scrolls}")
        api(base, "/api/evaluate_script", {"function": scroll_feed_js()})
        time.sleep(2.2)
        state["last_scrolls_completed"] = i + 1
        save_state(state_path, state)
        if i + 1 >= replay_scrolls:
            continue

    try:
        eval_json(base, CLICK_EXPAND_FEED_JS)
        time.sleep(0.8)
    except Exception:
        pass

    n_cards = int(eval_json(base, COUNT_CARDS_JS))
    print(f"Found {n_cards} card(s) after loading {args.pages} page(s).")

    written = 0
    for idx in range(n_cards):
        print(f"--- Post {idx + 1}/{n_cards} (click weibo-text) ---")
        r = eval_json(base, click_card_weibo_text_js(idx))
        if not r.get("ok"):
            print(f"  skip: {r}")
            continue
        time.sleep(2.0)

        pages = parse_pages_after_nav(base)
        url_now = selected_page_url(pages)
        if "/detail/" not in url_now and "/status/" not in url_now:
            print(f"  expected detail page, got: {url_now!r}")
            continue

        detail = eval_json(base, EXTRACT_DETAIL_JS)
        time.sleep(0.4)
        src_url = detail.get("url") or url_now
        did = detail_id_from_url(src_url) or f"idx_{idx}"
        if did in exported_detail_ids:
            print(f"  skip duplicate detail id: {did}")
            api(base, "/api/navigate_page", {"type": "back"})
            time.sleep(1.5)
            continue
        title = detail.get("title") or f"weibo_{did}"
        body_text = detail.get("text") or ""
        time_s = detail.get("time") or ""
        from_s = detail.get("from") or ""
        imgs = list(detail.get("imgs") or [])

        md_body, errs = images_to_local_markdown(body_text, imgs, images_dir, did)
        if errs:
            for e in errs[:8]:
                print(f"  img warn: {e}")

        md = (
            f"# {title}\n\n"
            f"- 时间: {time_s}\n"
            f"- 来源: {from_s}\n"
            f"- 链接: {src_url}\n\n"
            f"---\n\n"
            f"{md_body}\n"
        )
        out_path = args.out / f"{idx:03d}_detail_{did}.md"
        out_path.write_text(md, encoding="utf-8")
        written += 1
        exported_detail_ids.add(did)
        written_files.append(out_path.name)
        state["exported_detail_ids"] = sorted(exported_detail_ids)
        state["written_files"] = written_files
        save_state(state_path, state)
        print(f"  wrote {out_path.name}")

        api(base, "/api/navigate_page", {"type": "back"})
        time.sleep(1.5)

    state["status"] = "done"
    save_state(state_path, state)
    print(f"Done. {written} file(s) in {args.out}")


def parse_pages_after_nav(base: str) -> list[tuple[int, str, bool]]:
    r = api(base, "/api/list_pages", {})
    text = _merge_api_text(r)
    pages: list[tuple[int, str, bool]] = []
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^(\d+):\s+(.+)$", line)
        if not m:
            continue
        pid = int(m.group(1))
        rest = m.group(2).strip()
        selected = " [selected]" in rest
        url = rest.replace(" [selected]", "").strip()
        pages.append((pid, url, selected))
    return pages


def selected_page_url(pages: list[tuple[int, str, bool]]) -> str:
    for _pid, url, sel in pages:
        if sel:
            return url
    return pages[0][1] if pages else ""


if __name__ == "__main__":
    main()
