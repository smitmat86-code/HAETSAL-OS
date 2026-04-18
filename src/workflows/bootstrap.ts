// src/workflows/bootstrap.ts
// Cloudflare Workflow: durable 3-phase bootstrap import
// Phase A: Wait for interview completion (polls D1)
// Phase B: Historical import (Gmail 12mo, Calendar 24mo, Drive 36mo)
// Phase C: Handoff (status update + WebSocket push)
// Each step.do() is independently retryable and durable across Worker restarts

import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from 'cloudflare:workers'
import type { Env } from '../types/env'
import type { BootstrapParams } from '../types/bootstrap'
import { getGoogleToken } from '../services/google/oauth'
import {
  importGmailHistory,
  importCalendarHistory,
  importDriveHistory,
} from '../services/bootstrap/historical-import'
import { broadcastEvent } from '../services/action/executor'
import {
  ensureHindsightBankConfigured,
} from '../services/bootstrap/hindsight-config'
import { getMcpAgentObjectName } from '../workers/mcpagent/do/identity'

export class BootstrapWorkflow extends WorkflowEntrypoint<Env, BootstrapParams> {
  async run(event: WorkflowEvent<BootstrapParams>, step: WorkflowStep) {
    const { tenantId, skipInterview } = event.payload
    const gmailMonths = event.payload.importMonthsGmail ?? 12
    const calendarMonths = event.payload.importMonthsCalendar ?? 24
    const driveMonths = event.payload.importMonthsDrive ?? 36

    // Phase A: Wait for interview completion (skip if requested)
    if (!skipInterview) {
      await step.do('await-interview', { retries: { limit: 100, delay: '30 seconds', backoff: 'constant' }, timeout: '30 minutes' }, async () => {
        const row = await this.env.D1_US.prepare(
          'SELECT interview_completed_at FROM tenants WHERE id = ?',
        ).bind(tenantId).first<{ interview_completed_at: number | null }>()
        if (!row?.interview_completed_at) {
          throw new Error('Interview not yet complete — retry')
        }
        return true
      })
    }

    // Update status to import_in_progress
    await step.do('mark-import-start', async () => {
      await this.env.D1_US.prepare(
        "UPDATE tenants SET bootstrap_status = 'import_in_progress', updated_at = ? WHERE id = ?",
      ).bind(Date.now(), tenantId).run()
    })

    // Phase B: Historical import — get TMK from DO for token decryption
    const doId = this.env.MCPAGENT.idFromName(getMcpAgentObjectName(tenantId))
    const stub = this.env.MCPAGENT.get(doId) as DurableObjectStub<never>

    // Import Gmail (12 months default)
    const gmailCount = await step.do('import-gmail', { timeout: '10 minutes' }, async () => {
      // @ts-expect-error — DO RPC method
      const tmk: CryptoKey | null = await stub.getTmk()
      if (!tmk) return 0
      const token = await getGoogleToken(tenantId, 'gmail.readonly', tmk, this.env)
      if (!token) return 0
      return await importGmailHistory(tenantId, gmailMonths, token, this.env)
    })

    // Import Calendar (24 months default)
    const calendarCount = await step.do('import-calendar', { timeout: '10 minutes' }, async () => {
      // @ts-expect-error — DO RPC method
      const tmk: CryptoKey | null = await stub.getTmk()
      if (!tmk) return 0
      const token = await getGoogleToken(tenantId, 'calendar.readonly', tmk, this.env)
      if (!token) return 0
      return await importCalendarHistory(tenantId, calendarMonths, token, this.env)
    })

    // Import Drive (36 months default, capped at 500)
    const driveCount = await step.do('import-drive', { timeout: '10 minutes' }, async () => {
      // @ts-expect-error — DO RPC method
      const tmk: CryptoKey | null = await stub.getTmk()
      if (!tmk) return 0
      const token = await getGoogleToken(tenantId, 'drive.readonly', tmk, this.env)
      if (!token) return 0
      return await importDriveHistory(tenantId, driveMonths, token, this.env)
    })

    // Phase C-1: Hindsight configuration (2.4a addendum)
    // Order: bank config → mental models → webhook. Each step retries independently.
    const bankId = await step.do('lookup-hindsight-bank', async () => {
      const row = await this.env.D1_US.prepare(
        'SELECT hindsight_tenant_id FROM tenants WHERE id = ?',
      ).bind(tenantId).first<{ hindsight_tenant_id: string }>()
      return row?.hindsight_tenant_id ?? ''
    })

    if (bankId) {
      await step.do('ensure-hindsight-bank-configured', async () => {
        await ensureHindsightBankConfigured(bankId, tenantId, this.env)
      })
    }

    // Phase C-2: Handoff
    const totalImported = gmailCount + calendarCount + driveCount
    await step.do('bootstrap-complete', async () => {
      const now = Date.now()
      await this.env.D1_US.batch([
        this.env.D1_US.prepare(
          `UPDATE tenants SET bootstrap_status = 'completed', bootstrap_completed_at = ?,
           bootstrap_items_imported = ?, updated_at = ? WHERE id = ?`,
        ).bind(now, totalImported, now, tenantId),
        this.env.D1_US.prepare(
          `INSERT INTO memory_audit (id, tenant_id, created_at, operation, memory_type, domain, provenance, salience_tier)
           VALUES (?, ?, ?, 'bootstrap.completed', 'semantic', 'general', 'system', 1)`,
        ).bind(crypto.randomUUID(), tenantId, now),
      ])

      await broadcastEvent(this.env, tenantId, {
        type: 'bootstrap.completed',
        items_imported: totalImported,
        gmail_imported: gmailCount,
        calendar_imported: calendarCount,
        drive_imported: driveCount,
      })
    })
  }
}
