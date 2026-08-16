import pdfParse from 'pdf-parse';
import { query } from '../db/db';
import { executeLLM, llm } from '../providers/llm';
import { embedText, retrieveChunksIn } from '../providers/vector';
import { webSearch } from '../providers/search';
import { logActivity } from '../lib/activity';
import { extractCompanyStructured, normalizeExtractedArrays } from './agentEngine';

const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type DocStatus = 'processing' | 'indexed' | 'failed';

interface ChunkInput {
  title: string;
  content: string;
  category: string;
  page: number | null;
  section: string | null;
  heading: string | null;
}

// ---------- validation ----------

export function validatePdfFile(buffer: Buffer, originalname: string, mimetype: string, sizeBytes: number) {
  if (!originalname || !originalname.toLowerCase().endsWith('.pdf')) {
    throw new Error('Only PDF files are supported. Please upload a .pdf file.');
  }
  if (mimetype && mimetype !== 'application/pdf' && !mimetype.includes('pdf')) {
    throw new Error(`"${mimetype}" is not a PDF file. Only PDF documents are supported.`);
  }
  if (!buffer || buffer.length === 0) {
    throw new Error('The uploaded file is empty.');
  }
  if (sizeBytes > MAX_PDF_BYTES) {
    throw new Error(`This file is ${Math.round(sizeBytes / 1024 / 1024)} MB. The maximum upload size is 10 MB.`);
  }
  const header = buffer.slice(0, 5).toString('latin1');
  if (!header.startsWith('%PDF')) {
    throw new Error('This file is corrupted or is not a valid PDF document.');
  }
}

// ---------- extraction (page-aware) ----------

export async function extractPdfPages(buffer: Buffer): Promise<{ pages: string[]; numPages: number }> {
  const pages: string[] = [];
  const options: any = {
    max: 0,
    pagerender: (pageData: any) =>
      pageData
        .getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false })
        .then((textContent: any) => {
          let text = '';
          let lastY: number | undefined;
          for (const item of textContent.items || []) {
            if (lastY === undefined || lastY === item.transform[5]) text += item.str;
            else text += '\n' + item.str;
            lastY = item.transform[5];
          }
          pages.push(text || '');
          return text;
        })
  };
  const result = await pdfParse(buffer, options);
  return { pages, numPages: result.numpages || pages.length };
}

// ---------- chunking ----------

