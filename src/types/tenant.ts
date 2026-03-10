// src/types/tenant.ts
// TenantContext and TenantRow — verified against 1001_brain_tenants.sql DDL

export interface TenantContext {
  tenantId: string           // Stable ID derived from CF Access JWT sub via HKDF
  hindsightTenantId: string  // Hindsight's internal UUID for this tenant
  region: 'us' | 'eu'
  isNewTenant: boolean       // True only on first-ever auth
}

export interface TenantRow {
  id: string
  created_at: number
  updated_at: number
  data_region: string
  primary_channel: string
  primary_phone: string | null
  primary_email: string | null
  hindsight_tenant_id: string
  cron_kek_encrypted: string | null
  cron_kek_expires_at: number | null
  ai_cost_daily_usd: number
  ai_cost_monthly_usd: number
  ai_cost_reset_at: number
  ai_ceiling_daily_usd: number
  ai_ceiling_monthly_usd: number
  obsidian_sync_enabled: number
  obsidian_drive_folder: string | null
}
