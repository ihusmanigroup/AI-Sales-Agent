import dotenv from 'dotenv';
import { query } from '../db/db';
import { executeLLM } from '../providers/llm';
import { webSearch, search } from '../providers/search';
import { sendEmail, email as emailProvider } from '../providers/email';
import { createMeetingLink } from '../providers/calendar';
import { sendWhatsApp, whatsapp } from '../providers/whatsapp';
import { retrieveChunks, embedText } from '../providers/vector';
import { maps, checkWebsite as checkWebsiteFn, extractGmailFromEmail, PlaceResult, WebsiteCheckResult } from '../providers/maps';
import { logActivity } from '../lib/activity';

dotenv.config();

export const PIPELINE_STAGES = [
  'Discovered',
  'Potential',
  'Researching',
  'Qualified',
  'Contacted',
  'Interested',
  'Meeting Scheduled',
  'Converted'
] as const;

export const NEGATIVE_STAGES = ['Not Qualified', 'Not Interested', 'Do Not Contact'] as const;

const RESPONSE_CLASSES = [
  'Positive / Interested',
  'Meeting Requested',
  'Question',
  'Pricing Objection',
  'Technical Objection',
  'Not Interested',
  'Not Now',
  'Wrong Person / Referral',
  'Other'
] as const;

// ---------- helpers ----------

function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true';
}

async function getWorkspaceSettings(workspaceId: string) {
  const res = await query(
    `SELECT outbound_enabled, followup_day_1, followup_day_2, meeting_default_hour FROM workspaces WHERE id = $1`,
    [workspaceId]
  );
  return res.rows[0] || { outbound_enabled: true, followup_day_1: 0, followup_day_2: 3, meeting_default_hour: 15 };
}

async function getLatestProfile(workspaceId: string) {
  const res = await query(
    `SELECT * FROM company_profiles WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [workspaceId]
  );
  return res.rows[0] || null;
}

function parseJsonField(val: any): any[] {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return [];
}

const serviceLabel = (title: string) => (title || 'Capability').replace(/^(Capability|Service):\s*/i, '');

// Re-ranks retrieved knowledge chunks for SERVICE RECOMMENDATION. A
// capability/offering chunk must win over a limitation, pricing, or generic
// block — otherwise the agent could "recommend" a limitation as a product.
// The hashing-based embeddings are noisy for short capability snippets, so
// the weighted score combines: (1) vector similarity with a category weight,
// (2) lexical overlap with the ICP problem, and (3) a strong preference for
// actual offering/capability chunks.
const SERVICE_CATEGORY_BOOST: Record<string, number> = {
  offering: 1.6,
  capability: 1.6,
  content: 1.3,
  case_study: 1.15,
  industry: 1.0,
  tech: 0.9,
  pricing: 0.7,
  limitation: 0.25
};

const SERVICE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'our', 'their', 'your', 'into', 'from', 'about',
  'this', 'that', 'they', 'them', 'are', 'was', 'were', 'will', 'can', 'could', 'would', 'has', 'have'
]);

function isOfferingChunk(c: any): boolean {
  const cat = (c.category || '').toLowerCase();
  if (cat === 'offering' || cat === 'capability') return true;
  const title = (c.title || '').toLowerCase();
  return title.startsWith('capability:') || title.startsWith('service:');
}

function lexicalOverlap(query: string, chunk: any): number {
  const qWords = (query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !SERVICE_STOPWORDS.has(w));
  const text = `${chunk.title || ''} ${chunk.content || ''}`.toLowerCase();
  return qWords.filter((w) => text.includes(w)).length;
}

function weightedServiceScore(c: any, query: string): number {
  const base = c.score || 0;
  const boost = (SERVICE_CATEGORY_BOOST[c.category] ?? 1);
  return base * boost + lexicalOverlap(query, c) * 0.1 + (isOfferingChunk(c) ? 0.3 : 0);
}

function rankChunksForService(chunks: any[], query: string): any[] {
  return [...chunks].sort((a, b) => weightedServiceScore(b, query) - weightedServiceScore(a, query));
}

function bestServiceChunk(chunks: any[], query: string): any | null {
  if (!chunks.length) return null;
  const ranked = rankChunksForService(chunks, query);
  const offering = ranked.find((c) => isOfferingChunk(c));
  const nonNegative = ranked.find((c) => !['limitation', 'pricing'].includes((c.category || '').toLowerCase()));
  return nonNegative || offering || ranked[0];
}

function parseSizeEmployees(size: string | null | undefined): number | null {
  if (!size) return null;
  const cleaned = size.replace(/,/g, '');
  const range = cleaned.match(/(\d+)\s*[-–to]+\s*(\d+)/i);
  const single = cleaned.match(/(\d+)/);
  if (range) return Math.round((parseInt(range[1]) + parseInt(range[2])) / 2);
  if (single) return parseInt(single[1]);
  return null;
}

// ---------- agent run (durable workflow state) ----------

export async function startAgentRun(opts: {
  workspaceId: string;
  leadId?: string;
  workflow: string;
  currentState: string;
  inputSnapshot?: any;
}) {
  const res = await query(
    `INSERT INTO agent_runs (workspace_id, lead_id, workflow, current_state, input_snapshot)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [opts.workspaceId, opts.leadId || null, opts.workflow, opts.currentState, JSON.stringify(opts.inputSnapshot || {})]
  );
  return res.rows[0];
}

export async function updateAgentRun(
  runId: string,
  patch: { currentState?: string; decision?: string; confidence?: number; nextAction?: string; status?: string; evidenceRefs?: any; toolCalls?: any; retryCount?: number }
) {
  const cols: string[] = [];
  const vals: any[] = [];
  const set = (col: string, val: any) => {
    if (val !== undefined) {
      cols.push(`${col} = $${vals.length + 1}`);
      vals.push(val);
    }
  };
  set('current_state', patch.currentState);
  set('decision', patch.decision);
  set('confidence', patch.confidence);
  set('next_action', patch.nextAction);
  set('status', patch.status);
  if (patch.evidenceRefs !== undefined) {
    cols.push(`evidence_refs = $${vals.length + 1}`);
    vals.push(JSON.stringify(patch.evidenceRefs));
  }
  if (patch.toolCalls !== undefined) {
    cols.push(`tool_calls = $${vals.length + 1}`);
    vals.push(JSON.stringify(patch.toolCalls));
  }
  set('retry_count', patch.retryCount);
  cols.push(`updated_at = NOW()`);
  const res = await query(`UPDATE agent_runs SET ${cols.join(', ')} WHERE id = $${vals.length + 1} RETURNING *`, [...vals, runId]);
  return res.rows[0];
}

// ---------- 1. Company Knowledge Ingestion (RAG) ----------

const EXTRACTION_SYSTEM_PROMPT = `You are a B2B Sales Intelligence Knowledge Extraction Agent. Analyze the provided company text and extract factual grounding data for downstream sales automation.
STRICT RULES:
- Use ONLY facts explicitly present in the text. Never invent, guess, or hallucinate facts, names, URLs, or metrics.
- For a category with no evidence in the text, return an empty array [].
- Keep list items short (1-2 phrases each), extracted verbatim where possible.
- "summary": a 2-3 sentence factual overview based only on the text.
- "tagline": the company's actual tagline if present in the text, otherwise an empty string.
Return strict JSON (no markdown fences):
{
  "summary": "...",
  "tagline": "...",
  "offerings": ["core capabilities or services offered"],
  "targetIndustries": ["target market verticals"],
  "caseStudies": ["tangible value proof points or metrics"],
  "pricing": ["pricing models or starting tiers"],
  "techStack": ["tools, APIs, and protocols"],
  "limitations": ["prerequisites, boundary conditions, or constraints"]
}`;

const SIMPLE_EXTRACTION_PROMPT = `You are a sales intelligence extraction agent. From the company text below, extract ONLY facts present in it into JSON with keys: summary, tagline, offerings, targetIndustries, caseStudies, pricing, techStack, limitations (all arrays of strings, empty [] if no evidence). Never invent facts. Return strict JSON only.`;

export function normalizeExtractedArrays(value: any): string[] {
  return Array.isArray(value) ? value.filter((x: any) => typeof x === 'string' && x.trim().length > 0).map((x: string) => x.trim()) : [];
}

function splitExtractionSegments(rawText: string, maxLen = 12000): string[] {
  const text = rawText.trim();
  if (!text) return [];
  if (text.length <= maxLen) return [text];

  const segments: string[] = [];
  const parts = text.split(/\n{2,}/);
  let current = '';
  for (const part of parts) {
    if (current.length > 0 && current.length + part.length + 2 > maxLen) {
      segments.push(current);
      current = part;
    } else {
      current = current ? `${current}\n\n${part}` : part;
    }
  }
  if (current.length > 0) segments.push(current);

  return segments.flatMap((s) => {
    if (s.length <= maxLen) return [s];
    const out: string[] = [];
    for (let i = 0; i < s.length; i += maxLen) out.push(s.slice(i, i + maxLen));
    return out;
  });
}

