#!/usr/bin/env bash
# 将「角色与 Runner」页中：各 lane 默认 runner + 各 lane 已配置人员的 runner，
# 全部设为当前平台 /api/platform/runners 返回的第一个 runner（与 admin 使用同一套 CTI_HOME 配置）。
# 用法：BASE_URL=http://127.0.0.1:3300 bash scripts/board-roles-set-all-runners-to-first.sh

set -euo pipefail
export BASE_URL="${BASE_URL:-http://127.0.0.1:3300}"

node <<'NODE'
const BASE = process.env.BASE_URL;

async function main() {
  const runnersRes = await fetch(`${BASE}/api/platform/runners`);
  if (!runnersRes.ok) throw new Error(await runnersRes.text());
  const { runners } = await runnersRes.json();
  const rid = runners?.[0]?.id;
  if (!rid) throw new Error('No runners from /api/platform/runners — check CTI_HOME config.env and restart Next.');

  const projectsRes = await fetch(`${BASE}/api/projects`);
  if (!projectsRes.ok) throw new Error(await projectsRes.text());
  const projects = await projectsRes.json();
  if (!Array.isArray(projects) || projects.length === 0) {
    console.error('No projects. Create one at /projects first.');
    process.exit(1);
  }

  const kinds = ['agent-dev', 'codex-senior', 'claude-review', 'copilot-test'];

  for (const p of projects) {
    const krRes = await fetch(`${BASE}/api/projects/${encodeURIComponent(p.id)}/kanban-roles`);
    if (!krRes.ok) throw new Error(await krRes.text());
    const kr = await krRes.json();

    const kanbanRoleRunners = {};
    for (const k of kinds) kanbanRoleRunners[k] = rid;

    const kanbanRoleMembers = {};
    for (const k of kinds) {
      const list = Array.isArray(kr.members?.[k]) ? kr.members[k] : [];
      kanbanRoleMembers[k] = list.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        runnerProfileId: rid,
      }));
    }

    const kanbanLaneSkills = {};
    for (const k of kinds) {
      const arr = kr.kanbanLaneSkills?.[k];
      kanbanLaneSkills[k] = Array.isArray(arr) ? [...arr] : [];
    }

    const putRes = await fetch(`${BASE}/api/projects/${encodeURIComponent(p.id)}/kanban-roles`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kanbanRoleRunners, kanbanRoleMembers, kanbanLaneSkills }),
    });
    const text = await putRes.text();
    if (!putRes.ok) throw new Error(`PUT ${p.id}: ${text}`);
    console.log(`OK ${p.id} (${p.name ?? ''}) — all lanes + members → runner ${rid}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
NODE
