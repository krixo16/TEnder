import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import multer from 'multer';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import type { BidChecklist, CompanyProfile, RequiredDocumentSpec } from './src/types.ts';
import {
  type AssistantTenderContextInput,
  MCP_TOOL_CATALOG,
  analyzeTenderUrlWithPythonMcp,
  askProcurementAssistant,
  checkDocumentExpiry,
  checkEligibility,
  extractTenderRequirements,
  generateBidChecklist,
  hasGeminiKey,
  monitorCorrigendum,
  searchTenders,
} from './server/mcpTools.ts';
import { getVoiceStatus, synthesizeWithElevenLabs } from './server/voice.ts';
import {
  getChecklistByTender,
  getCompanyProfile,
  getRecentAnalyses,
  resetCompanyProfile,
  saveAnalysis,
  saveChecklist,
  saveCompanyProfile,
  toggleCorrigendumAck,
} from './server/store.ts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF tender documents (.pdf) are supported.'));
    }
  },
});

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '5mb' }));

  // Health & MCP Tool Registry
  app.get('/api/health', (_req, res) => {
    const voice = getVoiceStatus();
    res.json({
      ok: true,
      service: 'tenderbridge-api',
      geminiConfigured: hasGeminiKey(),
      elevenLabsConfigured: voice.elevenLabsConfigured,
    });
  });

  app.get('/api/mcp/tools', (_req, res) => {
    res.json({ tools: MCP_TOOL_CATALOG });
  });

  // MCP Tool 1: search_tenders
  app.get('/api/mcp/search_tenders', (req, res) => {
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : '';
    const category = typeof req.query.category === 'string' ? req.query.category : 'All';
    const location = typeof req.query.location === 'string' ? req.query.location : 'All';
    const source = typeof req.query.source === 'string' ? req.query.source : 'All';
    const deadlineDaysRaw =
      typeof req.query.deadlineDays === 'string' ? Number(req.query.deadlineDays) : null;
    const tenders = searchTenders({
      keyword,
      category,
      location,
      source,
      deadlineDays: deadlineDaysRaw && !Number.isNaN(deadlineDaysRaw) ? deadlineDaysRaw : null,
    });
    res.json({ tenders, total: tenders.length });
  });

  // MCP Tool 2: extract_tender_requirements (PDF upload or DEMO tender)
  app.post('/api/mcp/extract_tender_requirements', (req, res) => {
    upload.single('file')(req, res, async (uploadErr) => {
      if (uploadErr) {
        res.status(400).json({ error: uploadErr.message || 'Invalid file upload.' });
        return;
      }

      try {
        const demoTenderId =
          typeof req.body?.demoTenderId === 'string' ? req.body.demoTenderId : undefined;

        const analysis = await extractTenderRequirements({
          fileBuffer: req.file?.buffer,
          mimeType: req.file?.mimetype,
          fileName: req.file?.originalname,
          demoTenderId,
        });

        res.json({ analysis });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'PDF extraction failed.';
        res.status(500).json({ error: message });
      }
    });
  });

  app.get('/api/analyses', (_req, res) => {
    res.json({ analyses: getRecentAnalyses() });
  });

  // MCP Tool 7: analyze_tender_url (Python MCP Engine)
  app.post('/api/mcp/analyze_tender_url', async (req, res) => {
    try {
      const { url } = req.body as { url?: string };
      if (!url || typeof url !== 'string' || !url.trim()) {
        res.status(400).json({ error: 'A valid government procurement tender URL is required.' });
        return;
      }

      const result = await analyzeTenderUrlWithPythonMcp(url.trim());
      if (result.analysis) {
        saveAnalysis(result.analysis);
      }
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tender URL analysis failed.';
      res.status(500).json({ error: message });
    }
  });

  // MCP Tool 3: check_eligibility
  app.post('/api/mcp/check_eligibility', async (req, res) => {
    try {
      const { tender, profile } = req.body as {
        tender?: {
          title: string;
          referenceNo: string;
          estimatedValueInr: number;
          emdInr: number;
          msmeEmdExempt: boolean;
          eligibilityCriteria: {
            minTurnoverInr: number;
            minYearsExperience: number;
            requiredCertifications: string[];
            sectorKeywords: string[];
            msmeTurnoverRelaxation: boolean;
            specialNotes: string;
          };
          requiredDocuments: RequiredDocumentSpec[];
        };
        profile?: CompanyProfile;
      };

      if (!tender || !tender.title || !tender.eligibilityCriteria) {
        res.status(400).json({ error: 'Active tender details are required for eligibility check.' });
        return;
      }

      const activeProfile = profile ?? getCompanyProfile();
      const assessment = await checkEligibility({ tender, profile: activeProfile });
      res.json({ assessment });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Eligibility assessment failed.';
      res.status(500).json({ error: message });
    }
  });

  // MCP Tool 4: check_document_expiry
  app.post('/api/mcp/check_document_expiry', (req, res) => {
    try {
      const { tenderTitle, referenceNo, requiredDocuments, companyDocuments } = req.body as {
        tenderTitle?: string;
        referenceNo?: string;
        requiredDocuments?: RequiredDocumentSpec[];
        companyDocuments?: CompanyProfile['documents'];
      };

      if (!Array.isArray(requiredDocuments)) {
        res.status(400).json({ error: 'requiredDocuments array is required.' });
        return;
      }

      const activeDocs = companyDocuments ?? getCompanyProfile().documents;
      const report = checkDocumentExpiry({
        tenderTitle: tenderTitle || 'Active Tender',
        referenceNo: referenceNo || '—',
        requiredDocuments,
        companyDocuments: activeDocs,
      });

      res.json({ report });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Document expiry check failed.';
      res.status(500).json({ error: message });
    }
  });

  // MCP Tool 5: monitor_corrigendum
  app.get('/api/mcp/monitor_corrigendum', (req, res) => {
    const tenderId = typeof req.query.tenderId === 'string' ? req.query.tenderId : 'All';
    const changeType = typeof req.query.changeType === 'string' ? req.query.changeType : 'All';
    const keyword = typeof req.query.keyword === 'string' ? req.query.keyword : '';
    const corrigenda = monitorCorrigendum({ tenderId, changeType, keyword });
    res.json({ corrigenda });
  });

  app.post('/api/corrigenda/:id/ack', (req, res) => {
    const updated = toggleCorrigendumAck(req.params.id);
    if (!updated) {
      res.status(404).json({ error: 'Corrigendum not found.' });
      return;
    }
    res.json({ corrigendum: updated });
  });

  // MCP Tool 6: generate_bid_checklist
  app.post('/api/mcp/generate_bid_checklist', async (req, res) => {
    try {
      const {
        tenderId,
        tenderTitle,
        referenceNo,
        deadlineDate,
        preBidDate,
        msmeEmdExempt,
        emdInr,
        requiredDocuments,
      } = req.body as {
        tenderId: string;
        tenderTitle: string;
        referenceNo: string;
        deadlineDate: string;
        preBidDate?: string;
        msmeEmdExempt: boolean;
        emdInr: number;
        requiredDocuments: RequiredDocumentSpec[];
      };

      if (!tenderId || !tenderTitle) {
        res.status(400).json({ error: 'Tender ID and title are required.' });
        return;
      }

      const profile = getCompanyProfile();
      const gapReport = checkDocumentExpiry({
        tenderTitle,
        referenceNo: referenceNo || '—',
        requiredDocuments: requiredDocuments ?? [],
        companyDocuments: profile.documents,
      });

      const checklist = await generateBidChecklist({
        tenderId,
        tenderTitle,
        referenceNo: referenceNo || '—',
        deadlineDate: deadlineDate || '2026-12-30',
        preBidDate,
        msmeEmdExempt: Boolean(msmeEmdExempt),
        emdInr: Number(emdInr) || 0,
        requiredDocuments: requiredDocuments ?? [],
        gapReport,
        profile,
      });

      res.json({ checklist });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Checklist generation failed.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/checklists/:tenderId', (req, res) => {
    const checklist = getChecklistByTender(req.params.tenderId);
    res.json({ checklist });
  });

  app.put('/api/checklists/:tenderId', (req, res) => {
    const body = req.body as BidChecklist;
    if (!body || body.tenderId !== req.params.tenderId) {
      res.status(400).json({ error: 'Invalid checklist payload.' });
      return;
    }
    const saved = saveChecklist(body);
    res.json({ checklist: saved });
  });

  // Company Profile CRUD
  app.get('/api/profile', (_req, res) => {
    res.json({ profile: getCompanyProfile() });
  });

  app.put('/api/profile', (req, res) => {
    const body = req.body as CompanyProfile;
    if (!body || !body.companyName) {
      res.status(400).json({ error: 'Company name is required.' });
      return;
    }
    const saved = saveCompanyProfile(body);
    res.json({ profile: saved });
  });

  app.post('/api/profile/reset', (_req, res) => {
    const profile = resetCompanyProfile();
    res.json({ profile });
  });

  // AI Procurement Assistant (TenderBridge Intelligence)
  app.post('/api/assistant/chat', async (req, res) => {
    try {
      const { message, history, activeTender, profile, includeActiveTenderContext } = req.body as {
        message?: string;
        history?: Array<{ role: 'user' | 'assistant'; content: string }>;
        activeTender?: AssistantTenderContextInput | null;
        profile?: CompanyProfile;
        includeActiveTenderContext?: boolean;
      };

      if (!message || !message.trim()) {
        res.status(400).json({ error: 'Please enter a message before sending.' });
        return;
      }

      const activeProfile = profile ?? getCompanyProfile();
      const result = await askProcurementAssistant({
        message,
        history: Array.isArray(history) ? history : [],
        activeTender: activeTender ?? null,
        profile: activeProfile,
        includeActiveTenderContext,
      });

      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Assistant request failed.';
      res.status(500).json({ error: msg });
    }
  });

  // Voice Assistant (ElevenLabs TTS + Browser Fallback Status)
  app.get('/api/voice/status', (_req, res) => {
    res.json(getVoiceStatus());
  });

  app.post('/api/voice/synthesize', async (req, res) => {
    try {
      const { text, voiceId } = req.body as { text?: string; voiceId?: string };
      if (!text || !text.trim()) {
        res.status(400).json({ error: 'Text is required for voice synthesis.' });
        return;
      }

      const result = await synthesizeWithElevenLabs({ text, voiceId });
      if (result.mode === 'fallback') {
        res.json({ fallback: 'browser-tts', reason: result.reason });
        return;
      }

      res.setHeader('Content-Type', result.contentType);
      res.setHeader('X-Voice-Provider', 'elevenlabs');
      res.setHeader('X-Voice-Id', result.voiceId);
      res.send(result.buffer);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Voice synthesis failed.';
      res.status(500).json({ error: msg });
    }
  });

  // Vite middleware in development, static dist in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`TenderBridge server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start TenderBridge server:', err);
  process.exit(1);
});