function mergeExtractedParts(parts: any[], name: string): any {
  const merged: any = {
    summary: '',
    tagline: '',
    offerings: [],
    targetIndustries: [],
    caseStudies: [],
    pricing: [],
    techStack: [],
    limitations: []
  };
  for (const p of parts) {
    if (!p) continue;
    if (!merged.summary && typeof p.summary === 'string' && p.summary.trim()) merged.summary = p.summary.trim();
    if (!merged.tagline && typeof p.tagline === 'string' && p.tagline.trim()) merged.tagline = p.tagline.trim();
    for (const key of ['offerings', 'targetIndustries', 'caseStudies', 'pricing', 'techStack', 'limitations']) {
      merged[key] = merged[key].concat(normalizeExtractedArrays(p[key]));
    }
  }
  for (const key of ['offerings', 'targetIndustries', 'caseStudies', 'pricing', 'techStack', 'limitations']) {
    const seen = new Set<string>();
    merged[key] = merged[key]
      .filter((item: string) => {
        const k = item.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 12);
  }
  if (!merged.summary) merged.summary = `${name} — company knowledge source processed.`;
  return merged;
}

function fallbackExtracted(name: string, rawText: string): any {
  const sentences = rawText.split('.').filter((s: string) => s.trim().length > 0);
  return {
    summary:
      sentences.length > 0 ? sentences.slice(0, 2).join('. ') + '.' : `${name} — company knowledge source processed.`,
    tagline: name,
    offerings: [],
    targetIndustries: [],
    caseStudies: [],
    pricing: [],
    techStack: [],
    limitations: []
  };
}

export async function extractCompanyStructured(name: string, rawText: string, timeoutMs = 45000) {
  const segments = splitExtractionSegments(rawText);
  const parts: any[] = [];

  for (const segment of segments) {
    let extracted = await executeLLM(
      EXTRACTION_SYSTEM_PROMPT,
      `Company Name: ${name}\nCompany Profile:\n${segment}`,
      true,
      timeoutMs
    );
    if (!extracted || !extracted.offerings) {
      extracted = await executeLLM(
        SIMPLE_EXTRACTION_PROMPT,
        `Company Name: ${name}\nCompany Profile:\n${segment}`,
        true,
        timeoutMs
      );
    }
    if (extracted && extracted.offerings) parts.push(extracted);
  }

  if (parts.length === 0) return fallbackExtracted(name, rawText);
  return mergeExtractedParts(parts, name);
}

export async function ingestCompanyKnowledge(
  name: string,
  rawText: string,
  sourceType: 'PDF' | 'TEXT',
  workspaceId: string,
  meta?: { page?: number; section?: string; heading?: string }
) {
  const extracted = await extractCompanyStructured(name, rawText);

  const offerings = Array.isArray(extracted.offerings) ? extracted.offerings : [];
  const result = await query(
    `INSERT INTO company_profiles (name, tagline, summary, offerings, target_industries, case_studies, pricing, tech_stack, limitations, source_type, source_text, workspace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
    [
      name,
      extracted.tagline || `${name} Platform`,
      extracted.summary,
      JSON.stringify(offerings),
      JSON.stringify(extracted.targetIndustries || []),
      JSON.stringify(extracted.caseStudies || []),
      JSON.stringify(extracted.pricing || []),
      JSON.stringify(extracted.techStack || []),
      JSON.stringify(extracted.limitations || []),
      sourceType,
      rawText,
      workspaceId
    ]
  );

  const profile = result.rows[0];

  // Semantic chunking: one chunk per offering + one per knowledge category, embedded.
  const chunkSources: Array<{ title: string; content: string; category: string; section?: string }> = [
    ...offerings.map((o: string) => ({
      title: `Capability: ${o}`,
      content: `${name} provides ${o}.`,
      category: 'offering'
    })),
    ...(extracted.targetIndustries || []).map((ind: string) => ({
      title: `Target Industry: ${ind}`,
      content: `${name} serves the ${ind} vertical.`,
      category: 'industry'
    })),
    ...(extracted.caseStudies || []).map((cs: string) => ({
      title: `Case Study`,
      content: cs,
      category: 'case_study'
    })),
    ...(extracted.pricing || []).map((p: string) => ({
      title: `Pricing`,
      content: p,
      category: 'pricing'
    })),
    ...(extracted.techStack || []).map((t: string) => ({
      title: `Technology`,
      content: t,
      category: 'tech'
    })),
    ...(extracted.limitations || []).map((l: string) => ({
      title: `Limitation`,
      content: l,
      category: 'limitation'
    }))
  ];

  let chunkCount = 0;
  for (let i = 0; i < chunkSources.length; i++) {
    const c = chunkSources[i];
    const embedding = JSON.stringify(embedText(c.content));
    await query(
      `INSERT INTO knowledge_chunks (company_profile_id, title, content, category, page, section, heading, chunk_index, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [profile.id, c.title, c.content, c.category, meta?.page || null, meta?.section || c.section || null, meta?.heading || null, i, embedding]
    );
    chunkCount++;
  }

  // Persist document record (upload tracking / versioning)
  await query(
    `INSERT INTO company_documents (workspace_id, company_profile_id, filename, mime_type, size_bytes, status, chunk_count, version)
     VALUES ($1, $2, $3, $4, $5, 'indexed', $6, 1)`,
    [workspaceId, profile.id, sourceType === 'PDF' ? `${name}.pdf` : 'manual-text.txt', sourceType === 'PDF' ? 'application/pdf' : 'text/plain', rawText.length, chunkCount]
  );

  await logActivity({
    agent: 'Company Intelligence',
    step: sourceType === 'PDF' ? 'PDF Extraction & Chunking' : 'Text Ingestion',
    tool: 'ingest_company_knowledge()',
    inputData: `name=${name}, len=${rawText.length}`,
    outputData: `profile_id=${profile.id}, chunks=${chunkCount}`,
    decision: `Indexed ${chunkCount} knowledge chunks grounded in ${sourceType} source.`,
    workspaceId
  });

  return { ...profile, chunk_count: chunkCount };
}

export async function ensureDemoCompanyKnowledge(workspaceId: string) {
  const existing = await getLatestProfile(workspaceId);
  if (existing) return existing;
  const demoText = `FlyRank is an all-in-one platform for organic and AI search growth. It automates keyword discovery, AI content production, publishing, instant Google indexation, and technical SEO audits. Core offerings include Generative Engine Optimization (GEO/AEO), schema markup, and llms.txt configurations so brands get cited by ChatGPT, Perplexity, Gemini, and Claude. Pricing starts at $1,499/mo. Target customers are B2B SaaS, ecommerce, and agencies that rely on AI search visibility. Limitations: requires live brand content and search console access.`;
  return ingestCompanyKnowledge('FlyRank', demoText, 'TEXT', workspaceId);
}

// ---------- 2. ICP ----------

export async function createIcp(data: any, workspaceId: string) {
  const location = (data.location || 'United States').trim();
  const industry = (data.industry || 'Logistics & Supply Chain').trim();
  const companySize = (data.companySize || '50-500 employees').trim();
  const targetProblem = (data.targetProblem || 'High volume customer support backlogs').trim();
  const exclusions = (data.exclusions || '').trim() || null;
  const preferredService = (data.preferredService || '').trim() || null;

  const normalizedPrompt = `${location} • ${industry} • ${companySize} • ${targetProblem}`;

  const result = await query(
    `INSERT INTO icps (location, industry, company_size, target_problem, exclusions, normalized_prompt, qualification_rules, workspace_id, focus_type, focus)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [
      location,
      industry,
      companySize,
      targetProblem,
      exclusions,
      normalizedPrompt,
      JSON.stringify({ minEmployees: parseSizeEmployees(companySize) || 10, requiredMarket: location }),
      workspaceId,
      preferredService ? 'Service' : null,
      preferredService
    ]
  );

  await logActivity({
    agent: 'ICP',
    step: 'Target Normalization',
    tool: 'save_icp_criteria()',
    decision: `Normalized ICP: ${normalizedPrompt}`,
    workspaceId
  });

  return result.rows[0];
}

// ---------- 3. Discovery + Cheap Filtering ----------

interface Candidate {
  name: string;
  website: string;
  industry: string;
  location: string;
  size: string;
  problemHint?: string;
}

function demoCandidates(icp: any): Candidate[] {
  const loc = (icp.location || '').toLowerCase();
  const ind = (icp.industry || '').toLowerCase();
  const size = icp.company_size || '100 employees';
  const isPak = loc.includes('pak');
  const isHosp = ind.includes('hosp') || ind.includes('health') || ind.includes('clinic');

  if (isPak && isHosp) {
    return [
      { name: 'The Aga Khan University Hospital', website: 'https://www.aku.edu', industry: 'Healthcare & Hospital', location: icp.location, size: '5,000+ employees' },
      { name: 'Shaukat Khanum Memorial Hospital', website: 'https://shaukatkhanum.org.pk', industry: 'Healthcare & Hospital', location: icp.location, size: '2,000+ employees' },
      { name: 'Indus Hospital Network', website: 'https://indushospital.org.pk', industry: 'Healthcare & Hospital', location: icp.location, size: '1,500+ employees' },
      { name: `${icp.location} Corner Bakery & Sweets`, website: 'https://cornerbakery.example', industry: 'Retail Bakery', location: icp.location, size: '4 employees' }
    ];
  }
  return [
    { name: `Apex ${icp.industry} Group`, website: 'https://apex.example.com', industry: icp.industry, location: icp.location, size },
    { name: `National ${icp.industry} Network`, website: 'https://national.example.com', industry: icp.industry, location: icp.location, size },
    { name: `${icp.location} Premier ${icp.industry} Co`, website: 'https://premier.example.com', industry: icp.industry, location: icp.location, size },
    { name: `${icp.location} Corner Cafe & Store`, website: 'https://cornercafe.example.com', industry: 'Retail Store', location: icp.location, size: '3 employees' }
  ];
}

function cheapFilter(item: Candidate, icp: any): { passed: boolean; score: number; reason: string } {
  const icpSize = parseSizeEmployees(icp.company_size);
  const itemSize = parseSizeEmployees(item.size);
  const icpInd = (icp.industry || '').toLowerCase();
  const itemInd = (item.industry || '').toLowerCase();

  const reasons: string[] = [];

  // Location check
  const locMatch = (item.location || '').toLowerCase().includes((icp.location || '').toLowerCase()) ||
    (icp.location || '').toLowerCase().includes((item.location || '').toLowerCase());
  if (!locMatch) reasons.push(`Location mismatch (target ${icp.location})`);

  // Industry check
  const indMatch = itemInd.includes(icpInd) || icpInd.includes(itemInd);
  if (!indMatch) reasons.push(`Industry mismatch (target ${icp.industry})`);

  // Size check (cheap)
  if (icpSize && itemSize !== null && itemSize < Math.max(1, Math.floor(icpSize * 0.3))) {
    reasons.push(`Team size ${item.size} is below ICP scale (${icp.company_size})`);
  }

  if (reasons.length > 0) {
    return { passed: false, score: Math.max(5, 10 + reasons.length * 5), reason: `Cheap Filter Rejection: ${reasons.join('; ')}.` };
  }

  return {
    passed: true,
    score: 60,
    reason: `Passed Cheap Filtering: meets ${icp.location} ${icp.industry} ICP criteria. Queued for Deep Research.`
  };
}

export async function discoverAndFilterLeads(icpId: string | null, workspaceId: string, forceDemo = false) {
  const icpRes = icpId
    ? await query(`SELECT * FROM icps WHERE id = $1 AND workspace_id = $2`, [icpId, workspaceId])
    : { rows: [] };
  const icp = icpRes.rows[0] || {
    location: 'United States',
    industry: 'Logistics & Supply Chain',
    company_size: '50-500 employees',
    target_problem: 'High volume customer support backlogs'
  };

  const run = await startAgentRun({ workspaceId, workflow: 'lead-discovery', currentState: 'searching', inputSnapshot: { icpId, icp } });

  let candidates: Candidate[] = [];
  let source = 'none';

  // Real search when a provider is configured and we are not in demo mode
  const useSearch = search.hasProvider && !isDemoMode() && !forceDemo;
  if (useSearch) {
    const q = `${icp.industry} companies in ${icp.location}`;
    const results = await webSearch(q, 8);
    if (results && results.length > 0) {
      source = 'web-search';
      candidates = results.map((r) => ({
        name: r.title,
        website: r.url,
        industry: icp.industry,
        location: icp.location,
        size: 'Unknown'
      }));
    }
  }

  // Controlled, clearly-labeled demo fallback. When no web-search provider is
  // configured this is the only available source; every row is tagged so the
  // UI can surface a "Demo dataset" badge (never silently fabricates).
  if (candidates.length === 0) {
    candidates = demoCandidates(icp);
    source = 'demo';
  }

  const leads = [];
  let passed = 0;
  let rejected = 0;

  for (const item of candidates) {
    const verdict = cheapFilter(item, icp);
    const stage = verdict.passed ? 'Potential' : 'Not Qualified';
    const lead = await query(
      `INSERT INTO leads (icp_id, name, website, industry, location, size, stage, confidence_score, score_explanation, do_not_contact, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10) RETURNING *`,
      [icpId, item.name, item.website, item.industry, item.location, item.size, stage, verdict.score, verdict.reason, workspaceId]
    );
    const row = lead.rows[0];
    if (verdict.passed) passed++;
    else rejected++;
    leads.push({ ...row, _source: source });
  }

  await updateAgentRun(run.id, {
    currentState: 'filtered',
    decision: `Evaluated ${candidates.length} candidates (${source}): ${rejected} rejected cheaply, ${passed} queued for deep research.`,
    status: 'completed',
    retryCount: 0
  });

  await logActivity({
    agent: 'Lead Discovery',
    step: 'Candidate Sourcing & Cheap Filter',
    tool: 'search_web_accounts()',
    inputData: `icp=${icp.industry} in ${icp.location}`,
    outputData: `candidates=${candidates.length}, passed=${passed}, rejected=${rejected}`,
    decision: `Sourced ${candidates.length} candidates (${source === 'demo' ? 'DEMO dataset' : 'web search'}). Rejected ${rejected} unfit accounts cheaply; queued ${passed}.`,
    workspaceId
  });

  return { leads, candidatesCount: candidates.length, passed, rejected, source };
}

// ---------- 4. Deep Research + Qualification ----------

function demoEvidence(lead: any): Array<{ source_type: string; title: string; snippet: string; confidence: string; url: string }> {
  const slug = (lead.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return [
    {
      source_type: 'news',
      title: `Demo: Operational expansion signal for ${lead.name}`,
      snippet: `${lead.name} (${lead.industry}) is scaling operations in ${lead.location}, increasing daily inquiry and coordination volume.`,
      confidence: 'Medium',
      url: lead.website || ''
    },
    {
      source_type: 'tech',
      title: `Demo: Technology footprint for ${lead.name}`,
      snippet: 'Public footprint shows CRM and portal infrastructure but no automated 24/7 inquiry triage detected.',
      confidence: 'Medium',
      url: ''
    },
    {
      source_type: 'website',
      title: `Demo: Careers signal for ${lead.name}`,
      snippet: 'Actively hiring front-desk and support coordinators to handle communication queues.',
      confidence: 'Medium',
      url: lead.website || ''
    }
  ];
}

function computeQualification(lead: any, icp: any, evidenceRows: any[], serviceScore: number): { score: number; factors: Record<string, string> } {
  let score = 0;
  const factors: Record<string, string> = {};

  // ICP fit
  const indMatch = (lead.industry || '').toLowerCase().includes((icp.industry || '').toLowerCase()) ||
    (icp.industry || '').toLowerCase().includes((lead.industry || '').toLowerCase());
  const locMatch = (lead.location || '').toLowerCase().includes((icp.location || '').toLowerCase()) ||
    (icp.location || '').toLowerCase().includes((lead.location || '').toLowerCase());
  let icpFit = 0;
  if (indMatch) icpFit += 7;
  if (locMatch) icpFit += 8;
  factors['ICP Fit'] = indMatch && locMatch ? 'Strong' : indMatch ? 'Partial' : 'Weak';
  score += icpFit;

  // Evidence quality
  const realEvs = evidenceRows.filter((e) => !e.relevance || e.relevance !== 'demo-not-found');
  let evScore = 0;
  if (realEvs.length === 0) {
    factors['Evidence Quality'] = 'Low';
  } else {
    for (const ev of realEvs) {
      if (ev.confidence === 'High') evScore += 10;
      else if (ev.confidence === 'Medium') evScore += 6;
      else evScore += 3;
    }
    evScore = Math.min(20, evScore);
    factors['Evidence Quality'] = evScore >= 16 ? 'High' : evScore >= 8 ? 'Medium' : 'Low';
  }
  score += evScore;

  // Buying signals
  const signals = evidenceRows.map((e) => (e.title + ' ' + e.snippet).toLowerCase());
  const joined = signals.join(' ');
  let signalScore = 0;
  if (/hiring|careers|recruit|expand|growth|scal/i.test(joined)) signalScore += 10;
  if (/inquir|support|volume|backlog|queue|contact/i.test(joined)) signalScore += 8;
  factors['Buying Signals'] = signalScore >= 10 ? 'Recent Growth' : signalScore >= 5 ? 'Operational Volume' : 'Limited';
  score += signalScore;

  // Service fit (RAG retrieval score 0..1 -> 0..15)
  const serviceFit = Math.round(Math.max(0, Math.min(1, serviceScore)) * 15);
  factors['Service Fit'] = serviceFit >= 12 ? 'Very Strong' : serviceFit >= 8 ? 'Strong' : serviceFit >= 4 ? 'Medium' : 'Weak';
  score += serviceFit;

  // Problem fit: ICP problem keywords present in evidence
  const problemWords = (icp.target_problem || '').toLowerCase().split(/\s+/).filter((w: string) => w.length > 3);
  const problemHits = problemWords.filter((w: string) => joined.includes(w)).length;
  const problemFit = problemHits >= 2 ? 12 : problemHits >= 1 ? 7 : 3;
  factors['Problem Fit'] = problemHits >= 2 ? 'Strong' : problemHits >= 1 ? 'Partial' : 'Assumed';
  score += problemFit;

  // Size
  const icpSize = parseSizeEmployees(icp.company_size);
  const leadSize = parseSizeEmployees(lead.size);
  if (icpSize && leadSize && leadSize >= Math.max(1, Math.floor(icpSize * 0.3))) {
    factors['Company Size'] = 'In Range';
    score += 8;
  } else if (lead.size === 'Unknown' || !leadSize) {
    factors['Company Size'] = 'Unknown';
    score += 4;
  } else {
    factors['Company Size'] = 'Below Target';
    score += 2;
  }

  // Location
  factors['Location'] = locMatch ? lead.location || icp.location : 'Out of Target';
  if (locMatch) score += 5;

  return { score: Math.min(99, Math.round(score)), factors };
}

export async function performDeepResearchAndQualification(leadId: string, workspaceId: string, forceDemo = false) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');
  if (lead.stage === 'Not Qualified' || lead.stage === 'Do Not Contact') return lead;

  const icpRes = lead.icp_id
    ? await query(`SELECT * FROM icps WHERE id = $1`, [lead.icp_id])
    : { rows: [] };
  const icp = icpRes.rows[0] || { industry: lead.industry, location: lead.location, company_size: lead.size, target_problem: 'Support backlogs' };

  const run = await startAgentRun({ workspaceId, leadId, workflow: 'deep-research', currentState: 'researching', inputSnapshot: { leadId } });

  // Stage transition: Potential -> Researching
  if (lead.stage === 'Potential' || lead.stage === 'Discovered') {
    await movePipelineStage(leadId, 'Researching', 'Deep research in progress', workspaceId, lead.confidence_score);
  }

  let evidenceRows: any[] = [];

  if (isDemoMode() || forceDemo || !search.hasProvider) {
    const demo = demoEvidence(lead);
    for (const ev of demo) {
      await query(
        `INSERT INTO research_evidences (lead_id, workspace_id, source_type, source_url, title, snippet, confidence, relevance, retrieved_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'demo', NOW())`,
        [leadId, workspaceId, ev.source_type, ev.url, ev.title, ev.snippet, ev.confidence]
      );
    }
    evidenceRows = demo;
  } else if (search.hasProvider) {
    const queries = [`${lead.name} company news`, `${lead.name} hiring`, `${lead.name} technology`, `${lead.name} funding`];
    for (const q of queries) {
      const results = await webSearch(q, 3);
      if (results && results.length > 0) {
        for (const r of results.slice(0, 2)) {
          await query(
            `INSERT INTO research_evidences (lead_id, workspace_id, source_type, source_url, title, snippet, confidence, relevance, retrieved_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'web', NOW())`,
            [leadId, workspaceId, 'web', r.url, r.title, r.snippet, 'High', r.url]
          );
          evidenceRows.push({ source_type: 'web', url: r.url, title: r.title, snippet: r.snippet, confidence: 'High' });
        }
      }
    }
    if (evidenceRows.length === 0) {
      await query(
        `INSERT INTO research_evidences (lead_id, workspace_id, source_type, source_url, title, snippet, confidence, relevance, retrieved_at)
         VALUES ($1, $2, 'web', '', 'No reliable evidence found', 'No reliable web evidence found for this organization.', 'Low', 'web-not-found', NOW())`,
        [leadId, workspaceId]
      );
      evidenceRows = [{ title: 'No reliable evidence found', snippet: 'No reliable web evidence found for this organization.', confidence: 'Low' }];
    }
  } else {
    await query(
      `INSERT INTO research_evidences (lead_id, workspace_id, source_type, source_url, title, snippet, confidence, relevance, retrieved_at)
       VALUES ($1, $2, 'web', '', 'No reliable evidence found', 'No web research provider configured. Evidence unavailable.', 'Low', 'web-not-found', NOW())`,
      [leadId, workspaceId]
    );
    evidenceRows = [{ title: 'No reliable evidence found', snippet: 'No web research provider configured. Evidence unavailable.', confidence: 'Low' }];
  }

  // Service matching grounded in RAG
  const profile = await getLatestProfile(workspaceId);
  let serviceMatchScore = 0;
  let recommendedService = null;
  let serviceRationale = 'No capability evidence available.';
  let topChunks: any[] = [];

  if (profile) {
    const problemQuery = `${icp.target_problem} ${lead.industry} support automation`;
    topChunks = rankChunksForService(await retrieveChunks(profile.id, problemQuery, 8), problemQuery);
    if (topChunks.length > 0) {
      const chosen = bestServiceChunk(topChunks, problemQuery) || topChunks[0];
      serviceMatchScore = Math.min(1, weightedServiceScore(chosen, problemQuery));
      recommendedService = serviceLabel(chosen.title);
      const matches = topChunks.filter((c) => weightedServiceScore(c, problemQuery) > 0.12);
      serviceRationale = matches
        .slice(0, 3)
        .map((c) => `${c.title} — ${c.content}`)
        .join(' | ') || `Matched "${recommendedService}" from company knowledge.`;
    }
  }

  const qualification = computeQualification(lead, icp, evidenceRows, serviceMatchScore);

  // LLM explains the decision (score stays deterministic)
  let explanation = '';
  const factorText = Object.entries(qualification.factors).map(([k, v]) => `${k}: ${v}`).join('\n');
  if (qualification.score >= 40) {
    const llmText = await executeLLM(
      'You are an explainable sales qualification analyst. Explain WHY this lead scored as it did using ONLY the provided factors. Be concise, no fabrication.',
      `Organization: ${lead.name} (${lead.industry}, ${lead.location}, ${lead.size})\nScore: ${qualification.score}%\nFactors:\n${factorText}`,
      false
    );
    explanation = llmText || `Deterministic score ${qualification.score}%. Factors: ${factorText.replace(/\n/g, '; ')}.`;
  }

  const finalStage = qualification.score >= 40 ? 'Qualified' : 'Not Qualified';
  const updatedLead = await query(
    `UPDATE leads SET stage = $1, confidence_score = $2, score_explanation = $3, recommended_service = $4, service_rationale = $5, updated_at = NOW()
     WHERE id = $6 RETURNING *`,
    [finalStage, qualification.score, explanation || factorText, recommendedService, serviceRationale, leadId]
  );

  await query(
    `INSERT INTO memories (lead_id, type, category, content)
     VALUES ($1, 'short_term', 'agent_decision', $2)`,
    [leadId, `Deep research completed. Lead ${finalStage} at ${qualification.score}%. Matched service: ${recommendedService || 'none'}.`]
  );

  // Persist service match record
  await query(
    `INSERT INTO service_matches (workspace_id, lead_id, service, problem, why_fits, company_evidence, capability_evidence, confidence, alternatives, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'recommended')`,
    [
      workspaceId,
      leadId,
      recommendedService || 'Not identified',
      icp.target_problem,
      serviceRationale,
      JSON.stringify(evidenceRows.slice(0, 3)),
      JSON.stringify(topChunks.slice(0, 3).map((c) => ({ title: c.title, content: c.content, page: c.page, section: c.section }))),
      qualification.score,
      JSON.stringify(topChunks.slice(1, 3).map((c) => serviceLabel(c.title)))
    ]
  );

  await movePipelineStage(leadId, finalStage, `Qualification: ${qualification.score}% (${Object.entries(qualification.factors).filter(([, v]) => v === 'Strong' || v === 'Very Strong').length} strong factors)`, workspaceId, qualification.score);

  await updateAgentRun(run.id, {
    currentState: 'qualified',
    decision: `Qualified at ${qualification.score}%. Service: ${recommendedService || 'none'}.`,
    confidence: qualification.score,
    nextAction: finalStage === 'Qualified' ? 'Identify decision maker and draft outreach' : 'No outreach — lead rejected',
    evidenceRefs: evidenceRows.slice(0, 5).map((e) => e.title),
    toolCalls: ['web_search', 'vector_retrieval'],
    status: 'completed'
  });

  await logActivity({
    agent: 'Deep Research',
    step: 'Signal Extraction',
    tool: 'research_company_signals()',
    inputData: `lead=${lead.name}`,
    outputData: `evidence=${evidenceRows.length}, service=${recommendedService || 'none'}`,
    decision: `Collected ${evidenceRows.length} evidence items.`,
    workspaceId,
    leadId
  });
  await logActivity({
    agent: 'Qualification',
    step: 'Explainable Lead Scoring',
    tool: 'score_lead_confidence()',
    inputData: `factors=${factorText}`,
    outputData: `score=${qualification.score}%`,
    decision: `Lead ${finalStage} at ${qualification.score}% — ${Object.entries(qualification.factors).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
    workspaceId,
    leadId
  });

  return { lead: updatedLead.rows[0], factors: qualification.factors, serviceMatch: topChunks.slice(0, 1)[0] || null };
}

// ---------- 5. Service Matching ----------

export async function matchService(leadId: string, workspaceId: string) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');

  const icpRes = lead.icp_id ? await query(`SELECT * FROM icps WHERE id = $1`, [lead.icp_id]) : { rows: [] };
  const icp = icpRes.rows[0] || { target_problem: 'Support backlogs', industry: lead.industry };

  const profile = await getLatestProfile(workspaceId);
  if (!profile) return { match: null, reason: 'No company knowledge ingested.' };

  const problemQuery = `${icp.target_problem} ${lead.industry} automation`;
  const rawChunks = await retrieveChunks(profile.id, problemQuery, 8);
  if (rawChunks.length === 0) {
    return { match: null, reason: 'No reliable capability evidence found in company knowledge.' };
  }
  const topChunks = rankChunksForService(rawChunks, problemQuery);
  const chosen = bestServiceChunk(rawChunks, problemQuery) || topChunks[0];

  const service = serviceLabel(chosen.title);
  const alternatives = topChunks.filter((c) => c.id !== chosen.id).slice(0, 2).map((c) => serviceLabel(c.title));
  const confidence = Math.min(98, Math.round(55 + Math.min(1, weightedServiceScore(chosen, problemQuery)) * 40));

  const match = await query(
    `INSERT INTO service_matches (workspace_id, lead_id, service, problem, why_fits, company_evidence, capability_evidence, confidence, alternatives, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'recommended') RETURNING *`,
    [
      workspaceId,
      leadId,
      service,
      icp.target_problem,
      chosen.content,
      JSON.stringify([]),
      JSON.stringify(topChunks.slice(0, 3).map((c) => ({ title: c.title, content: c.content, page: c.page, section: c.section, heading: c.heading }))),
      confidence,
      JSON.stringify(alternatives)
    ]
  );

  await logActivity({
    agent: 'Service Matching',
    step: 'RAG Capability Retrieval',
    tool: 'match_service_from_knowledge()',
    inputData: `problem=${icp.target_problem}`,
    outputData: `service=${service} (${confidence}%)`,
    decision: `Matched "${service}" grounded in company knowledge.`,
    workspaceId,
    leadId
  });

  return { match: match.rows[0] };
}

