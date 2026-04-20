import { describe, it, expect } from 'vitest';
import { extractJson } from '../src/json-extract.js';

describe('extractJson', () => {
  it('step 1: parses clean JSON directly', () => {
    expect(extractJson('{"x":1}')).toEqual({ value: { x: 1 }, path: 1 });
    expect(extractJson('  {"x":1}\n')).toEqual({ value: { x: 1 }, path: 1 });
    expect(extractJson('[1,2,3]')).toEqual({ value: [1, 2, 3], path: 1 });
  });

  it('step 2: extracts from fenced ```json block', () => {
    const input = 'Here is the result:\n```json\n{"y":2}\n```\ndone.';
    expect(extractJson(input)).toEqual({ value: { y: 2 }, path: 2 });
  });

  it('step 2: extracts from plain fenced ``` block', () => {
    const input = 'prefix\n```\n{"z":3}\n```';
    expect(extractJson(input)).toEqual({ value: { z: 3 }, path: 2 });
  });

  it('step 3: brace-depth scanner handles strings with braces', () => {
    const input = 'I think the answer is {"msg":"hello {world}","n":4} because...';
    expect(extractJson(input)).toEqual({ value: { msg: 'hello {world}', n: 4 }, path: 3 });
  });

  it('step 3: brace-depth scanner handles escaped quotes in strings', () => {
    const input = 'output: {"s":"a \\"b\\" c","n":5}';
    expect(extractJson(input)).toEqual({ value: { s: 'a "b" c', n: 5 }, path: 3 });
  });

  it('step 3: extracts first balanced array', () => {
    const input = 'result is [1,2,{"k":"v"}] ok';
    expect(extractJson(input)).toEqual({ value: [1, 2, { k: 'v' }], path: 3 });
  });

  it('returns null when no JSON found', () => {
    expect(extractJson('nothing json here')).toBeNull();
    expect(extractJson('')).toBeNull();
  });

  it('returns null when fenced block contains invalid JSON', () => {
    expect(extractJson('```json\nnot json\n```')).toBeNull();
  });
});