function cleanPageText(pages: string[]): string[] {
  return pages.map((p) => p.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
}

function buildContentChunks(pages: string[]): ChunkInput[] {
  const chunks: ChunkInput[] = [];
  const MAX = 1200;
  pages.forEach((pageText, idx) => {
    const pageNo = idx + 1;
    const blocks = pageText
      .split(/\n\s*\n/)
      .map((b) => b.replace(/\s+/g, ' ').trim())
      .filter((b) => b.length > 0);
    let currentSection: string | null = null;
    let buffer = '';
    const flush = () => {
      if (buffer.length > 0) {
        chunks.push({
          title: buffer.slice(0, 90),
          content: buffer,
          category: 'content',
          page: pageNo,
          section: currentSection,
          heading: currentSection
        });
        buffer = '';
      }
    };
    for (const block of blocks) {
      const looksLikeHeading =
        block.length <= 80 && block.split(/\s+/).length <= 12 && block === block.trim() && !/[.!?:]$/.test(block);
      if (looksLikeHeading && block.toLowerCase() !== currentSection?.toLowerCase()) {
        flush();
        currentSection = block;
        continue;
      }
      if (buffer.length + block.length + 1 > MAX && buffer.length > 0) {
        flush();
      }
      buffer = buffer ? `${buffer} ${block}` : block;
    }
    flush();
  });
  return chunks;
}

function buildDerivedChunks(name: string, pages: string[], extracted: any): ChunkInput[] {
  const allText = pages.map((p) => p.toLowerCase());
  const locate = (phrase: string): { page: number | null; section: string | null } => {
    const key = (phrase || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
    if (!key) return { page: null, section: null };
    for (let i = 0; i < allText.length; i++) {
      if (allText[i].includes(key)) {
        const firstLine = pages[i].split('\n').map((l) => l.trim()).find((l) => l.length > 0) || null;
        return { page: i + 1, section: firstLine && firstLine.length <= 80 ? firstLine : null };
      }
    }
    return { page: null, section: null };
  };

  const out: ChunkInput[] = [];
  const push = (items: any[], category: string, titleFor: (it: any) => string, contentFor: (it: any) => string) => {
    for (const it of items || []) {
      const content = contentFor(it);
      if (!content || !content.trim()) continue;
      const loc = locate(typeof it === 'string' ? it : content);
      out.push({ title: titleFor(it), content, category, page: loc.page, section: loc.section, heading: loc.section });
    }
  };

  push(extracted.offerings, 'offering', (o: string) => `Capability: ${o}`, (o: string) => `${name} provides ${o}.`);
  push(extracted.targetIndustries, 'industry', (ind: string) => `Target Industry: ${ind}`, (ind: string) => `${name} serves the ${ind} vertical.`);
  push(extracted.caseStudies, 'case_study', () => 'Case Study', (cs: string) => cs);
  push(extracted.pricing, 'pricing', () => 'Pricing', (p: string) => p);
  push(extracted.techStack, 'tech', () => 'Technology', (t: string) => t);
  push(extracted.limitations, 'limitation', () => 'Limitation', (l: string) => l);
  return out;
}

function buildChunks(name: string, pages: string[], extracted: any): ChunkInput[] {
  return [...buildContentChunks(pages), ...buildDerivedChunks(name, pages, extracted)];
}

// ---------- profile upsert ----------

async function upsertProfile(docId: string, workspaceId: string, name: string, extracted: any, pageText: string): Promise<string> {
  const doc = (
    await query(`SELECT company_profile_id FROM company_documents WHERE id = $1`, [docId])
  ).rows[0];
  const payload = [
    name,
    extracted.tagline || `${name} Platform`,
    extracted.summary || '',
    JSON.stringify(extracted.offerings || []),
    JSON.stringify(extracted.targetIndustries || []),
    JSON.stringify(extracted.caseStudies || []),
    JSON.stringify(extracted.pricing || []),
    JSON.stringify(extracted.techStack || []),
    JSON.stringify(extracted.limitations || []),
    'PDF',
    pageText,
    workspaceId
  ];
  if (doc?.company_profile_id) {
    await query(
      `UPDATE company_profiles SET name=$1, tagline=$2, summary=$3, offerings=$4, target_industries=$5,
       case_studies=$6, pricing=$7, tech_stack=$8, limitations=$9, source_type=$10, source_text=$11, workspace_id=$12, updated_at=NOW()
       WHERE id=$13`,
      [...payload, doc.company_profile_id]
    );
    return doc.company_profile_id;
  }
  const ins = await query(
    `INSERT INTO company_profiles (name, tagline, summary, offerings, target_industries, case_studies, pricing, tech_stack, limitations, source_type, source_text, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    payload
  );
  await query(`UPDATE company_documents SET company_profile_id = $1 WHERE id = $2`, [ins.rows[0].id, docId]);
  return ins.rows[0].id;
}

// ---------- step tracking ----------

async function setDocStep(workspaceId: string, docId: string, status: DocStatus, detail: string, extra: any = {}) {
  await query(
    `UPDATE company_documents SET status = $1, status_detail = $2, updated_at = NOW() WHERE id = $3 AND workspace_id = $4`,
    [status, detail, docId, workspaceId]
  );
  return extra;
}

function safeErrorMessage(err: any): string {
  const msg = err?.message || String(err || 'Unknown error');
  return msg.replace(/\s+/g, ' ').slice(0, 400);
}

// ---------- main pipeline ----------

async function buildKnowledge(opts: {
  docId: string;
  workspaceId: string;
  filename: string;
  pages: string[];
}): Promise<{ profileId: string; chunkCount: number; pageCount: number }> {
  const { docId, workspaceId, filename, pages } = opts;
  const cleanPages = cleanPageText(pages);
  const fullText = cleanPages.filter(Boolean).join('\n\n');
  const cleanText = fullText.replace(/\s+/g, ' ').replace(/ \./g, '.').trim();
  if (cleanText.length < 10) {
    throw new Error('Could not extract readable text from this PDF. It may be scanned or image-based — please upload a text-based PDF.');
  }

  await setDocStep(workspaceId, docId, 'processing', 'analyzing');
  const name = filename.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'Company Knowledge';
  const extracted = await extractCompanyStructured(name, cleanText, 15000);

  await setDocStep(workspaceId, docId, 'processing', 'chunking');
  const chunks = buildChunks(name, cleanPages, extracted);

  await setDocStep(workspaceId, docId, 'processing', 'embedding');
  const profileId = await upsertProfile(docId, workspaceId, name, extracted, cleanText);

  await query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [docId]);
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    const embedding = JSON.stringify(embedText(c.content));
    await query(
      `INSERT INTO knowledge_chunks (company_profile_id, document_id, title, content, category, page, section, heading, chunk_index, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [profileId, docId, c.title, c.content, c.category, c.page, c.section, c.heading, i, embedding]
    );
  }

  await setDocStep(workspaceId, docId, 'processing', 'indexing');
  await setDocStep(workspaceId, docId, 'processing', 'finalizing');
  await query(
    `UPDATE company_documents SET status='indexed', status_detail='indexed', error=NULL, page_count=$1, chunk_count=$2, page_text=$3, updated_at=NOW() WHERE id=$4`,
    [cleanPages.length, chunks.length, JSON.stringify(cleanPages), docId]
  );

  await logActivity({
    agent: 'Company Intelligence',
    step: 'PDF Extraction & RAG Indexing',
    tool: 'knowledge_pipeline',
    inputData: `doc=${filename}, pages=${cleanPages.length}`,
    outputData: `profile_id=${profileId}, chunks=${chunks.length}`,
    decision: `Indexed ${chunks.length} knowledge chunks from ${cleanPages.length} page(s) of ${filename}.`,
    workspaceId
  });

  return { profileId, chunkCount: chunks.length, pageCount: cleanPages.length };
}

export async function processPdfUpload(opts: {
  docId: string;
  workspaceId: string;
  buffer: Buffer;
  filename: string;
  mimetype: string;
  sizeBytes: number;
}): Promise<{ profileId: string; chunkCount: number; pageCount: number }> {
  const { docId, workspaceId, buffer, filename, mimetype, sizeBytes } = opts;
  try {
    validatePdfFile(buffer, filename, mimetype, sizeBytes);
    await setDocStep(workspaceId, docId, 'processing', 'validating');
    await query(
      `UPDATE company_documents SET size_bytes=$1, mime_type=$2, filename=$3, updated_at=NOW() WHERE id=$4`,
      [sizeBytes, mimetype, filename, docId]
    );
    await setDocStep(workspaceId, docId, 'processing', 'extracting');
    const { pages } = await extractPdfPages(buffer);
    const res = await buildKnowledge({ docId, workspaceId, filename, pages });
    return res;
  } catch (e) {
    const msg = safeErrorMessage(e);
    await query(`UPDATE company_documents SET status='failed', status_detail='error', error=$1, updated_at=NOW() WHERE id=$2`, [msg, docId]);
    throw e;
  }
}

export async function reprocessDocument(opts: { docId: string; workspaceId: string }): Promise<{ profileId: string; chunkCount: number; pageCount: number }> {
  const { docId, workspaceId } = opts;
  try {
    const doc = (await query(`SELECT * FROM company_documents WHERE id=$1 AND workspace_id=$2`, [docId, workspaceId])).rows[0];
    if (!doc) throw new Error('Document not found.');
    let pages: string[] = [];
    const pt = doc.page_text;
    if (Array.isArray(pt)) {
      pages = pt;
    } else if (typeof pt === 'string' && pt.length > 0) {
      try { pages = JSON.parse(pt); } catch { pages = []; }
    }
    if (!Array.isArray(pages) || pages.length === 0) {
      const prof = doc.company_profile_id
        ? (await query(`SELECT * FROM company_profiles WHERE id=$1`, [doc.company_profile_id])).rows[0]
        : null;
      const text = prof?.source_text || '';
      if (!text) throw new Error('No source text is available to reprocess this document.');
      pages = [text];
    }
    await query(`UPDATE company_documents SET version = version + 1, status='processing', status_detail='reprocess', error=NULL, updated_at=NOW() WHERE id=$1`, [docId]);
    const res = await buildKnowledge({ docId, workspaceId, filename: doc.filename || 'knowledge', pages });
    return res;
  } catch (e) {
    const msg = safeErrorMessage(e);
    await query(`UPDATE company_documents SET status='failed', status_detail='error', error=$1, updated_at=NOW() WHERE id=$2`, [msg, docId]);
    throw e;
  }
}

export async function deleteDocument(opts: { docId: string; workspaceId: string }): Promise<void> {
  const { docId, workspaceId } = opts;
  const doc = (await query(`SELECT company_profile_id FROM company_documents WHERE id=$1 AND workspace_id=$2`, [docId, workspaceId])).rows[0];
  if (!doc) throw new Error('Document not found.');
  if (doc.company_profile_id) {
    await query(`DELETE FROM knowledge_chunks WHERE document_id=$1 OR company_profile_id=$2`, [docId, doc.company_profile_id]);
    await query(`DELETE FROM company_profiles WHERE id=$1`, [doc.company_profile_id]);
  } else {
    await query(`DELETE FROM knowledge_chunks WHERE document_id=$1`, [docId]);
  }
  await query(`DELETE FROM company_documents WHERE id=$1`, [docId]);
}

// ---------- RAG ask ----------

const INTENT_CATEGORY_RULES: Array<{ regex: RegExp; category: string }> = [
  { regex: /services|offerings?|capabilit|solutions?|products?|what do (we|they) (offer|provide|sell)/i, category: 'offering' },
  { regex: /industr|vertical|sector|markets?/i, category: 'industry' },
  { regex: /pricing|price|costs?|packages?|plans?|subscription|how much/i, category: 'pricing' },
  { regex: /tech|stack|tools?|api|protocol|integrat/i, category: 'tech' },
  { regex: /limit|constraint|prerequisit|boundary|restrict/i, category: 'limitation' },
  { regex: /case stud|customers?|clients?|roi|results?|metrics?|proven|success/i, category: 'case_study' }
];

function detectIntentCategories(question: string): string[] {
  const found: string[] = [];
  for (const rule of INTENT_CATEGORY_RULES) {
    if (rule.regex.test(question) && !found.includes(rule.category)) found.push(rule.category);
  }
  return found;
}

async function fetchProfileChunksByCategory(profileId: string, categories: string[], limit = 5): Promise<any[]> {
  const res = await query(
    `SELECT kc.id, kc.title, kc.content, kc.category, kc.page, kc.section, kc.heading, kc.chunk_index, cp.name AS company_name
     FROM knowledge_chunks kc JOIN company_profiles cp ON cp.id = kc.company_profile_id
     WHERE kc.company_profile_id = $1 AND kc.category = ANY($2)
     ORDER BY kc.chunk_index ASC, length(kc.content) DESC LIMIT $3`,
    [profileId, categories, limit]
  );
  return res.rows.map((r: any) => ({ ...r, score: 0 }));
}

export async function askCompanyKnowledge(workspaceId: string, question: string, k = 8) {
  const prof = await query(
    `SELECT id, name FROM company_profiles WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  const profile = prof.rows[0];
  if (!profile) {
    return { answer: null, sources: [], error: 'No company knowledge has been indexed yet. Upload a PDF or search a company first.' };
  }

  const chunks = await retrieveChunksIn([profile.id], question, k);

  const intentCategories = detectIntentCategories(question);
  if (intentCategories.length > 0) {
    const boosted = await fetchProfileChunksByCategory(profile.id, intentCategories, 5);
    const seen = new Set<string>(chunks.map((c: any) => c.id));
    for (const c of boosted) {
      if (!seen.has(c.id)) {
        chunks.push(c);
        seen.add(c.id);
      }
    }
  }

  if (chunks.length === 0) {
    return { answer: null, sources: [], error: 'No matching knowledge found in the indexed company documents.' };
  }

  let answer = '';
  if (llm.hasProvider) {
    const context = chunks.map((c: any, i: number) => `[${i + 1}] ${c.content}`).join('\n');
    const syn = await executeLLM(
      `You are the knowledge assistant for the company "${profile.name}". Answer the user's question using ONLY the indexed knowledge chunks provided below, which all belong to this company. Do not invent facts. If the knowledge does not contain the answer, say you could not find that information in the uploaded company documents. Cite source numbers like [1] when used.`,
      `Question: ${question}\n\nIndexed company knowledge:\n${context}`,
      false,
      30000
    );
    if (syn) answer = syn.trim();
  }
  if (!answer) {
    answer = chunks.map((c: any) => `• ${c.content}`).join('\n');
  }
  return {
    answer,
    company: profile.name,
    sources: chunks.map((c: any) => ({
      id: c.id,
      document: c.companyName || 'document',
      page: c.page,
      section: c.section,
      heading: c.heading,
      title: c.title,
      content: c.content,
      category: c.category,
      score: Math.round(c.score * 100) / 100
    }))
  };
}

// ---------- Web company research (anti-hallucination) ----------

const COMPANY_VERIFY_PROMPT = `You are a company verification assistant. Decide whether the search results below actually refer to the requested company.
STRICT RULES:
- A result MATCHES only if its URL domain, title, or snippet clearly contains the exact company name or its official website domain.
- Ignore directories, job boards, social-review sites, news aggregators, or unrelated businesses that merely share a similar name.
- Do not guess. If you are not confident there is a real match, return matched=false.
Respond ONLY with strict JSON (no markdown):
{"matched": boolean, "bestDomain": "official website domain only if a result matched, else empty string", "bestTitle": "title of the best matching result, else empty string"}`;

const WEB_EXTRACTION_PROMPT = `You are a B2B Sales Intelligence Research Agent. Using ONLY the web search evidence provided, build a factual company intelligence profile for the requested company.
STRICT RULES:
- Use ONLY facts present in the search evidence. Never invent names, URLs, metrics, prices, or claims.
- If a category has no supporting evidence, return an empty array [].
- For pricing, only include figures explicitly stated in the evidence.
- "summary": 2-3 sentence factual overview grounded in the evidence.
- "tagline": the company's actual tagline if present in the evidence, otherwise "".
Return strict JSON (no markdown):
{
  "summary": "...",
  "tagline": "...",
  "offerings": ["core capabilities or services"],
  "targetIndustries": ["target market verticals"],
  "caseStudies": ["value proof points or metrics"],
  "pricing": ["pricing models or starting tiers"],
  "techStack": ["tools, APIs, and protocols"],
  "limitations": ["prerequisites or constraints"]
}`;

function buildWebChunks(name: string, extracted: any): Array<{ title: string; content: string; category: string }> {
  return [
    ...normalizeExtractedArrays(extracted.offerings).map((o) => ({
      title: `Capability: ${o}`,
      content: `${name} provides ${o}.`,
      category: 'offering'
    })),
    ...normalizeExtractedArrays(extracted.targetIndustries).map((i) => ({
      title: `Target Industry: ${i}`,
      content: `${name} serves the ${i} vertical.`,
      category: 'industry'
    })),
    ...normalizeExtractedArrays(extracted.caseStudies).map((cs) => ({
      title: 'Case Study',
      content: cs,
      category: 'case_study'
    })),
    ...normalizeExtractedArrays(extracted.pricing).map((p) => ({
      title: 'Pricing',
      content: p,
      category: 'pricing'
    })),
    ...normalizeExtractedArrays(extracted.techStack).map((t) => ({
      title: 'Technology',
      content: t,
      category: 'tech'
    })),
    ...normalizeExtractedArrays(extracted.limitations).map((l) => ({
      title: 'Limitation',
      content: l,
      category: 'limitation'
    }))
  ];
}

export interface CompanySearchResult {
  found: boolean;
  error?: string;
  profile?: any;
}

export async function searchCompany(workspaceId: string, queryText: string): Promise<CompanySearchResult> {
  const results = await webSearch(queryText, 8);
  if (!results || results.length === 0) {
    return {
      found: false,
      error: `No web results found for "${queryText}". Check the spelling or try adding the company's website URL.`
    };
  }

  const evidence = results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n');

  const verify = await executeLLM(
    COMPANY_VERIFY_PROMPT,
    `Requested company: ${queryText}\n\nSearch results:\n${evidence}`,
    true,
    30000
  );
  const matched = Boolean(verify && verify.matched === true);
  if (!matched) {
    return {
      found: false,
      error: `Company "${queryText}" was not found. Double-check the spelling or try its website URL.`
    };
  }

  const extracted = await executeLLM(
    WEB_EXTRACTION_PROMPT,
    `Requested company: ${queryText}\n\nWeb search evidence:\n${evidence}`,
    true,
    45000
  );
  if (!extracted || !extracted.offerings) {
    return {
      found: false,
      error: `Could not reliably extract details for "${queryText}" from the web results. Try a more specific name.`
    };
  }

  const name = (typeof extracted.name === 'string' && extracted.name.trim()) ? extracted.name.trim() : queryText.trim();
  const website = (typeof verify.bestDomain === 'string' && verify.bestDomain.trim()) ? verify.bestDomain.trim() : null;

  const profileResult = await query(
    `INSERT INTO company_profiles (name, tagline, summary, offerings, target_industries, case_studies, pricing, tech_stack, limitations, source_type, source_text, workspace_id, website)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'WEB', $10, $11, $12) RETURNING *`,
    [
      name,
      (typeof extracted.tagline === 'string' && extracted.tagline.trim()) ? extracted.tagline.trim() : name,
      extracted.summary || `${name} — web-researched company profile.`,
      JSON.stringify(normalizeExtractedArrays(extracted.offerings)),
      JSON.stringify(normalizeExtractedArrays(extracted.targetIndustries)),
      JSON.stringify(normalizeExtractedArrays(extracted.caseStudies)),
      JSON.stringify(normalizeExtractedArrays(extracted.pricing)),
      JSON.stringify(normalizeExtractedArrays(extracted.techStack)),
      JSON.stringify(normalizeExtractedArrays(extracted.limitations)),
      evidence,
      workspaceId,
      website
    ]
  );
  const profile = profileResult.rows[0];

  const chunkSources = buildWebChunks(name, extracted);
  let chunkCount = 0;
  for (let i = 0; i < chunkSources.length; i++) {
    const c = chunkSources[i];
    await query(
      `INSERT INTO knowledge_chunks (company_profile_id, title, content, category, chunk_index, embedding)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [profile.id, c.title, c.content, c.category, i, JSON.stringify(embedText(c.content))]
    );
    chunkCount++;
  }

  await logActivity({
    agent: 'Company Intelligence',
    step: 'Web Company Research',
    tool: 'search_company()',
    inputData: `query=${queryText}`,
    outputData: `profile_id=${profile.id}, website=${website || 'n/a'}, chunks=${chunkCount}`,
    decision: matched ? `Found and indexed ${name} (${chunkCount} chunks) from web research.` : 'Company not found; nothing indexed.',
    workspaceId
  });

  return { found: true, profile: { ...profile, chunk_count: chunkCount } };
}