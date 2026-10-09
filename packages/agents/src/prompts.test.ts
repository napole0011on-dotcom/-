import { describe, expect, it } from 'vitest';
import { promptHash, promptLabel, validatePromptText } from './prompts.js';

describe('prompt validation before saving a version', () => {
  it('accepts normal text and rejects empty, oversized and front matter', () => {
    expect(validatePromptText('Ты — CEO контент-команды.')).toBeNull();
    expect(validatePromptText(' \r\n ')).toBe('Промпт пустой');
    expect(validatePromptText('ж'.repeat(16_385))).toMatch(/32 КБ/); // 2 bytes per letter
    expect(validatePromptText('ж'.repeat(16_384))).toBeNull();
    expect(validatePromptText('---\nversion: 2\n---\nТекст')).toMatch(/front matter/);
  });

  it('labels versions as agent@N#hash8 with a stable hash', () => {
    expect(promptHash('abc')).toHaveLength(8);
    expect(promptHash('abc')).toBe(promptHash('abc'));
    expect(promptLabel('ceo', 3, promptHash('abc'))).toMatch(/^ceo@3#[0-9a-f]{8}$/);
  });
});
