import { parsePDF } from '@/lib/pdf/pdf-providers';
import { PDF_PROVIDERS } from '@/lib/pdf/constants';
import type { PDFProviderId } from '@/lib/pdf/types';
import { parsedPdfToDocumentArtifact } from '../pdf-compat';
import type { DocumentExtractorInput, DocumentExtractorProvider } from '../types';
import { getDocumentExtractorManifestEntry, type DocumentExtractorManifestEntry } from './manifest';

/** The manifest entry backing a PDF provider, or a loud failure at module init. */
function pdfManifestEntry(id: PDFProviderId): DocumentExtractorManifestEntry {
  const entry = getDocumentExtractorManifestEntry(id);
  if (!entry) {
    throw new Error(`No document extractor manifest entry for PDF provider "${id}"`);
  }
  return entry;
}

function createPdfBackedDocumentExtractor(id: PDFProviderId): DocumentExtractorProvider {
  return {
    // Metadata comes from the browser-safe manifest — single source of truth
    // for the extractor identity (RFC #1153 part 1); the implementation is
    // attached here. `pdfManifestEntry` throws at module init if a
    // PDF_PROVIDERS entry ever lacks a manifest entry, and the registry sync
    // test pins the reverse direction (no orphan manifest entries).
    ...pdfManifestEntry(id),
    async extract(input: DocumentExtractorInput) {
      const config = {
        providerId: id,
        apiKey: input.config.apiKey,
        baseUrl: input.config.baseUrl,
        accessKeyId: input.config.accessKeyId,
        accessKeySecret: input.config.accessKeySecret,
        allowEnvFallback: input.config.allowEnvFallback,
        textOnly: input.config.textOnly,
        managed: input.config.managed,
      };
      let parsed;
      if (id === 'alidocmind') {
        // AliDocMind handles pdf/docx/pptx/xlsx/images through one flow, and
        // that flow is a remote job: the service publishes its own percentage
        // while it runs and keeps the job queryable after it ends, so both a
        // progress report and a resume handle exist to pass along.
        parsed = await parsePDF(config, input.buffer, {
          fileName: input.fileName,
          mimeType: input.mimeType,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          ...(input.resumeToken ? { resumeToken: input.resumeToken } : {}),
        });
      } else {
        // unpdf is PDF-only: the registry pins its supported MIME types, so a
        // non-PDF input never reaches this branch.
        parsed = await parsePDF(config, input.buffer);
      }

      return parsedPdfToDocumentArtifact(parsed, input);
    },
  };
}

export const pdfDocumentExtractorProviders: DocumentExtractorProvider[] = Object.keys(
  PDF_PROVIDERS,
).map((id) => createPdfBackedDocumentExtractor(id as PDFProviderId));
