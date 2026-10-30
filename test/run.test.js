import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = [];
vi.mock('../src/db.js', () => ({
  query: vi.fn(async (text, params) => {
    calls.push({ text, params });
    return { rows: [{ id: 7 }] };
  }),
}));

const { withRun } = await import('../src/run.js');
const updates = () => calls.filter((c) => c.text.includes('UPDATE processing_run')).map((c) => c.params);

// Patron partagé par ingest, normalize, classify et pool refresh.
describe('withRun', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('clôt le run en done avec le détail et le renvoie avec runId', async () => {
    const res = await withRun('classify', { limit: 5 }, async (runId) => ({ classified: runId }));
    expect(res).toEqual({ runId: 7, classified: 7 });
    expect(calls[0].params).toEqual(['classify', '{"limit":5}']);
    expect(updates()).toEqual([[7, 'done', '{"classified":7}']]);
  });

  it("clôt le run en failed avec l'erreur et la relance", async () => {
    await expect(
      withRun('normalize', {}, async () => {
        throw new Error('boum');
      }),
    ).rejects.toThrow('boum');
    expect(updates()).toEqual([[7, 'failed', '{"error":"boum"}']]);
  });
});