// ---------- 6. Decision Makers ----------

export async function identifyDecisionMakers(leadId: string, workspaceId: string, forceDemo = false) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');

  const existing = await query(`SELECT * FROM contacts WHERE lead_id = $1`, [leadId]);
  if (existing.rows.length > 0) {
    return existing.rows;
  }

  let contact = null;
  if (isDemoMode() || forceDemo || !search.hasProvider) {
    const isPak = (lead.location || '').toLowerCase().includes('pak');
    const name = isPak ? 'Dr. Tariq Mansoor' : 'Marcus Vance';
    const slug = (lead.name || 'prospect').toLowerCase().replace(/[^a-z0-9]/g, '');
    contact = { name, role: 'Head of Operations & Support', email: `operations@${slug}.demo`, phone: 'Not found', confidence: 'Medium' };
  } else if (search.hasProvider) {
    const results = await webSearch(`${lead.name} head of operations OR CTO OR CEO contact`, 5);
    if (results && results.length > 0) {
      contact = { name: 'Not found', role: 'Not found', email: 'Not found', phone: 'Not found', confidence: 'Low' };
    }
  }

  if (contact) {
    const ins = await query(
      `INSERT INTO contacts (lead_id, name, role, relevance, email, phone, confidence)
       VALUES ($1, $2, $3, 'High', $4, $5, $6) RETURNING *`,
      [leadId, contact.name, contact.role, contact.email, contact.phone, contact.confidence]
    );
    return [ins.rows[0]];
  }

  return [];
}

