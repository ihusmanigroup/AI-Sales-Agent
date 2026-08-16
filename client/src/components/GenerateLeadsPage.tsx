import { useState } from 'react';
import {
  Copy, ExternalLink, Globe, MapPin, Star, Users, AlertCircle,
  CheckCircle2, Sparkles, Search, BarChart3, MapIcon, Mail
} from 'lucide-react';
import { PageHeader, Button, Card, Chip, ScoreBar, cx } from './ui';

interface WebsiteCheck {
  url: string;
  reachable: boolean;
  statusCode?: number;
  error?: string;
  hasHttpError?: boolean;
  title?: string;
}

interface Pitch {
  id: string;
  pitch: string;
  subject: string;
}

interface GeneratedLead {
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
  website_check: WebsiteCheck | null;
  lead_quality: 'hot' | 'warm' | 'medium' | 'cold';
  pitches: Pitch[];
  google_maps_link: string | null;
  rating: number | null;
  place_id: string | null;
  description: string;
}

const SERVICE_SUGGESTIONS = [
  'AI Support Automation', 'WhatsApp Business Automation', 'Lead Qualification',
  'Customer Service Automation', 'Appointment Scheduling', 'Review Management',
  'Plumbing Services', 'Electrical Services', 'HVAC Repair',
  'Legal Consulting', 'Accounting Services', 'Marketing Agency',
  'Web Development', 'IT Support', 'Digital Marketing',
];

const CATEGORY_SUGGESTIONS = [
  'Dental Clinic', 'Hospital', 'Medical Center',
  'Restaurant', 'Retail Store', 'Gym & Fitness',
  'Real Estate Agency', 'Insurance Agency', 'Law Firm',
  'Accounting Firm', 'Marketing Agency', 'IT Services',
  'Construction Company', 'Auto Repair', 'Beauty Salon',
];

const LOCATION_SUGGESTIONS = [
  'New York, USA', 'Los Angeles, USA', 'Chicago, USA',
  'London, UK', 'Manchester, UK', 'Lahore, Pakistan',
  'Karachi, Pakistan', 'Berlin, Germany', 'Sydney, Australia',
  'Toronto, Canada', 'Dubai, UAE', 'Singapore',
  'Bangalore, India', 'Mumbai, India',
];

const QUALITY_CONFIG: Record<string, { color: string; bg: string; label: string; description: string }> = {
  hot: { color: 'text-danger', bg: 'bg-danger/10 border-danger/30', label: 'Hot Lead', description: 'High-quality prospect with strong signals' },
  warm: { color: 'text-amber-400', bg: 'bg-warning/10 border-warning/30', label: 'Warm Lead', description: 'Good fit with moderate signals' },
  medium: { color: 'text-blue-400', bg: 'bg-info/10 border-info/30', label: 'Medium', description: 'Meets basic criteria' },
  cold: { color: 'text-textMuted', bg: 'bg-muted/20 border-muted/40', label: 'Cold Lead', description: 'Low priority — needs more research' },
};

