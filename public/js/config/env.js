/* ==========================================================================
   Shinzora — runtime configuration
   --------------------------------------------------------------------------
   ONLY public values live here. The Supabase publishable key is designed for
   browser use and is protected by Row Level Security. Secrets (Gemini key,
   service_role, Razorpay secret, OAuth client secrets) are read exclusively
   inside Supabase Edge Functions from Deno environment variables.

   scripts/generate-config.mjs rewrites this file from environment variables
   during `npm run build`; window.__SHINZORA_ENV__ can also override values at
   runtime (useful for staging deployments without rebuilding).
   ========================================================================== */

const FALLBACK = {
  SUPABASE_URL: "https://zmkgfmlcpzjfgxdmbtvi.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fXoUaZPWuEceigIlk63htA_WavvP5Al",
  SITE_URL: "",
  SUPPORT_EMAIL: "official.shinzora@proton.me",
  APP_NAME: "Shinzora",
  ENVIRONMENT: "production"
};

const runtime = typeof window !== "undefined" && window.__SHINZORA_ENV__ ? window.__SHINZORA_ENV__ : {};
const merged = { ...FALLBACK, ...runtime };

const trimSlash = (value = "") => String(value).replace(/\/+$/, "");

export const env = Object.freeze({
  /* --- Supabase ---------------------------------------------------------- */
  supabaseUrl: trimSlash(merged.SUPABASE_URL),
  supabaseKey: merged.SUPABASE_PUBLISHABLE_KEY,
  functionsUrl: `${trimSlash(merged.SUPABASE_URL)}/functions/v1`,
  storageUrl: `${trimSlash(merged.SUPABASE_URL)}/storage/v1`,

  /* --- Brand ------------------------------------------------------------- */
  appName: merged.APP_NAME,
  supportEmail: merged.SUPPORT_EMAIL,
  environment: merged.ENVIRONMENT,

  /* --- Derived ----------------------------------------------------------- */
  siteUrl: trimSlash(merged.SITE_URL) || (typeof location !== "undefined" ? location.origin : ""),
  isConfigured: Boolean(merged.SUPABASE_URL && merged.SUPABASE_PUBLISHABLE_KEY)
});

/** Absolute redirect URL used by Supabase auth emails. */
export function authRedirect(path = "/app/") {
  const base = env.siteUrl || (typeof location !== "undefined" ? location.origin : "");
  return `${trimSlash(base)}${path}`;
}

/* --------------------------------------------------------------------------
   Plan catalogue — the UI mirror of the server-side limits enforced by the
   `ai_usage_quota` function and the Edge Function AI proxy. Prices are in
   paise (minor units) so money maths never touches floats.
   -------------------------------------------------------------------------- */
export const PLANS = [
  {
    id: "free",
    name: "Free",
    tagline: "Validate an idea and ship a first page.",
    priceMonthly: 0,
    priceYearly: 0,
    aiMonthlyCredits: 30,
    projects: 1,
    domains: 0,
    seats: 1,
    removeBranding: false,
    features: [
      "1 project (website, app or store)",
      "AI assistant — 30 generations / month",
      "Shinzora subdomain publishing (with Shinzora badge)",
      "Single-page version history",
      "Community support"
    ],
    cta: "Start free"
  },
  {
    id: "pro",
    name: "Pro",
    tagline: "For founders running the whole business here.",
    priceMonthly: 249900,
    priceYearly: 2499000,
    aiMonthlyCredits: 800,
    projects: 15,
    domains: 5,
    seats: 3,
    removeBranding: true,
    popular: true,
    features: [
      "15 projects, multi-page generation",
      "AI assistant — 800 generations / month",
      "Store, inventory, orders and customers",
      "Custom domain connection + DNS manager",
      "Shinzora badge removed from published sites",
      "GitHub + Vercel deployment pipeline",
      "Marketing, support automation, analytics",
      "Email support within 24 hours"
    ],
    cta: "Choose Pro"
  },
  {
    id: "enterprise",
    name: "Enterprise",
    tagline: "Managed operations for established teams.",
    priceMonthly: 999900,
    priceYearly: 9999000,
    aiMonthlyCredits: 6000,
    projects: 100,
    domains: 25,
    seats: 20,
    removeBranding: true,
    features: [
      "100 projects and unlimited pages",
      "AI assistant — 6,000 generations / month",
      "Priority AI queue and larger context",
      "Managed domain + registrar workflow",
      "Shinzora badge removed, priority rendering",
      "Team seats with role-based access",
      "Dedicated onboarding and account review",
      "Priority support channel"
    ],
    cta: "Contact us"
  }
];

export const planById = (id) => PLANS.find((p) => p.id === id) || PLANS[0];

/** Server-enforced limits, mirrored for display before the API responds. */
export const PLAN_LIMITS = Object.fromEntries(
  PLANS.map((p) => [
    p.id,
    {
      projects: p.projects,
      domains: p.domains,
      aiMonthlyCredits: p.aiMonthlyCredits,
      removeBranding: Boolean(p.removeBranding)
    }
  ])
);

export const BUSINESS_CATEGORIES = [
  "Fashion & apparel",
  "Beauty & personal care",
  "Food & beverage",
  "Retail & e-commerce",
  "Professional services",
  "Creative & design",
  "Technology & SaaS",
  "Education",
  "Health & wellness",
  "Real estate",
  "Travel & hospitality",
  "Manufacturing",
  "Logistics",
  "Finance",
  "Media & entertainment",
  "Other"
];

export const BUSINESS_STAGES = [
  { id: "idea", label: "Idea stage", desc: "Exploring the concept, nothing launched yet." },
  { id: "starting", label: "Just starting", desc: "Building the first version right now." },
  { id: "operating", label: "Operating", desc: "Selling or serving customers already." },
  { id: "growing", label: "Growing", desc: "Established, looking to scale." }
];

export const GOAL_OPTIONS = [
  { id: "website", label: "Create a website", icon: "panels-top-left" },
  { id: "app", label: "Build a web application", icon: "blocks" },
  { id: "ecommerce", label: "Launch an online store", icon: "store" },
  { id: "domain", label: "Purchase a domain", icon: "globe" },
  { id: "inventory", label: "Manage inventory", icon: "boxes" },
  { id: "marketing", label: "Run marketing", icon: "megaphone" },
  { id: "support", label: "Automate support", icon: "life-buoy" },
  { id: "operations", label: "Manage the whole business", icon: "workflow" }
];

export const WEBSITE_STYLES = [
  "Editorial & minimal",
  "Bold & expressive",
  "Warm & approachable",
  "Technical & precise",
  "Luxury & restrained",
  "Playful & bright"
];

export const DOMAIN_EXTENSIONS = [".com", ".in", ".co", ".shop", ".store", ".io", ".design", ".studio"];

export const TARGET_AUDIENCES = [
  "Consumers (B2C)",
  "Businesses (B2B)",
  "Both consumers and businesses",
  "Local customers",
  "International customers"
];