// ---------- 7. Outreach ----------

const rateLimits: Record<string, number[]> = {};

function checkRateLimit(workspaceId: string): { ok: boolean; reason?: string } {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const arr = (rateLimits[workspaceId] || []).filter((t) => now - t < windowMs);
  if (arr.length >= 20) {
    return { ok: false, reason: 'Rate limit exceeded (20 emails/hour/workspace).' };
  }
  rateLimits[workspaceId] = arr;
  return { ok: true };
}

function recordRateLimit(workspaceId: string) {
  rateLimits[workspaceId] = (rateLimits[workspaceId] || []).concat(Date.now());
}

export async function generateOutreachDraft(leadId: string, contactId: string | null, workspaceId: string) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');

  const contactRes = contactId
    ? await query(`SELECT * FROM contacts WHERE id = $1 AND lead_id = $2`, [contactId, leadId])
    : await query(`SELECT * FROM contacts WHERE lead_id = $1 ORDER BY relevance DESC LIMIT 1`, [leadId]);
  const contact = contactRes.rows[0];

  const evRes = await query(`SELECT * FROM research_evidences WHERE lead_id = $1`, [leadId]);
  const evidences = evRes.rows;
  const profile = await getLatestProfile(workspaceId);
  const settings = await getWorkspaceSettings(workspaceId);

  const meeting = await createMeetingLink({ subject: `Intro: ${lead.recommended_service || 'AI Automation'} for ${lead.name}`, when: new Date() });
  const bookingLine = meeting.link ? `\n\nGrab a slot directly here: ${meeting.link}` : '';

  let body = '';
  if (contact && lead.recommended_service) {
    const prompt = `Write a personalized, concise 3-4 sentence cold email (plain text) from ${profile?.name || 'our company'} to ${contact.name} (${contact.role} at ${lead.name} in ${lead.location}).
Observed signals (use only these): ${evidences.slice(0, 3).map((e) => e.snippet).join(' ')}
Service: ${lead.recommended_service} — ${lead.service_rationale || ''}
${meeting.link ? `Include this booking link: ${meeting.link}` : 'No booking link is available yet — do not invent one.'}
Do not fabricate facts.`;
    const llmText = await executeLLM('You are an expert sales copywriter. Return only the email body.', prompt, false);
    body = llmText || '';
  }

  if (!body) {
    body = `Hi ${contact?.name || 'there'},\n\nI noticed ${lead.name} is scaling operations in ${lead.location}, increasing the inquiry and coordination load on your support team.\n\nWe help teams like yours automate routine inquiry triage with ${lead.recommended_service || 'AI support automation'} — no extra headcount.\n\nWould you be open to a 10-minute walkthrough?${bookingLine}\n\nBest regards,\n${profile?.name || 'Our team'}`;
  }

  const existingDraft = await query(
    `SELECT * FROM messages WHERE lead_id = $1 AND direction = 'outbound' AND status = 'draft' ORDER BY created_at DESC LIMIT 1`,
    [leadId]
  );

  const subject = `Automating inquiry triage for ${lead.name}`;
  const evidenceUsed = JSON.stringify(evidences.slice(0, 4).map((e) => ({ title: e.title, snippet: e.snippet, url: e.source_url })));

  let message;
  if (existingDraft.rows.length > 0) {
    message = (
      await query(
        `UPDATE messages SET subject = $1, body = $2, contact_id = $3, evidence_used = $4, next_action = $5 WHERE id = $6 RETURNING *`,
        [subject, body, contact?.id || null, evidenceUsed, 'Awaiting approval to send.', existingDraft.rows[0].id]
      )
    ).rows[0];
  } else {
    message = (
      await query(
        `INSERT INTO messages (lead_id, contact_id, workspace_id, direction, channel, subject, body, status, next_action, evidence_used, sender)
         VALUES ($1, $2, $3, 'outbound', 'email', $4, $5, 'draft', 'Awaiting approval to send.', $6, $7) RETURNING *`,
        [leadId, contact?.id || null, workspaceId, subject, body, evidenceUsed, profile?.name || 'AgentHack Sales']
      )
    ).rows[0];
  }

  await logActivity({
    agent: 'Outreach',
    step: 'Evidence-Grounded Draft',
    tool: 'draft_evidence_email()',
    inputData: `lead=${lead.name}, contact=${contact?.name || 'none'}`,
    outputData: `draft_id=${message.id}`,
    decision: `Drafted personalized outreach grounded in ${evidences.length} evidence items.`,
    workspaceId,
    leadId
  });

  return { message, contact, meetingLink: meeting.link };
}

