import dotenv from 'dotenv';

dotenv.config();

const groqApiKey = process.env.GROQ_API_KEY || '';
const groqPrimaryModel = process.env.GROQ_PRIMARY_MODEL || 'llama-3.3-70b-versatile';
const groqMiniModel = process.env.GROQ_MINI_MODEL || 'llama-3.1-8b-instant';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

function cleanJson(content: string): string {
  return content
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function safeParse(content: string): any {
  try {
    return JSON.parse(cleanJson(content));
  } catch {
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleanJson(content.slice(start, end + 1)));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Multi-tier resilient LLM engine (Groq 70B -> Groq 8B -> Gemini).
 * Returns parsed JSON when returnJson is true, else raw text. Returns null when all tiers fail.
 */
export async function executeLLM(
  systemPrompt: string,
  userPrompt: string,
  returnJson: boolean = true
): Promise<any> {
  // Tier 1: Groq Llama 3.3 70B
  if (groqApiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
        body: JSON.stringify({
          model: groqPrimaryModel,
          messages: [
            {
              role: 'system',
              content: `${systemPrompt}\n${returnJson ? 'Respond ONLY in raw valid JSON object without markdown fences.' : ''}`
            },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          response_format: returnJson ? { type: 'json_object' } : undefined
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data: any = await res.json();
        const content: string = data?.choices?.[0]?.message?.content?.trim() || '';
        if (!content) return null;
        return returnJson ? safeParse(content) : content;
      }
    } catch (e) {
      console.warn('⚠️ Groq Primary failed:', (e as Error).message);
    }
  }

  // Tier 2: Groq Llama 3.1 8B
  if (groqApiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqApiKey}` },
        body: JSON.stringify({
          model: groqMiniModel,
          messages: [
            {
              role: 'system',
              content: `${systemPrompt}\n${returnJson ? 'Return valid JSON only.' : ''}`
            },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.2,
          response_format: returnJson ? { type: 'json_object' } : undefined
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data: any = await res.json();
        const content: string = data?.choices?.[0]?.message?.content?.trim() || '';
        if (!content) return null;
        return returnJson ? safeParse(content) : content;
      }
    } catch (e) {
      console.warn('⚠️ Groq Mini failed:', (e as Error).message);
    }
  }

  // Tier 3: Gemini
  if (geminiApiKey) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${geminiApiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: `${systemPrompt}\n\n${userPrompt}` }] }]
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data: any = await res.json();
        const content: string = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
        if (!content) return null;
        return returnJson ? safeParse(content) : content;
      }
    } catch (e) {
      console.warn('⚠️ Gemini fallback failed:', (e as Error).message);
    }
  }

  return null;
}

export const llm = {
  execute: executeLLM,
  hasProvider: Boolean(groqApiKey || geminiApiKey)
};