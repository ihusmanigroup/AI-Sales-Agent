import dotenv from 'dotenv';

dotenv.config();

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const GOOGLE_MAPS_RATE_LIMIT = 5; // requests per second

export interface PlaceResult {
  placeId: string;
  name: string;
  address: string;
  location: string;
  lat?: number;
  lng?: number;
  website?: string;
  phoneNumber?: string;
  businessStatus?: string;
  rating?: number;
  userRatingsTotal?: number;
  priceLevel?: number;
  types?: string[];
  googleMapsUri?: string;
}

export interface WebsiteCheckResult {
  url: string;
  reachable: boolean;
  statusCode?: number;
  error?: string;
  title?: string;
  hasHttpError?: boolean;
  dnsError?: boolean;
  sslError?: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<any> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  const minInterval = 1000 / GOOGLE_MAPS_RATE_LIMIT;
  if (elapsed < minInterval) {
    await delay(minInterval - elapsed);
  }
  lastRequestTime = Date.now();
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

export async function searchPlaces(
  query: string,
  location: string,
  maxResults = 20
): Promise<PlaceResult[] | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    return null;
  }

  const fullQuery = `${query} ${location}`;
  const params = new URLSearchParams({
    query: fullQuery,
    key: GOOGLE_MAPS_API_KEY,
    max_results: String(maxResults),
  });

  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?${params.toString()}`;

  try {
    const data: any = await rateLimitedFetch(url);
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.warn('⚠️ Google Places API error:', data.status, data.error_message);
      return null;
    }

    const results: PlaceResult[] = (data.results || []).map((r: any) => ({
      placeId: r.place_id,
      name: r.name || '',
      address: r.formatted_address || r.vicinity || '',
      location: extractLocation(r),
      lat: r.geometry?.location?.lat,
      lng: r.geometry?.location?.lng,
      website: r.website,
      phoneNumber: r.formatted_phone_number,
      businessStatus: r.business_status,
      rating: r.rating,
      userRatingsTotal: r.user_ratings_total,
      priceLevel: r.price_level,
      types: r.types || [],
      googleMapsUri: r.google_maps_uri || r.photos?.[0]?.url ? `https://www.google.com/maps/place/?q=place_id:${r.place_id}` : undefined,
    }));

    return results;
  } catch (e) {
    console.warn('⚠️ Google Places search failed:', (e as Error).message);
    return null;
  }
}

export async function getPlaceDetails(placeId: string): Promise<any | null> {
  if (!GOOGLE_MAPS_API_KEY) {
    return null;
  }

  const params = new URLSearchParams({
    place_id: placeId,
    key: GOOGLE_MAPS_API_KEY,
    fields: 'name,formatted_address,formatted_phone_number,website,google_maps_uri,business_status,rating,user_ratings_total,reviews,types,opening_hours',
  });

  const url = `https://maps.googleapis.com/maps/api/place/details/json?${params.toString()}`;

  try {
    const data: any = await rateLimitedFetch(url);
    if (data.status !== 'OK') {
      console.warn('⚠️ Google Place Details error:', data.status, data.error_message);
      return null;
    }
    return data.result;
  } catch (e) {
    console.warn('⚠️ Google Place Details failed:', (e as Error).message);
    return null;
  }
}

function extractLocation(place: any): string {
  if (place.vicinity) return place.vicinity;
  if (place.formatted_address) {
    const parts = place.formatted_address.split(', ');
    // Return city, state format
    if (parts.length >= 2) {
      return `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`;
    }
    return place.formatted_address;
  }
  return '';
}

export async function checkWebsite(url: string): Promise<WebsiteCheckResult> {
  const result: WebsiteCheckResult = { url, reachable: false };

  if (!url || url === '') {
    result.error = 'No website URL provided';
    return result;
  }

  try {
    // Resolve final URL (follow redirects)
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    });

    result.statusCode = res.status;
    result.reachable = res.ok;

    if (!res.ok) {
      result.hasHttpError = true;
      result.error = `HTTP ${res.status}: ${res.statusText}`;
    }

    // Try to extract title
    try {
      const html = await res.text();
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      if (titleMatch) {
        result.title = titleMatch[1].trim();
      }
    } catch {
      // Title extraction is best-effort
    }

    return result;
  } catch (e: any) {
    const errMsg = e.message || String(e);
    result.error = errMsg;

    if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
      result.dnsError = true;
      result.error = 'DNS resolution failed (domain does not exist)';
    } else if (errMsg.includes('ECONNREFUSED')) {
      result.error = 'Connection refused';
    } else if (errMsg.includes('ETIMEDOUT') || errMsg.includes('timeout')) {
      result.error = 'Connection timed out';
    } else if (errMsg.includes('self signed certificate') || errMsg.includes('CERT_HAS_BEEN_REVOKED')) {
      result.sslError = true;
      result.error = 'SSL certificate error';
    } else if (errMsg.includes('ECONNRESET')) {
      result.error = 'Connection reset by host';
    }

    return result;
  }
}

export async function extractGmailFromEmail(email: string): Promise<{ hasGmail: boolean; gmailAddress: string | null }> {
  if (!email) {
    return { hasGmail: false, gmailAddress: null };
  }

  const gmailRegex = /^[a-zA-Z0-9._%+-]+@gmail\.com$/;
  if (gmailRegex.test(email)) {
    return { hasGmail: true, gmailAddress: email };
  }

  return { hasGmail: false, gmailAddress: null };
}

export const maps = {
  searchPlaces,
  getPlaceDetails,
  checkWebsite,
  extractGmailFromEmail,
  hasProvider: !!GOOGLE_MAPS_API_KEY,
  apiKey: GOOGLE_MAPS_API_KEY,
};
