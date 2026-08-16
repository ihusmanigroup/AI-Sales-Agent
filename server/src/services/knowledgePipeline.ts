import pdfParse from 'pdf-parse';
import { query } from '../db/db';
import { executeLLM, llm } from '../providers/llm';
import { embedText, retrieveChunksIn } from '../providers/vector';
import { logActivity } from '../lib/activity';
import { extractCompanyStructured } from './agentEngine';

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
  const extracted = await extractCompanyStructured(name, cleanText);

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

export async function askCompanyKnowledge(workspaceId: string, question: string, k = 6) {
  const profiles = await query(`SELECT id FROM company_profiles WHERE workspace_id=$1`, [workspaceId]);
  const ids = profiles.rows.map((r: any) => r.id);
  if (ids.length === 0) {
    return { answer: null, sources: [], error: 'No company knowledge has been indexed yet. Upload a PDF first.' };
  }
  const chunks = await retrieveChunksIn(ids, question, k);
  if (chunks.length === 0) {
    return { answer: null, sources: [], error: 'No matching knowledge found in the indexed company documents.' };
  }
  let answer = '';
  if (llm.hasProvider) {
    const context = chunks.map((c: any, i: number) => `[${i + 1}] ${c.content}`).join('\n');
    const syn = await executeLLM(
      `You are a company knowledge assistant. Answer the user's question using ONLY the indexed knowledge chunks provided below. Do not invent facts. If the knowledge does not contain the answer, say you could not find that information in the uploaded company documents. Cite source numbers like [1] when used.`,
      `Question: ${question}\n\nIndexed company knowledge:\n${context}`,
      false
    );
    if (syn) answer = syn.trim();
  }
  if (!answer) {
    answer = chunks.map((c: any) => `• ${c.content}`).join('\n');
  }
  return {
    answer,
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