export function GenerateLeadsPage(props: {
  loading: boolean;
  agentStatus: string;
  onGenerateLeads: (serviceOffered: string, businessCategory: string, location: string, maxResults?: number) => Promise<any>;
  onCopyToGmail: (leadId: string, pitchId: string) => Promise<void>;
  onGenerateOutreach?: (leadId: string) => void;
}) {
  const [serviceOffered, setServiceOffered] = useState('');
  const [businessCategory, setBusinessCategory] = useState('');
  const [location, setLocation] = useState('');
  const [maxResults, setMaxResults] = useState(20);
  const [results, setResults] = useState<{ leads: GeneratedLead[]; totalGenerated: number; source: string; websiteChecks: number } | null>(null);
  const [showCustomService, setShowCustomService] = useState(false);
  const [showCustomCategory, setShowCustomCategory] = useState(false);

  const inputCls = 'w-full px-4 py-3 bg-elevated border border-muted rounded-xl text-[14px] text-textPrimary placeholder:text-textMuted focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15 transition-all duration-200';

  const handleGenerate = async () => {
    if (!serviceOffered || !businessCategory || !location) return;
    setResults(null);
    try {
      const res = await props.onGenerateLeads(serviceOffered, businessCategory, location, maxResults);
      setResults(res);
    } catch (e: any) {
      alert(e.message || 'Failed to generate leads');
    }
  };

  const handleManualCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  const canGenerate = serviceOffered.trim() && businessCategory.trim() && location.trim();

  const resetForm = () => {
    setServiceOffered('');
    setBusinessCategory('');
    setLocation('');
    setMaxResults(20);
    setShowCustomService(false);
    setShowCustomCategory(false);
    setResults(null);
  };

  return (
    <div className="p-4 md:p-8 max-w-[1400px] mx-auto">
      <PageHeader
        eyebrow="Lead Generation"
        title="Generate Targeted Leads"
        subtitle={
          <div className="max-w-3xl">
            <p className="mb-1">Enter the service you offer, the business category you're targeting, and a location. Your AI will source companies from Google Maps, verify their websites, score them by quality (hot/warm/medium/cold), and generate personalized outreach pitches.</p>
            {props.agentStatus && <p className="text-primary font-medium mt-1">{props.agentStatus}</p>}
          </div>
        }
      />

      {!results && (
        <div className="space-y-8">
          {/* Form */}
          <Card className="animate-fade-in">
            <div className="space-y-8">
              {/* Service Offered */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-textSecondary">
                  <Sparkles className="w-4 h-4 text-primary" />
                  What service do you offer?
                </label>
                {showCustomService ? (
                  <input
                    value={serviceOffered}
                    onChange={(e) => setServiceOffered(e.target.value)}
                    placeholder="e.g. AI Support Automation, Plumbing Services..."
                    className={inputCls}
                    autoFocus
                  />
                ) : (
                  <div className="flex flex-wrap gap-2.5">
                    {SERVICE_SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => setServiceOffered(s)}
                        className={cx(
                          'px-4 py-2.5 rounded-xl border text-[13px] font-medium transition-all duration-200 transform hover:scale-[1.02]',
                          serviceOffered === s
                            ? 'bg-primary/15 border-primary/40 text-primary shadow-glow'
                            : 'bg-white/[0.03] border-muted text-textSecondary hover:bg-white/[0.06] hover:border-primary/20'
                        )}
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      onClick={() => { setShowCustomService(true); setServiceOffered(''); }}
                      className="px-4 py-2.5 rounded-xl border border-dashed border-muted text-[12px] text-textSecondary hover:border-primary/30 hover:bg-white/[0.03] transition-all"
                    >
                      + Custom service
                    </button>
                  </div>
                )}
                {showCustomService && serviceOffered && (
                  <p className="text-[11px] text-textSecondary animate-fade-in">Your service: {serviceOffered}</p>
                )}
              </div>

              {/* Business Category */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-textSecondary">
                  <Search className="w-4 h-4 text-primary" />
                  Target business category
                </label>
                {showCustomCategory ? (
                  <input
                    value={businessCategory}
                    onChange={(e) => setBusinessCategory(e.target.value)}
                    placeholder="e.g. Dental Clinic, Restaurant, Law Firm..."
                    className={inputCls}
                    autoFocus
                  />
                ) : (
                  <div className="flex flex-wrap gap-2.5">
                    {CATEGORY_SUGGESTIONS.map((s) => (
                      <button
                        key={s}
                        onClick={() => setBusinessCategory(s)}
                        className={cx(
                          'px-4 py-2.5 rounded-xl border text-[13px] font-medium transition-all duration-200 transform hover:scale-[1.02]',
                          businessCategory === s
                            ? 'bg-primary/15 border-primary/40 text-primary shadow-glow'
                            : 'bg-white/[0.03] border-muted text-textSecondary hover:bg-white/[0.06] hover:border-primary/20'
                        )}
                      >
                        {s}
                      </button>
                    ))}
                    <button
                      onClick={() => { setShowCustomCategory(true); setBusinessCategory(''); }}
                      className="px-4 py-2.5 rounded-xl border border-dashed border-muted text-[12px] text-textSecondary hover:border-primary/30 hover:bg-white/[0.03] transition-all"
                    >
                      + Custom category
                    </button>
                  </div>
                )}
                {showCustomCategory && businessCategory && (
                  <p className="text-[11px] text-textSecondary animate-fade-in">Your category: {businessCategory}</p>
                )}
              </div>

              {/* Location */}
              <div className="space-y-3">
                <label className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-textSecondary">
                  <MapPin className="w-4 h-4 text-primary" />
                  Location
                </label>
                <input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Bangalore, India or Karachi, Pakistan"
                  className={inputCls}
                />
                <div className="flex flex-wrap gap-1.5">
                  {LOCATION_SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => setLocation(s)}
                      className={cx(
                        'px-3 py-1.5 rounded-lg border text-[11px] font-medium transition-all',
                        location === s
                          ? 'bg-primary/15 border-primary/40 text-primary'
                          : 'bg-white/[0.03] border-muted text-textSecondary hover:bg-white/[0.06] hover:border-primary/20'
                      )}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Max Results */}
              <div className="flex items-end gap-6">
                <div className="space-y-2">
                  <label className="flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wide text-textSecondary">
                    <BarChart3 className="w-4 h-4 text-primary" />
                    Number of leads
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={maxResults}
                      onChange={(e) => setMaxResults(Math.max(1, Math.min(50, parseInt(e.target.value) || 20)))}
                      className="w-24 px-3 py-2.5 bg-elevated border border-muted rounded-xl text-[14px] text-textPrimary focus:outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15 transition-all"
                    />
                    <span className="text-[13px] text-textSecondary">leads (1-50)</span>
                  </div>
                </div>

                <div className="flex-1" />

                <Button
                  onClick={handleGenerate}
                  loading={props.loading}
                  disabled={!canGenerate || props.loading}
                  className="h-11 px-8"
                >
                  <Sparkles className="w-5 h-5 fill-current" />
                  {props.loading ? 'Generating...' : 'Generate Leads'}
                </Button>
                <Button variant="ghost" onClick={resetForm} disabled={props.loading}>
                  Reset
                </Button>
              </div>
            </div>
          </Card>

          {/* How it works */}
          <Card className="bg-elevated/30 border-muted/50">
            <h3 className="text-[14px] font-semibold text-textPrimary mb-3 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              How lead generation works
            </h3>
            <div className="grid md:grid-cols-3 gap-6">
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
                  <MapIcon className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <div className="text-[13px] font-medium text-textPrimary mb-1">Google Maps Search</div>
                  <div className="text-[12px] text-textSecondary leading-relaxed">Finds real businesses matching your category in the specified location using the Google Maps Places API.</div>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
                  <Globe className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <div className="text-[13px] font-medium text-textPrimary mb-1">Website Verification</div>
                  <div className="text-[12px] text-textSecondary leading-relaxed">Checks each business's website for reachability, HTTP errors, DNS issues, and SSL problems.</div>
                </div>
              </div>
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/15 border border-primary/25 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-primary" />
                </div>
                <div>
                  <div className="text-[13px] font-medium text-textPrimary mb-1">AI Pitches & Scoring</div>
                  <div className="text-[12px] text-textSecondary leading-relaxed">Scores leads by quality (hot/warm/medium/cold) and generates personalized outreach messages grounded in real signals.</div>
                </div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {results && (
        <div className="animate-fade-in">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-2xl font-bold text-textPrimary">Generated Leads ({results.totalGenerated})</h2>
              <div className="text-[13px] text-textSecondary mt-1">
                Source: <strong className="text-textPrimary">{results.source}</strong> · Website checks: <strong className="text-textPrimary">{results.websiteChecks}</strong>
              </div>
            </div>
            <Button variant="ghost" onClick={() => setResults(null)}>
              ← Generate new leads
            </Button>
          </div>

          {/* Quality breakdown */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
            {(['hot', 'warm', 'medium', 'cold'] as const).map((q) => {
              const count = results.leads.filter((l) => l.lead_quality === q).length;
              const config = QUALITY_CONFIG[q];
              return (
                <div key={q} className={`border rounded-xl p-4 ${config.bg}`}>
                  <div className={`text-2xl font-bold ${config.color}`}>{count}</div>
                  <div className={`text-[12px] font-semibold ${config.color}`}>{config.label}</div>
                  <div className="text-[11px] text-textMuted mt-0.5">{config.description}</div>
                </div>
              );
            })}
          </div>

          <div className="space-y-6">
            {results.leads.map((lead, i) => (
              <LeadCard key={lead.id} lead={lead} index={i} onManualCopy={handleManualCopy} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LeadCard({ lead, index, onManualCopy }: {
  lead: GeneratedLead;
  index: number;
  onManualCopy: (text: string) => void;
}) {
  const config = QUALITY_CONFIG[lead.lead_quality as keyof typeof QUALITY_CONFIG] || QUALITY_CONFIG.medium;
  const websiteCheck = lead.website_check;
  const hasRealWebsite = Boolean(lead.website) && !lead.website.includes('google.com/maps');

  return (
    <Card
      className="border border-muted hover:border-primary/20 transition-all duration-200 transform hover:translate-y-[-2px] hover:shadow-card"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex flex-col lg:flex-row gap-6">
        {/* Lead Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-4 mb-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
                <h3 className="text-[18px] font-bold text-textPrimary leading-tight">{lead.name}</h3>
                <Chip tone={lead.lead_quality === 'hot' ? 'danger' : lead.lead_quality === 'warm' ? 'warning' : lead.lead_quality === 'medium' ? 'primary' : 'neutral'} className="text-[10px] px-2 py-0.5">
                  {config.label}
                </Chip>
                {lead.rating && (
                  <div className="flex items-center gap-1 bg-warning/10 px-2 py-0.5 rounded-lg">
                    <Star className="w-3.5 h-3.5 text-warning fill-current" />
                    <span className="text-[11px] font-medium text-warning">{lead.rating}</span>
                  </div>
                )}
              </div>
              <ScoreBar value={lead.confidence_score || 0} className="w-48" />
            </div>
          </div>

          {/* Description */}
          {lead.description && (
            <p className="text-[13px] text-textSecondary leading-relaxed mb-4">{lead.description}</p>
          )}

          {/* Details grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-2 mb-4 text-[13px]">
            {lead.industry && (
              <div className="flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-textMuted" />
                <span className="text-textSecondary">Industry:</span>
                <span className="text-textPrimary font-medium">{lead.industry}</span>
              </div>
            )}
            {lead.location && (
              <div className="flex items-center gap-2">
                <MapPin className="w-3.5 h-3.5 text-textMuted" />
                <span className="text-textSecondary">Location:</span>
                <span className="text-textPrimary font-medium">{lead.location}</span>
              </div>
            )}
            {lead.size && (
              <div className="flex items-center gap-2">
                <Users className="w-3.5 h-3.5 text-textMuted" />
                <span className="text-textSecondary">Team size:</span>
                <span className="text-textPrimary font-medium">{lead.size}</span>
              </div>
            )}
            {lead.rating && (
              <div className="flex items-center gap-2">
                <Star className="w-3.5 h-3.5 text-textMuted" />
                <span className="text-textSecondary">Rating:</span>
                <span className="text-textPrimary font-medium">{lead.rating}/5 ({lead.userRatingsTotal || 0} reviews)</span>
              </div>
            )}
          </div>

          {/* Website & Status */}
          <div className="space-y-3 mb-4">
            {hasRealWebsite && (
              <div className="flex items-start gap-3">
                <div className="w-5 h-5 rounded bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0 mt-0.5">
                  <Globe className="w-3 h-3 text-primary" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-textSecondary mb-1">
                    Website
                  </div>
                  {websiteCheck?.reachable ? (
                    <div className="flex items-center gap-2 text-[13px]">
                      <CheckCircle2 className="w-4 h-4 text-success" />
                      <span className="text-textPrimary">Verified — working</span>
                      {websiteCheck.title && <span className="text-textMuted">({websiteCheck.title})</span>}
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-[13px]">
                      <AlertCircle className="w-4 h-4 text-danger" />
                      <span className="text-textPrimary">Issue detected</span>
                      <span className="text-textMuted">— {websiteCheck?.error || 'Unreachable'}</span>
                    </div>
                  )}
                  {websiteCheck?.hasHttpError && (
                    <div className="text-[11px] text-warning mt-1">
                      ⚠️ Website has errors — opportunity for our {lead.recommended_service} service
                    </div>
                  )}
                  <a
                    href={lead.website}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-[12px] text-primary hover:text-blue-400 mt-1 max-w-[240px] truncate"
                  >
                    <ExternalLink className="w-3 h-3" />
                    {lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                </div>
              </div>
            )}

            {/* Google Maps */}
            {lead.google_maps_link && (
              <div className="flex items-start gap-3">
                <div className="w-5 h-5 rounded bg-primary/10 border border-primary/25 flex items-center justify-center shrink-0 mt-0.5">
                  <MapPin className="w-3 h-3 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-textSecondary mb-1">
                    Google Maps
                  </div>
                  <a
                    href={lead.google_maps_link}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1.5 text-[12px] text-primary hover:text-blue-400"
                  >
                    <ExternalLink className="w-3 h-3" />
                    View on Google Maps
                  </a>
                </div>
              </div>
            )}

            {/* Recommended Service */}
            {lead.recommended_service && (
              <div className="flex items-start gap-3">
                <div className="w-5 h-5 rounded bg-secondary/10 border border-secondary/25 flex items-center justify-center shrink-0 mt-0.5">
                  <Sparkles className="w-3 h-3 text-secondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-[12px] font-semibold uppercase tracking-wide text-textSecondary mb-1">
                    Recommended service
                  </div>
                  <span className="text-[13px] text-textPrimary font-medium">{lead.recommended_service}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Pitches */}
        <div className="w-full lg:w-96 lg:max-w-[400px] shrink-0">
          {lead.pitches.map((pitch) => (
            <PitchCard key={pitch.id} pitch={pitch} lead={lead} onManualCopy={onManualCopy} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function PitchCard({
  pitch,
  lead,
  onManualCopy,
}: {
  pitch: Pitch;
  lead: GeneratedLead;
  onManualCopy: (text: string) => void;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    onManualCopy(pitch.pitch);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="border border-muted rounded-xl p-4 bg-elevated/20 animate-slide-up">
      <div className="flex items-center justify-between mb-3">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-textSecondary flex items-center gap-1.5">
          <Mail className="w-3.5 h-3.5 text-primary" />
          Outreach pitch
        </div>
      </div>

      <div className="text-[13px] font-medium text-textPrimary mb-2.5">{pitch.subject}</div>

      <div className="text-[12px] text-textSecondary leading-relaxed whitespace-pre-wrap bg-surface border border-muted rounded-lg p-3 max-h-[160px] overflow-y-auto mb-3">
        {pitch.pitch}
      </div>

      <div className="flex gap-2">
        {lead.has_gmail && lead.contact_email ? (
          <Button size="sm" variant="secondary" className="flex-1">
            <Copy className="w-3.5 h-3.5" /> Copy to Gmail
          </Button>
        ) : (
          <div className="flex-1 text-center py-2 text-[11px] text-textSecondary bg-elevated border border-muted rounded-lg">
            No Gmail — copy manually
          </div>
        )}
        <Button size="sm" variant="ghost" onClick={handleCopy} className="flex-1">
          {copied ? <CheckCircle2 className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied!' : 'Copy text'}
        </Button>
      </div>
    </div>
  );
}
