import { createClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig, getSupabaseServiceConfig } from "./config.js";

let publicClient = null;
let serviceClient = null;

export function getSupabaseClient() {
  if (publicClient) return publicClient;
  const { url, anonKey } = getSupabasePublicConfig();
  if (!url || !anonKey) return null;
  publicClient = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return publicClient;
}

export function getSupabaseServiceClient() {
  if (serviceClient) return serviceClient;
  const { url, serviceRoleKey } = getSupabaseServiceConfig();
  if (!url || !serviceRoleKey) return null;
  serviceClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return serviceClient;
}