export async function saveOutreachDraft(leadId: string, messageId: string, subject: string, body: string, workspaceId: string) {
  const msgRes = await query(`SELECT m.*, l.do_not_contact FROM messages m JOIN leads l ON l.id = m.lead_id WHERE m.id = $1 AND m.lead_id = $2`, [messageId, leadId]);
  const message = msgRes.rows[0];
  if (!message) throw new Error('Message not found');
  if (message.do_not_contact) throw new Error('BLOCKED: This lead is marked Do Not Contact.');
  if (message.status === 'sent' || message.status === 'simulated') throw new Error('Cannot edit a message that was already dispatched.');
  if (!body || body.trim().length < 10) throw new Error('Validation failed: message body is empty.');

  const updated = (
    await query(`UPDATE messages SET subject = $1, body = $2 WHERE id = $3 RETURNING *`, [subject, body, messageId])
  ).rows[0];
  await logActivity({
    agent: 'Outreach Dispatcher',
    step: 'Admin Edit',
    tool: 'save_draft()',
    inputData: `message_id=${messageId}`,
    outputData: 'draft_saved',
    decision: 'Admin edited and saved the outreach draft.',
    workspaceId,
    leadId
  });
  return updated;
}

export async function sendOutreachMessage(leadId: string, messageId: string, workspaceId: string, opts?: { subject?: string; body?: string }) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');

  // Guard: Do Not Contact
  if (lead.do_not_contact) {
    throw new Error('BLOCKED: This lead is marked Do Not Contact.');
  }

  const msgRes = await query(`SELECT * FROM messages WHERE id = $1 AND lead_id = $2`, [messageId, leadId]);
  let message = msgRes.rows[0];
  if (!message) throw new Error('Message not found');
  if (message.status === 'sent' || message.status === 'simulated') {
    return message; // idempotent: already dispatched
  }

  // Apply admin edits before dispatch so what you see is what is sent.
  if (opts && (opts.subject !== undefined || opts.body !== undefined)) {
    const subject = opts.subject !== undefined ? opts.subject : message.subject;
    const body = opts.body !== undefined ? opts.body : message.body;
    message = (
      await query(`UPDATE messages SET subject = $1, body = $2 WHERE id = $3 RETURNING *`, [subject, body, messageId])
    ).rows[0];
  }

  const contactRes = message.contact_id
    ? await query(`SELECT * FROM contacts WHERE id = $1`, [message.contact_id])
    : { rows: [] };
  const contact = contactRes.rows[0];

  // Guard: verified contact
  if (!contact || !contact.email || contact.email === 'Not found') {
    throw new Error('Cannot send: no verified contact email for this lead.');
  }

  // Guard: duplicate check (existing dispatched email to this lead)
  const dup = await query(
    `SELECT * FROM messages WHERE lead_id = $1 AND direction = 'outbound' AND channel = 'email' AND status IN ('sent','simulated') AND id <> $2 LIMIT 1`,
    [leadId, messageId]
  );
  if (dup.rows.length > 0) {
    throw new Error('Duplicate detected: outreach already dispatched to this lead.');
  }

  // Guard: rate limit
  const rl = checkRateLimit(workspaceId);
  if (!rl.ok) throw new Error(`BLOCKED: ${rl.reason}`);

  // Policy: outbound kill switch
  const settings = await getWorkspaceSettings(workspaceId);
  if (!settings.outbound_enabled) {
    throw new Error('BLOCKED: Outbound is disabled in this workspace.');
  }

  if (!message.body || message.body.trim().length < 10) {
    throw new Error('Validation failed: email content is empty.');
  }

  const sendRes = await sendEmail({ to: contact.email, subject: message.subject || '', body: message.body });

  if (sendRes.status === 'blocked') {
    throw new Error('BLOCKED: Outbound kill switch is enabled.');
  }

  if (sendRes.status === 'failed') {
    const failed = (
      await query(
        `UPDATE messages SET status = 'failed', provider_status = $1, next_action = $2 WHERE id = $3 RETURNING *`,
        [sendRes.providerStatus, `Delivery failed: ${sendRes.error || 'email provider error'}.`, messageId]
      )
    ).rows[0];
    await logActivity({
      agent: 'Outreach Dispatcher',
      step: 'Send Failure',
      tool: 'send_email()',
      inputData: `to=${contact.email}`,
      outputData: `status=failed, provider=${sendRes.providerStatus}`,
      decision: `Email provider returned an error: ${sendRes.error || 'unknown'}. No lead state change.`,
      workspaceId,
      leadId
    });
    return failed;
  }

  recordRateLimit(workspaceId);

  const finalStatus = sendRes.status === 'sent' ? 'sent' : 'simulated';
  const updated = (
    await query(
      `UPDATE messages SET status = $1, provider_status = $2, sent_at = NOW(), next_action = $3 WHERE id = $4 RETURNING *`,
      [finalStatus, sendRes.providerStatus, `Awaiting prospect response. Follow-up #2 scheduled.`, messageId]
    )
  ).rows[0];

  // Update lead state + schedule follow-up
  await movePipelineStage(leadId, 'Contacted', `Outreach ${finalStatus} to ${contact.name}.`, workspaceId, lead.confidence_score);

  const settings2 = await getWorkspaceSettings(workspaceId);
  const followUpDays = settings2.followup_day_2 ?? 3;
  const fDate = new Date();
  fDate.setDate(fDate.getDate() + followUpDays);
  await query(
    `INSERT INTO follow_up_tasks (lead_id, workspace_id, sequence_step, scheduled_for, status, next_action)
     VALUES ($1, $2, 2, $3, 'pending', $4)`,
    [leadId, workspaceId, fDate, `Follow-up Email #2: re-engage ${lead.name} with capability evidence.`]
  );

  await query(
    `UPDATE leads SET next_action = $1, next_action_at = $2, updated_at = NOW() WHERE id = $3`,
    [`Follow-up #2 due ${fDate.toLocaleDateString()}.`, fDate, leadId]
  );

  await query(
    `INSERT INTO memories (lead_id, type, category, content)
     VALUES ($1, 'long_term', 'outreach_sent', $2)`,
    [leadId, `Email #1 ${finalStatus} to ${contact.name} (${contact.email}) via ${sendRes.providerStatus}. Follow-up #2 scheduled ${fDate.toISOString()}.`]
  );

  // Extra feature (PDF §18): when the prospect has a real WhatsApp number,
  // also message the company on WhatsApp. Honest — never fires with a fake number.
  if (contact.phone && contact.phone !== 'Not found' && contact.phone.trim() !== '') {
    const waProspect = await sendWhatsApp({
      to: contact.phone,
      body: `Hello ${contact.name}, this is ${settings.name || 'our team'}. We just emailed you about ${lead.recommended_service || 'AI support automation'} for ${lead.name}. Happy to help if you have any questions.`
    });
    await query(
      `INSERT INTO memories (lead_id, type, category, content)
       VALUES ($1, 'long_term', 'whatsapp_outreach', $2)`,
      [leadId, `WhatsApp message to prospect ${contact.name} (${contact.phone}): ${waProspect.providerStatus}.`]
    );
  }

  await logActivity({
    agent: 'Outreach Dispatcher',
    step: 'Pre-Send Checklist',
    tool: 'send_email()',
    inputData: `to=${contact.email}`,
    outputData: `status=${finalStatus}, provider=${sendRes.providerStatus}`,
    decision: `Checklist passed (DNC ok, contact verified, duplicate ok, rate limit ok, policy ok). Email ${finalStatus}.`,
    workspaceId,
    leadId
  });

  return updated;
}

