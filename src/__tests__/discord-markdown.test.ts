import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  collapseExtraNewlinesOutsideFences,
  markdownToDiscordChunks,
} from '../lib/bridge/markdown/discord';

describe('collapseExtraNewlinesOutsideFences', () => {
  it('collapses 3+ newlines to 2 in prose', () => {
    assert.equal(
      collapseExtraNewlinesOutsideFences('Line one\n\n\n\nLine two'),
      'Line one\n\nLine two',
    );
  });

  it('does not collapse newlines inside fenced code blocks', () => {
    const input = 'Intro\n\n```\n\n\n\n\n```\n\nOutro';
    const out = collapseExtraNewlinesOutsideFences(input);
    assert.ok(out.includes('```\n\n\n\n\n```'));
    assert.equal(out.split('```')[2].trim(), 'Outro');
  });

  it('leaves single and double newlines in prose unchanged', () => {
    assert.equal(
      collapseExtraNewlinesOutsideFences('a\nb'),
      'a\nb',
    );
    assert.equal(
      collapseExtraNewlinesOutsideFences('a\n\nb'),
      'a\n\nb',
    );
  });
});

describe('markdownToDiscordChunks', () => {
  it('applies prose newline collapse before chunking', () => {
    const chunks = markdownToDiscordChunks('x\n\n\n\n\ny', 2000);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, 'x\n\ny');
  });
});
