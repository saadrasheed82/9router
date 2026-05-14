import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isSupabaseConfigured,
  getSupabasePublicConfig,
  getSupabaseServiceConfig,
  isSupabaseSyncEnabled,
} from "../../src/lib/supabase/config.js";

const ORIGINAL_ENV = { ...process.env };

describe("supabase config", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("reports disabled when url or anon key is missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(isSupabaseConfigured()).toBe(false);
  });

  it("returns public client config when env is present", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    expect(isSupabaseConfigured()).toBe(true);
    expect(getSupabasePublicConfig()).toEqual({
      url: "https://example.supabase.co",
      anonKey: "anon-key",
    });
  });

  it("reports sync disabled when SUPABASE_SYNC_ENABLED is false", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SYNC_ENABLED = "false";
    expect(isSupabaseSyncEnabled()).toBe(false);
  });

  it("reports sync enabled when all env vars are present", () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SYNC_ENABLED = "true";
    expect(isSupabaseSyncEnabled()).toBe(true);
  });
});