// ---------- 8. Response Classification ----------

export async function processInboundResponse(leadId: string, replyText: string, workspaceId: string) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');

  let classification = 'Other';
  const lower = (replyText || '').toLowerCase();

  if (/(meet|schedule|available|call|let'?s (talk|meet)|book)/i.test(lower)) classification = 'Meeting Requested';
  else if (/(not interested|unsubscribe|no thanks|don'?t contact)/i.test(lower)) classification = 'Not Interested';
  else if (/(not now|busy|later|maybe next (month|quarter)|too early)/i.test(lower)) classification = 'Not Now';
  else if (/(wrong person|refer|forward|not the right)/i.test(lower)) classification = 'Wrong Person / Referral';
  else if (/(cost|price|pricing|budget|expensive|quote)/i.test(lower)) classification = 'Pricing Objection';
  else if (/(api|security|integration|compliance|privacy|data)/i.test(lower)) classification = 'Technical Objection';
  else if (/(question|how does|does it work|details|info about|more about)/i.test(lower)) classification = 'Question';
  else if (/(interest|great|sounds good|yes|want to|like to|interested)/i.test(lower)) classification = 'Positive / Interested';

  const nextActionMap: Record<string, string> = {
    'Positive / Interested': 'Reply with capability evidence and propose a meeting.',
    'Meeting Requested': 'Check availability and finalize meeting.',
    Question: 'Answer question using grounded company knowledge.',
    'Pricing Objection': 'Send pricing packages and value case study.',
    'Technical Objection': 'Send integration/security documentation.',
    'Not Interested': 'Mark Not Interested; archive from active pipeline.',
    'Not Now': 'Pause cadence; retry in 30 days.',
    'Wrong Person / Referral': 'Request referral to the correct decision maker.',
    Other: 'Review manually.'
  };

  // Let LLM refine when available, but only for replies the deterministic
  // classifier left as "Other". Strong signals (e.g. an explicit meeting
  // request) stay authoritative so a meeting is never skipped because the
  // model softened the intent.
  if (classification === 'Other' && llmHasProvider()) {
    const llmClass = await executeLLM(
      `Classify this prospect reply into exactly one of: ${RESPONSE_CLASSES.join(', ')}. Return JSON {"classification":"...","reason":"..."}`,
      `Reply: "${replyText}"`,
      true
    );
    if (llmClass && RESPONSE_CLASSES.includes(llmClass.classification)) {
      classification = llmClass.classification;
    }
  }

  const nextAction = nextActionMap[classification] || nextActionMap.Other;
  const reason = classification === 'Other' ? 'Pattern did not match a known intent.' : `Matched "${classification}" intent from reply.`;

  const msg = (
    await query(
      `INSERT INTO messages (lead_id, workspace_id, direction, channel, body, classification, next_action, status)
       VALUES ($1, $2, 'inbound', 'email', $3, $4, $5, 'replied') RETURNING *`,
      [leadId, workspaceId, replyText, classification, nextAction]
    )
  ).rows[0];

  let meeting = null;

  switch (classification) {
    case 'Meeting Requested':
      meeting = await scheduleMeeting(leadId, workspaceId, replyText);
      break;
    case 'Not Interested':
      await movePipelineStage(leadId, 'Not Interested', `Prospect not interested: "${replyText.slice(0, 80)}"`, workspaceId, lead.confidence_score);
      await query(`UPDATE follow_up_tasks SET status = 'cancelled', cancel_reason = 'Not Interested' WHERE lead_id = $1 AND status = 'pending'`, [leadId]);
      await query(`UPDATE leads SET next_action = 'Archived: Not Interested', updated_at = NOW() WHERE id = $1`, [leadId]);
      break;
    case 'Positive / Interested':
      await movePipelineStage(leadId, 'Interested', 'Prospect expressed interest in the solution.', workspaceId, lead.confidence_score);
      await query(`UPDATE leads SET next_action = 'Reply with evidence and propose meeting.', updated_at = NOW() WHERE id = $1`, [leadId]);
      break;
    default:
      await query(`UPDATE leads SET next_action = $1, updated_at = NOW() WHERE id = $2`, [nextAction, leadId]);
      break;
  }

  await query(
    `INSERT INTO memories (lead_id, type, category, content)
     VALUES ($1, 'long_term', 'response', $2)`,
    [leadId, `Prospect replied: "${replyText.slice(0, 120)}". Classified as ${classification}. Next action: ${nextAction}.`]
  );

  await logActivity({
    agent: 'Response Classification',
    step: 'Intent Classification',
    tool: 'classify_inbound_response()',
    inputData: `reply="${replyText.slice(0, 100)}"`,
    outputData: `classification=${classification}`,
    decision: `Classified as "${classification}". Next action: ${nextAction}.`,
    workspaceId,
    leadId
  });

  return { message: msg, classification, nextAction, reason, meeting };
}

function llmHasProvider(): boolean {
  return Boolean(process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY);
}

async function scheduleMeeting(leadId: string, workspaceId: string, replyText: string) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1`, [leadId]);
  const lead = leadRes.rows[0];
  const contactRes = await query(`SELECT * FROM contacts WHERE lead_id = $1 ORDER BY relevance DESC LIMIT 1`, [leadId]);
  const contact = contactRes.rows[0] || { name: 'Not found', role: 'Not found' };

  const settings = await getWorkspaceSettings(workspaceId);
  const hour = settings.meeting_default_hour ?? 15;
  const meetTime = new Date();
  meetTime.setDate(meetTime.getDate() + 2);
  meetTime.setHours(hour, 0, 0, 0);

  const meetingLink = await createMeetingLink({ subject: `Intro: ${lead.recommended_service || 'AI Automation'} — ${lead.name}`, when: meetTime, attendeeEmail: contact.email });
  const reminderAt = new Date(meetTime.getTime() - 30 * 60000);

  // Admin notification via WhatsApp (PDF §13). Honest: sends when Twilio is
  // configured, otherwise records a clearly-labeled simulated notification.
  const waText = `📅 Meeting finalized — ${lead.name}
Contact: ${contact.name} (${contact.role})
When: ${meetTime.toISOString()}
Service: ${lead.recommended_service || 'AI Support Automation'}
Problem: ${lead.service_rationale || 'Operational communication backlog due to high inquiry volume'}
${meetingLink.link ? `Link: ${meetingLink.link}` : 'No meeting link created — calendar provider not connected.'}
Briefing: 1. Live inquiry triage walkthrough 2. Scheduling & routing automation 3. 14-day zero-risk rollout`;
  const wa = await sendWhatsApp({ to: whatsapp.adminNumber(), body: waText });

  const meetingRes = await query(
    `INSERT INTO meetings (workspace_id, lead_id, contact_id, meeting_time, meeting_link, service_to_discuss, problem_summary, objections_expected, key_discussion_points, whatsapp_notified, status, reminder_at, contact_name, contact_role, lead_score, customer_problem)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'scheduled', $11, $12, $13, $14, $15) RETURNING *`,
    [
      workspaceId,
      leadId,
      contact.id || null,
      meetTime,
      meetingLink.link,
      lead.recommended_service || 'AI Support Automation',
      lead.service_rationale || 'Operational communication backlog due to high inquiry volume',
      'Data privacy, integration feasibility, rollout timeline',
      '1. Live inquiry triage walkthrough\n2. Scheduling & routing automation\n3. 14-day zero-risk rollout',
      wa.status === 'sent',
      reminderAt,
      contact.name,
      contact.role,
      lead.confidence_score,
      lead.service_rationale || ''
    ]

  );

  await movePipelineStage(leadId, 'Meeting Scheduled', meetingLink.provider === 'NOT_CONFIGURED' ? 'Meeting finalized (calendar provider not connected).' : `Meeting finalized via ${meetingLink.provider}.`, workspaceId, lead.confidence_score);
  await query(`UPDATE follow_up_tasks SET status = 'cancelled', cancel_reason = 'Meeting scheduled' WHERE lead_id = $1 AND status = 'pending'`, [leadId]);
  await query(`UPDATE leads SET next_action = 'Attend meeting; brief admin (WhatsApp).', updated_at = NOW() WHERE id = $1`, [leadId]);

  await query(
    `INSERT INTO memories (lead_id, type, category, content)
     VALUES ($1, 'long_term', 'meeting_finalized', $2)`,
    [leadId, `Meeting finalized for ${meetTime.toISOString()} via ${meetingLink.provider}. ${meetingLink.link ? `Link: ${meetingLink.link}.` : 'Calendar provider not connected — no meeting link created.'} Reminder ${reminderAt.toISOString()}. Admin WhatsApp: ${wa.providerStatus}.`]
  );

  await logActivity({
    agent: 'Meeting Automation',
    step: 'Calendar & Admin Briefing',
    tool: 'create_meeting_briefing()',
    inputData: `when=${meetTime.toISOString()}`,
    outputData: `link=${meetingLink.link}, whatsapp=${wa.providerStatus}`,
    decision: `Meeting scheduled via ${meetingLink.provider}. 30-min reminder set. Admin notified on WhatsApp (${wa.providerStatus}).`,
    workspaceId,
    leadId
  });

  return meetingRes.rows[0];
}

// ---------- 9. Follow-Up ----------

export async function generateFollowUpEmail(leadId: string, workspaceId: string) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');
  if (lead.do_not_contact) throw new Error('BLOCKED: Do Not Contact');

  const contactRes = await query(`SELECT * FROM contacts WHERE lead_id = $1 LIMIT 1`, [leadId]);
  const contact = contactRes.rows[0] || { name: 'there' };

  const settings = await getWorkspaceSettings(workspaceId);
  if (!settings.outbound_enabled) throw new Error('BLOCKED: Outbound is disabled.');

  const body = `Hi ${contact.name},\n\nFollowing up on my previous note regarding ${lead.name}'s operational inquiry volume.\n\nHere is a quick case study showing how a peer organization automated routine inquiry triage with ${lead.recommended_service || 'AI support automation'} — no backlogs, no extra headcount.\n\nLet me know if you'd like to review the architecture.\n\nBest,\nAgentHack Sales`;

  const sendRes = await sendEmail({ to: contact.email || 'Not found', subject: `Following up: Operational triage for ${lead.name}`, body });
  if (sendRes.status === 'blocked') throw new Error('BLOCKED: Outbound kill switch is enabled.');
  const finalStatus = sendRes.status === 'sent' ? 'sent' : 'simulated';

  const msg = (
    await query(
      `INSERT INTO messages (lead_id, contact_id, workspace_id, direction, channel, subject, body, status, next_action, sender, provider_status, sent_at)
       VALUES ($1, $2, $3, 'outbound', 'email', $4, $5, $6, 'Follow-up #2 dispatched. Monitoring response.', $7, $8, NOW()) RETURNING *`,
      [leadId, contact.id || null, workspaceId, `Following up: Operational triage for ${lead.name}`, body, finalStatus, 'AgentHack Sales', sendRes.providerStatus]
    )
  ).rows[0];

  await query(`UPDATE follow_up_tasks SET status = 'completed' WHERE lead_id = $1 AND status = 'pending'`, [leadId]);
  await query(`UPDATE leads SET next_action = 'Awaiting response to follow-up #2.', updated_at = NOW() WHERE id = $1`, [leadId]);

  await logActivity({
    agent: 'Follow-Up',
    step: 'Cadence Execution',
    tool: 'send_followup_email_2()',
    inputData: `lead=${lead.name}`,
    outputData: `status=${finalStatus}`,
    decision: `Day 3 follow-up ${finalStatus}.`,
    workspaceId,
    leadId
  });

  return msg;
}

export async function pauseFollowUp(leadId: string, workspaceId: string, days: number) {
  const until = new Date();
  until.setDate(until.getDate() + days);
  const res = await query(
    `UPDATE follow_up_tasks SET status = 'paused', pause_until = $1 WHERE lead_id = $2 AND workspace_id = $3 AND status = 'pending' RETURNING *`,
    [until, leadId, workspaceId]
  );
  return res.rows;
}

export async function resumeFollowUp(leadId: string, workspaceId: string) {
  const res = await query(
    `UPDATE follow_up_tasks SET status = 'pending', pause_until = NULL WHERE lead_id = $1 AND workspace_id = $2 AND status = 'paused' RETURNING *`,
    [leadId, workspaceId]
  );
  return res.rows;
}

export async function cancelFollowUp(leadId: string, workspaceId: string, reason: string) {
  const res = await query(
    `UPDATE follow_up_tasks SET status = 'cancelled', cancel_reason = $1 WHERE lead_id = $2 AND workspace_id = $3 AND status IN ('pending','paused') RETURNING *`,
    [reason, leadId, workspaceId]
  );
  return res.rows;
}

// ---------- 10. Pipeline ----------

export async function movePipelineStage(leadId: string, toStage: string, reason: string, workspaceId: string, confidence?: number) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const lead = leadRes.rows[0];
  if (!lead) throw new Error('Lead not found in workspace');
  if (lead.stage === toStage) return lead;

  const from = lead.stage;
  await query(
    `INSERT INTO pipeline_events (workspace_id, lead_id, from_stage, to_stage, reason, confidence)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [workspaceId, leadId, from, toStage, reason, confidence ?? lead.confidence_score]
  );
  const updated = (
    await query(
      `UPDATE leads SET stage = $1, updated_at = NOW(), last_activity_at = NOW() WHERE id = $2 RETURNING *`,
      [toStage, leadId]
    )
  ).rows[0];
  return updated;
}

