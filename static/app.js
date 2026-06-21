// Utility functions
const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

async function api(url, options = {}) {
  try {
    const response = await fetch(url, {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
}

// Get selected knowledge kinds
function selectedKinds() {
  const checkboxes = document.querySelectorAll('#kindsContainer input[type="checkbox"]:checked');
  return Array.from(checkboxes).map(cb => cb.value);
}

// Main RAG execution function
async function runAgenticRag() {
  const query = $('queryInput').value.trim();

  if (!query) {
    alert('请输入查询问题');
    return;
  }

  const runButton = $('runButton');
  runButton.disabled = true;
  runButton.textContent = '运行中...';

  try {
    const payload = await api('/api/run', {
      method: 'POST',
      body: JSON.stringify({
        query: query,
        kinds: selectedKinds(),
        maxIterations: Number($('iterationSelect').value),
        strictness: $('gateSelect').value,
        enableWebEnhancement: $('enableWebEnhancement').checked
      }),
    });

    // Display results
    $('resultsContainer').style.display = 'block';

    // Render answer
    renderAnswer(payload.answer);

    // Display web sources if any
    if (payload.trace && payload.trace.web_enhanced) {
      renderWebSources(payload.trace.web_sources);
    } else {
      $('webSourcesPanel').style.display = 'none';
    }

    // Render evidence
    if (payload.evidence && payload.evidence.length > 0) {
      renderEvidence(payload.evidence);
    }

    // Render trace
    if (payload.trace) {
      renderTrace(payload.trace);
    }

  } catch (error) {
    alert('查询失败: ' + error.message);
  } finally {
    runButton.disabled = false;
    runButton.textContent = '运行查询';
  }
}

// Render answer
function renderAnswer(answer) {
  const panel = $('answerPanel');
  panel.innerHTML = `<div class="answer-text">${escapeHtml(answer).replace(/\n/g, '<br>')}</div>`;
}

// Render web sources
function renderWebSources(sources) {
  const panel = $('webSourcesPanel');
  const list = $('webSourcesList');

  if (!sources || sources.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  list.innerHTML = sources.map(src => `
    <div class="web-source-item">
      <div class="web-source-rank">#${src.rank}</div>
      <div class="web-source-content">
        <a href="${src.url}" target="_blank" class="web-source-title">
          ${escapeHtml(src.title)}
        </a>
        <div class="web-source-url">${escapeHtml(src.url)}</div>
        <div class="web-source-score">相关度: ${(src.relevance_score * 100).toFixed(1)}%</div>
      </div>
    </div>
  `).join('');
}

// Render evidence
function renderEvidence(evidence) {
  const panel = $('evidencePanel');
  const list = $('evidenceList');

  if (!evidence || evidence.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  list.innerHTML = evidence.map((item, idx) => `
    <div class="evidence-item">
      <div class="evidence-header">
        <span class="evidence-index">#${idx + 1}</span>
        <span class="evidence-source">${escapeHtml(item.source || 'Unknown')}</span>
        ${item.score ? `<span class="evidence-score">Score: ${item.score.toFixed(2)}</span>` : ''}
      </div>
      <div class="evidence-content">${escapeHtml(item.content)}</div>
    </div>
  `).join('');
}

// Render trace
function renderTrace(trace) {
  const panel = $('tracePanel');
  const details = $('traceDetails');

  panel.style.display = 'block';

  const iterations = trace.iterations || [];
  details.innerHTML = `
    <div class="trace-summary">
      <div>总迭代次数: ${iterations.length}</div>
      <div>Web增强: ${trace.web_enhanced ? '是' : '否'}</div>
    </div>
    <div class="trace-iterations">
      ${iterations.map((iter, idx) => `
        <div class="trace-iteration">
          <div class="trace-iteration-header">迭代 #${idx + 1}</div>
          <div class="trace-iteration-content">
            <div><strong>检索到:</strong> ${iter.retrieved_count || 0} 个文档</div>
            <div><strong>通过率:</strong> ${iter.gate_result || 'N/A'}</div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
  $('runButton').addEventListener('click', runAgenticRag);

  // Allow Enter key to submit (with Ctrl/Cmd)
  $('queryInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      runAgenticRag();
    }
  });
});
