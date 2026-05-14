export function getSupabasePublicConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "",
  };
}

export function getSupabaseServiceConfig() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL || "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
  };
}

export function isSupabaseConfigured() {
  const { url, anonKey } = getSupabasePublicConfig();
  return Boolean(url && anonKey);
}

export function isSupabaseSyncEnabled() {
  return process.env.SUPABASE_SYNC_ENABLED === "true" && isSupabaseConfigured();
}