export async function setDoNotContact(leadId: string, value: boolean, workspaceId: string, reason?: string) {
  const leadRes = await query(`SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`, [leadId, workspaceId]);
  const existing = leadRes.rows[0];
  if (!existing) throw new Error('Lead not found in workspace');

  let nextStage: string | undefined;
  if (value) {
    nextStage = 'Do Not Contact';
  } else if (existing.stage === 'Do Not Contact') {
    nextStage = 'Contacted';
  }

  const res = await query(
    `UPDATE leads SET do_not_contact = $1, stage = COALESCE($2, stage), updated_at = NOW() WHERE id = $3 AND workspace_id = $4 RETURNING *`,
    [value, nextStage || null, leadId, workspaceId]
  );
  if (value) {
    await query(`UPDATE follow_up_tasks SET status = 'cancelled', cancel_reason = 'Do Not Contact' WHERE lead_id = $1 AND status IN ('pending','paused')`, [leadId]);
    await query(
      `INSERT INTO memories (lead_id, type, category, content) VALUES ($1, 'long_term', 'dnc', $2)`,
      [leadId, `Do Not Contact set${reason ? `: ${reason}` : ''}. All automation stopped.`]
    );
    await logActivity({
      agent: 'Policy Guard',
      step: 'Do Not Contact Enforcement',
      tool: 'set_do_not_contact()',
      decision: `Lead marked Do Not Contact${reason ? ` (${reason})` : ''}. Automation halted.`,
      workspaceId,
      leadId
    });
  }
  return res.rows[0];
}

// ---------- 11. Demo Workflow ----------

export async function runDemoWorkflow(workspaceId: string) {
  const steps: any[] = [];
  const push = (s: any) => steps.push(s);

  // 1. Company knowledge
  const profile = await ensureDemoCompanyKnowledge(workspaceId);
  push({ step: 'company', profile });

  // 2. ICP
  const icpData = {
    location: 'Pakistan',
    industry: 'Hospital',
    companySize: '100 employees',
    targetProblem: 'High volume patient appointment & inquiry support backlogs',
    exclusions: 'Micro-clinics under 10 staff',
    preferredService: 'WhatsApp AI Support & Inquiry Triage'
  };
  const icp = await createIcp(icpData, workspaceId);
  push({ step: 'icp', icp });

  // 3. Discovery + cheap filter
  const disc = await discoverAndFilterLeads(icp.id, workspaceId, true);
  const target = disc.leads.find((l: any) => l.stage === 'Potential') || disc.leads[0];
  push({ step: 'discovery', disc, target });

  // 4. Deep research + qualification
  const research = await performDeepResearchAndQualification(target.id, workspaceId, true);
  push({ step: 'research', lead: research.lead, factors: research.factors });

  // 5. Decision maker
  const dm = await identifyDecisionMakers(target.id, workspaceId, true);
  push({ step: 'decisionMaker', contacts: dm });

  // 6. Service match
  const match = await matchService(target.id, workspaceId);
  push({ step: 'serviceMatch', match: match.match });

  // 7. Outreach draft + send
  const draft = await generateOutreachDraft(target.id, dm[0]?.id || null, workspaceId);
  const sent = await sendOutreachMessage(target.id, draft.message.id, workspaceId);
  push({ step: 'outreach', draft, sent });

  // 8. Simulated reply
  const reply = await processInboundResponse(
    target.id,
    "Hi team, we're interested. Let's meet this Thursday at 3 PM to discuss your solution.",
    workspaceId
  );
  push({ step: 'reply', ...reply });

  return { steps, leadId: target.id };
}

// ---------- 12. Lead Generation with Google Maps ----------

export interface LeadGenOptions {
  serviceOffered: string;
  businessCategory: string;
  location: string;
  maxResults?: number;
}

export interface GeneratedLead {
  id: string;
  name: string;
  website: string;
  industry: string;
  location: string;
  size: string;
  stage: string;
  confidence_score: number;
  score_explanation: string;
  recommended_service: string | null;
  contact_email: string | null;
  has_gmail: boolean;
  website_check: WebsiteCheckResult | null;
  lead_quality: 'hot' | 'warm' | 'medium' | 'cold';
  pitches: Array<{ id: string; pitch: string; subject: string }>;
  google_maps_link: string | null;
  rating: number | null;
  place_id: string | null;
  description: string;
  userRatingsTotal?: number;
}

function determineLeadQuality(score: number, rating: number | null, hasWebsite: boolean, hasGmail: boolean): 'hot' | 'warm' | 'medium' | 'cold' {
  let qualityScore = score;
  if (rating && rating >= 4) qualityScore += 10;
  if (hasWebsite) qualityScore += 5;
  if (hasGmail) qualityScore += 5;

  if (qualityScore >= 75) return 'hot';
  if (qualityScore >= 60) return 'warm';
  if (qualityScore >= 40) return 'medium';
  return 'cold';
}

async function generatePitchForLead(lead: any, serviceOffered: string, companyProfile: any, evidenceRows: any[]): Promise<{ subject: string; pitch: string }> {
  const evidenceText = evidenceRows.slice(0, 2).map((e) => e.snippet).join(' ');
  const problemSignal = evidenceText || `Operating in ${lead.industry} in ${lead.location}`;

  if (llmHasProvider()) {
    const prompt = `Write a concise 2-3 sentence cold outreach pitch from ${companyProfile?.name || 'our company'} to a decision maker at ${lead.name} (${lead.industry} in ${lead.location}). 
The prospect offers: ${lead.name}'s services in ${lead.industry}.
Our service is: ${serviceOffered}.
Observed signals: ${problemSignal}
Do not fabricate facts. Return JSON: {"subject":"...","pitch":"..."}`;

    const result = await executeLLM(
      'You are a concise sales copywriter. Write personalized cold email pitches that reference real signals. Return only valid JSON.',
      prompt,
      true,
      30000
    );

    if (result?.subject && result?.pitch) {
      return { subject: result.subject, pitch: result.pitch };
    }
  }

  const fallbackSubject = `${serviceOffered} for ${lead.name}?`;
  const fallbackPitch = `Hi there,\n\nI noticed ${lead.name} is a ${lead.industry} business in ${lead.location}. We help companies like yours with ${serviceOffered} to reduce operational overhead and improve efficiency.\n\nWould you be open to a 10-minute chat about how we could help ${lead.name} streamline operations?\n\nBest regards,\n${companyProfile?.name || 'AgentHack Sales'}`;

  return { subject: fallbackSubject, pitch: fallbackPitch };
}

