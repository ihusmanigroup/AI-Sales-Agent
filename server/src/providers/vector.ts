import { query } from '../db/db';

const DIM = 384;

function hashToUnit(seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return (h % 100000) / 100000; // 0..1
}

/**
 * Deterministic hashing-based embedding. No external embedding API required:
 * shared tokens between a query and a chunk produce high cosine similarity,
 * which is sufficient for grounded RAG retrieval in this workflow.
 */
export function embedText(text: string): number[] {
  const vec = new Array(DIM).fill(0);
  const tokens = (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);

  for (const token of tokens) {
    let h = 2166136261;
    for (let i = 0; i < token.length; i++) {
      h ^= token.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = h >>> 0;
    const dim = idx % DIM;
    const sign = (idx >> 8) % 2 === 0 ? 1 : -1;
    vec[dim] += sign;
  }
  return vec;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Chunk {
  id: string;
  title: string;
  content: string;
  category: string;
  page: number | null;
  section: string | null;
  heading: string | null;
  chunkIndex: number | null;
  score: number;
  companyName?: string;
}

/**
 * Retrieves the most relevant knowledge chunks for a company profile using
 * vector similarity over the persisted embeddings.
 */
export async function retrieveChunks(
  companyProfileId: string,
  queryText: string,
  k = 5
): Promise<Chunk[]> {
  return retrieveChunksIn([companyProfileId], queryText, k);
}

/**
 * Retrieves the most relevant chunks across a set of company profiles
 * (used when a workspace holds multiple indexed knowledge documents).
 */
export async function retrieveChunksIn(
  companyProfileIds: string[],
  queryText: string,
  k = 5
): Promise<Chunk[]> {
  const qVec = embedText(queryText);
  const res = await query(
    `SELECT kc.id, kc.title, kc.content, kc.category, kc.page, kc.section, kc.heading, kc.chunk_index, kc.embedding, cp.name AS company_name
     FROM knowledge_chunks kc JOIN company_profiles cp ON cp.id = kc.company_profile_id
     WHERE kc.company_profile_id = ANY($1)`,
    [companyProfileIds]
  );

  const scored: Chunk[] = res.rows
    .map((row: any) => {
      let score = 0;
      if (row.embedding) {
        let emb: number[] = row.embedding;
        if (typeof row.embedding === 'string') {
          try {
            emb = JSON.parse(row.embedding);
          } catch {
            emb = [];
          }
        }
        if (Array.isArray(emb) && emb.length === DIM) {
          score = cosine(qVec, emb);
        }
      }
      // Lexical boost for stronger matching
      const qWords = new Set(queryText.toLowerCase().split(/\s+/));
      const contentWords = (row.title + ' ' + row.content).toLowerCase().split(/\s+/);
      const hits = contentWords.filter((w) => qWords.has(w)).length;
      score += hits * 0.05;
      return {
        id: row.id,
        title: row.title,
        content: row.content,
        category: row.category,
        page: row.page,
        section: row.section,
        heading: row.heading,
        chunkIndex: row.chunk_index,
        score,
        companyName: row.company_name
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored;
}

export const vector = {
  embed: embedText,
  cosine,
  retrieve: retrieveChunks
};