export async function generateLeads(
  opts: LeadGenOptions,
  workspaceId: string
): Promise<{ leads: GeneratedLead[]; totalGenerated: number; source: string; websiteChecks: number }> {
  const { serviceOffered, businessCategory, location, maxResults = 20 } = opts;
  const run = await startAgentRun({
    workspaceId,
    workflow: 'lead-generation',
    currentState: 'sourcing',
    inputSnapshot: opts,
  });

  let places: PlaceResult[] = [];
  let source = 'demo';

  // Try real Google Maps Places API first
  if (maps.hasProvider) {
    const searchResults = await maps.searchPlaces(businessCategory, location, maxResults);
    if (searchResults && searchResults.length > 0) {
      // Filter by exact location match
      const locLower = location.toLowerCase();
      places = searchResults.filter(p => {
        const placeLocLower = (p.location || '').toLowerCase();
        return placeLocLower.includes(locLower) || placeLocLower.includes(location);
      });
      if (places.length > 0) {
        source = 'google-maps';
      }
    }
  }

  // Fallback to demo data if no API key or no results
  if (places.length === 0) {
    places = generateDemoPlaces(businessCategory, location, maxResults);
    source = 'demo';
  }

  const profile = await getLatestProfile(workspaceId);
  const leads: GeneratedLead[] = [];
  let websiteChecks = 0;
  const locLower = location.toLowerCase();

  for (const place of places) {
    // Strict location filtering: only include leads that match the exact location
    const placeLocLower = (place.location || '').toLowerCase();
    if (!placeLocLower.includes(locLower) && !placeLocLower.includes(location.toLowerCase())) {
      continue;
    }

    const website = place.website || '';
    const hasRealWebsite = Boolean(website) && !website.includes('google.com/maps');
    const googleMapsLink = place.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${place.placeId}`;

    // Only include leads with a real website (working or not - we'll check it)
    if (!hasRealWebsite) {
      continue;
    }

    let contactEmail: string | null = null;
    let hasGmail = false;

    // Check website errors - only for real websites
    let websiteCheck: WebsiteCheckResult | null = null;
    if (hasRealWebsite) {
      websiteCheck = await checkWebsiteFn(website);
      websiteChecks++;
    }

    // Compute a lead score
    let score = 50;
    let scoreFactors: string[] = [];

    if (place.rating && place.rating >= 4) {
      score += 15;
      scoreFactors.push(`High rating (${place.rating})`);
    }
    if (place.rating && place.rating >= 3) {
      score += 5;
      scoreFactors.push(`Good rating (${place.rating})`);
    }
    if (hasRealWebsite) {
      score += 10;
      scoreFactors.push('Has website');
    }
    if (websiteCheck?.reachable) {
      score += 5;
      scoreFactors.push('Website reachable');
    }
    if (websiteCheck?.hasHttpError) {
      score += 10;
      scoreFactors.push('Website has errors (opportunity)');
    }
    if (place.userRatingsTotal && place.userRatingsTotal > 10) {
      score += 5;
      scoreFactors.push(`Popular (${place.userRatingsTotal} reviews)`);
    }

    score = Math.min(99, Math.max(5, score));

    // Generate initial evidence for this lead
    const evidenceRows: any[] = [];
    if (websiteCheck && websiteCheck.hasHttpError) {
      evidenceRows.push({
        title: 'Website Error Detected',
        snippet: `${place.name}'s website appears to have errors: ${websiteCheck.error || 'HTTP error'}`,
        source: 'website_check',
      });
    }
    if (place.rating && place.rating >= 4) {
      evidenceRows.push({
        title: 'Customer Reviews',
        snippet: `${place.name} has ${(place.userRatingsTotal || 0)} reviews with a rating of ${place.rating}/5`,
        source: 'google_maps',
      });
    }

    // Generate company description from evidence
    let companyDescription = '';
    if (place.address) companyDescription += `${place.name} is located at ${place.address}. `;
    if (place.rating) companyDescription += `It has a ${place.rating}/5 rating with ${(place.userRatingsTotal || 0)} reviews. `;
    if (place.types && place.types.length > 0) companyDescription += `This is a ${place.types.join(', ')} business. `;
    if (websiteCheck?.title) companyDescription += `${websiteCheck.title} is their online presence. `;

    // Generate pitch
    const pitchData = await generatePitchForLead(place, serviceOffered, profile, evidenceRows);
    const pitches = [{
      id: `pitch_${place.placeId || place.name}`,
      subject: pitchData.subject,
      pitch: pitchData.pitch,
    }];

    const quality = determineLeadQuality(score, place.rating || null, hasRealWebsite, hasGmail);

    // Save to database    // Save to database
    const leadRes = await query(
      `INSERT INTO leads (
        icp_id, name, website, industry, location, size, stage,
        confidence_score, score_explanation, recommended_service,
        service_rationale, do_not_contact, workspace_id,
        place_id, website_check, contact_email, has_gmail,
        lead_quality, lead_pitches
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, $12, $13, $14, $15, $16, $17, $18)
      RETURNING *`,
      [
        null, // icp_id
        place.name,
        website,
        businessCategory,
        place.location,
        place.types && place.types.length > 0 ? `${place.types[0]} business` : 'Business',
        quality === 'hot' ? 'Potential' : quality === 'warm' ? 'Potential' : 'Not Qualified',
        score,
        scoreFactors.join('; ') || `Score based on ${quality} quality indicators.`,
        serviceOffered,
        `Lead sourced from ${source}. Quality: ${quality}. ${companyDescription}`,
        workspaceId,
        place.placeId,
        websiteCheck ? JSON.stringify(websiteCheck) : null,
        contactEmail,
        hasGmail,
        quality,
        JSON.stringify(pitches),
      ]
    );

    const row = leadRes.rows[0];
    leads.push({
      id: row.id,
      name: place.name,
      website: website,
      industry: businessCategory,
      location: place.location,
      size: `${place.types && place.types.length > 0 ? place.types[0] : 'Business'}`,
      stage: row.stage,
      confidence_score: score,
      score_explanation: row.score_explanation,
      recommended_service: serviceOffered,
      contact_email: contactEmail,
      has_gmail: hasGmail,
      website_check: websiteCheck,
      lead_quality: quality,
      pitches,
      google_maps_link: place.googleMapsUri || `https://www.google.com/maps/place/?q=place_id:${place.placeId}`,
      rating: place.rating || null,
      place_id: place.placeId,
      description: companyDescription,
      userRatingsTotal: place.userRatingsTotal,
    });
  }

  await updateAgentRun(run.id, {
    currentState: 'complete',
    decision: `Generated ${leads.length} leads from ${source}. ${websiteChecks} website checks performed.`,
    confidence: 85,
    nextAction: 'Review leads and begin research/outreach.',
    status: 'completed',
  });

  await logActivity({
    agent: 'Lead Generation',
    step: 'Lead Sourcing',
    tool: 'search_google_maps()',
    inputData: `service=${serviceOffered}, category=${businessCategory}, location=${location}`,
    outputData: `leads=${leads.length}, source=${source}`,
    decision: `Found ${leads.length} leads via ${source}. Hot: ${leads.filter(l => l.lead_quality === 'hot').length}, Warm: ${leads.filter(l => l.lead_quality === 'warm').length}, Medium: ${leads.filter(l => l.lead_quality === 'medium').length}, Cold: ${leads.filter(l => l.lead_quality === 'cold').length}.`,
    workspaceId,
  });

  return { leads, totalGenerated: leads.length, source, websiteChecks };
}

function generateDemoPlaces(businessCategory: string, location: string, maxResults: number): PlaceResult[] {
  const places: PlaceResult[] = [];
  const categories = businessCategory.toLowerCase();

  // Generic business names that work for any category and location
  const genericNames = [
    `${location} ${businessCategory} 1`,
    `${location} ${businessCategory} 2`,
    `${location} ${businessCategory} 3`,
    `${location} Premier ${businessCategory}`,
    `${location} Elite ${businessCategory}`,
    `${location} Prime ${businessCategory}`,
    `${location} ${businessCategory} Solutions`,
    `${location} ${businessCategory} Group`,
    `${location} ${businessCategory} Pros`,
    `${location} Trusted ${businessCategory}`,
  ];

  // Generate working demo websites (using a pattern that works for demos)
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const domain = slug(`${location}-${businessCategory}`.replace(/\s+/g, '-'));

  genericNames.slice(0, maxResults).forEach((name: string, i: number) => {
    const isDental = categories.includes('dental') || categories.includes('dentist');
    const rating = isDental ? [4.5, 4.2, 3.9, 4.7, 4.1, 3.6, 4.3, 3.8][i % 8] : 3.5 + Math.random() * 1.5;
    const reviews = isDental ? [128, 89, 56, 210, 74, 42, 93, 35][i % 8] : Math.floor(Math.random() * 200) + 10;
    const types = isDental ? ['dentist'] : [categories.split(' ')[0] || 'business'];

    // Generate a website URL - using placekitten for demo images, but for website we use a working URL
    // In demo mode, we'll use a URL that looks real but we know it won't be reachable
    const website = `https://${slug(name)}.com`;

    places.push({
      placeId: `demo_${slug(name)}`,
      name,
      address: location,
      location: location,
      website,
      phoneNumber: '+1-555-0000',
      businessStatus: 'OPERATIONAL',
      rating: Math.round(rating * 10) / 10,
      userRatingsTotal: reviews,
      types: types,
      googleMapsUri: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name + ' ' + location)}`,
    });
  });

  return places;
}

// ---------- Scheduler helpers (used by server) ----------

export async function fetchDueFollowUps(): Promise<any[]> {
  const res = await query(
    `SELECT f.*, l.name AS lead_name, l.workspace_id FROM follow_up_tasks f
     JOIN leads l ON l.id = f.lead_id
     WHERE f.status = 'pending' AND f.scheduled_for <= NOW()
     ORDER BY f.scheduled_for ASC LIMIT 25`
  );
  return res.rows;
}

export async function fetchUpcomingMeetingReminders(): Promise<any[]> {
  const res = await query(
    `SELECT * FROM meetings WHERE status = 'scheduled' AND reminder_sent = false AND reminder_at IS NOT NULL AND reminder_at <= NOW() LIMIT 25`
  );
  return res.rows;
}

export async function markMeetingReminderSent(meetingId: string) {
  await query(`UPDATE meetings SET reminder_sent = true WHERE id = $1`, [meetingId]);
}