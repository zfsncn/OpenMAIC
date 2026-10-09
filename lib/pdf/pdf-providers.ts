/**
 * PDF Parsing Provider Implementation
 *
 * Factory pattern for routing PDF parsing requests to appropriate provider implementations.
 * Follows the same architecture as lib/ai/providers.ts for consistency.
 *
 * Currently Supported Providers:
 * - unpdf: Built-in Node.js PDF parser with text and image extraction
 * - alidocmind: Aliyun Document Mind (LLM version) with OCR, formula, table and
 *   layout extraction
 *
 * HOW TO ADD A NEW PROVIDER:
 *
 * 1. Add provider ID to PDFProviderId in lib/pdf/types.ts
 *    Example: | 'tesseract-ocr'
 *
 * 2. Add provider configuration to lib/pdf/constants.ts
 *    Example:
 *    'tesseract-ocr': {
 *      id: 'tesseract-ocr',
 *      name: 'Tesseract OCR',
 *      requiresApiKey: false,
 *      icon: '/tesseract.svg',
 *      features: ['text', 'images', 'ocr']
 *    }
 *
 * 3. Implement provider function in this file
 *    Pattern: async function parseWithXxx(config, pdfBuffer): Promise<ParsedPdfContent>
 *    - Accept PDF as Buffer
 *    - Extract text, images, tables, formulas as needed
 *    - Return unified format:
 *      {
 *        text: string,               // Markdown or plain text
 *        images: string[],           // Base64 data URLs
 *        metadata: {
 *          pageCount: number,
 *          parser: string,
 *          ...                       // Provider-specific metadata
 *        }
 *      }
 *
 *    Example:
 *    async function parseWithTesseractOCR(
 *      config: PDFParserConfig,
 *      pdfBuffer: Buffer
 *    ): Promise<ParsedPdfContent> {
 *      const { createWorker } = await import('tesseract.js');
 *
 *      // Convert PDF pages to images
 *      const pdf = await getDocumentProxy(new Uint8Array(pdfBuffer));
 *      const numPages = pdf.numPages;
 *
 *      const texts: string[] = [];
 *      const images: string[] = [];
 *
 *      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
 *        // Render page to canvas/image
 *        const page = await pdf.getPage(pageNum);
 *        const viewport = page.getViewport({ scale: 2.0 });
 *        const canvas = createCanvas(viewport.width, viewport.height);
 *        const context = canvas.getContext('2d');
 *        await page.render({ canvasContext: context, viewport }).promise;
 *
 *        // OCR the image
 *        const worker = await createWorker('eng+chi_sim');
 *        const { data: { text } } = await worker.recognize(canvas.toBuffer());
 *        texts.push(text);
 *        await worker.terminate();
 *
 *        // Save image
 *        images.push(canvas.toDataURL());
 *      }
 *
 *      return {
 *        text: texts.join('\n\n'),
 *        images,
 *        metadata: {
 *          pageCount: numPages,
 *          parser: 'tesseract-ocr',
 *        },
 *      };
 *    }
 *
 * 4. Add case to parsePDF() switch statement
 *    case 'tesseract-ocr':
 *      result = await parseWithTesseractOCR(config, pdfBuffer);
 *      break;
 *
 * 5. Add i18n translations in lib/i18n.ts
 *    providerTesseractOCR: { zh: 'Tesseract OCR', en: 'Tesseract OCR' }
 *
 * 6. Update features in constants.ts to reflect parser capabilities
 *    features: ['text', 'images', 'ocr'] // OCR-capable
 *
 * Provider Implementation Patterns:
 *
 * Pattern 1: Local Node.js Parser (like unpdf)
 * - Import parsing library
 * - Process Buffer directly
 * - Extract text and images synchronously or asynchronously
 * - Convert images to base64 data URLs
 * - Return immediately
 *
 * Pattern 2: Remote API (like AliDocMind)
 * - Upload the document to the service
 * - Create / resume a job and get its id
 * - Poll for completion (with timeout)
 * - Download results (text, images, metadata)
 * - Parse and convert to unified format
 *
 * Pattern 3: OCR-based Parser (Tesseract, Google Vision)
 * - Render PDF pages to images
 * - Send images to OCR service
 * - Collect text from all pages
 * - Combine with layout analysis if available
 * - Return combined text and original images
 *
 * Image Extraction Best Practices:
 * - Always convert to base64 data URLs (data:image/png;base64,...)
 * - Use PNG for lossless quality
 * - Use sharp for efficient image processing
 * - Handle errors per image (don't fail entire parsing)
 * - Log extraction failures but continue processing
 *
 * Metadata Recommendations:
 * - pageCount: Number of pages in PDF
 * - parser: Provider ID for debugging
 * - processingTime: Time taken (auto-added)
 * - taskId/jobId: For async providers (useful for troubleshooting)
 * - Custom fields: imageMapping, pdfImages, tables, formulas, etc.
 *
 * Error Handling:
 * - Validate API key if requiresApiKey is true
 * - Throw descriptive errors for missing configuration
 * - For async providers, handle timeout and polling errors
 * - Log warnings for non-critical failures (e.g., single page errors)
 * - Always include provider name in error messages
 */

import { extractText, getDocumentProxy, extractImages } from 'unpdf';
import sharp from 'sharp';
import type { PDFParserConfig } from './types';
import type { ParsedPdfContent } from '@/lib/types/pdf';
import { PDF_PROVIDERS } from './constants';
import { createLogger } from '@/lib/logger';
import { parseWithAliDocMindClient } from './alidocmind-client';
import type { ExtractionProgress } from '@/lib/document/types';

const log = createLogger('PDFProviders');

/**
 * Caller-supplied extras for one parse run: what the document is called, and the
 * channels a long-running remote provider reports back on. Providers that cannot
 * observe progress or resume ignore both.
 */
export interface ParsePDFOptions {
  fileName?: string;
  mimeType?: string;
  /** Forwarded to providers that poll a remote job (see `ExtractionProgress`). */
  onProgress?: (progress: ExtractionProgress) => void;
  /** Resume the remote job this token names instead of submitting again. */
  resumeToken?: string;
}

/**
 * Parse PDF using specified provider
 */
export async function parsePDF(
  config: PDFParserConfig,
  pdfBuffer: Buffer,
  options?: ParsePDFOptions,
): Promise<ParsedPdfContent> {
  const provider = PDF_PROVIDERS[config.providerId];
  if (!provider) {
    throw new Error(`Unknown PDF provider: ${config.providerId}`);
  }

  // Validate API key if required
  if (provider.requiresApiKey && !config.apiKey) {
    // AliDocMind uses AK/SK instead of a single apiKey; check separately.
    const envAvailable = config.allowEnvFallback && !!process.env.ALIDOCMIND_ACCESS_KEY_ID;
    if (config.providerId !== 'alidocmind' || (!config.accessKeyId && !envAvailable)) {
      throw new Error(`API key required for PDF provider: ${config.providerId}`);
    }
  }

  const startTime = Date.now();

  let result: ParsedPdfContent;

  switch (config.providerId) {
    case 'unpdf':
      result = await parseWithUnpdf(pdfBuffer, config.textOnly === true);
      break;

    case 'alidocmind':
      result = await parseWithAliDocMind(config, pdfBuffer, options);
      break;

    default:
      throw new Error(`Unsupported PDF provider: ${config.providerId}`);
  }

  // Add processing time to metadata
  if (result.metadata) {
    result.metadata.processingTime = Date.now() - startTime;
  }

  return result;
}

/**
 * Parse PDF using unpdf (existing implementation)
 */
async function parseWithUnpdf(pdfBuffer: Buffer, textOnly = false): Promise<ParsedPdfContent> {
  const uint8Array = new Uint8Array(pdfBuffer);
  const pdf = await getDocumentProxy(
    uint8Array,
    textOnly
      ? {
          // Refuse pathological raster dimensions in the untrusted text-only path.
          maxImageSize: 16_000_000,
        }
      : {},
  );
  const numPages = pdf.numPages;

  // Extract text using the document proxy
  const { text: pdfText } = await extractText(pdf, {
    mergePages: true,
  });

  // Extract images using the same document proxy
  const images: string[] = [];
  const pdfImagesMeta: Array<{
    id: string;
    src: string;
    pageNumber: number;
    width: number;
    height: number;
  }> = [];
  let imageCounter = 0;

  for (let pageNum = 1; !textOnly && pageNum <= numPages; pageNum++) {
    try {
      const pageImages = await extractImages(pdf, pageNum);
      for (let i = 0; i < pageImages.length; i++) {
        const imgData = pageImages[i];
        try {
          // Use sharp to convert raw image data to PNG base64
          const pngBuffer = await sharp(Buffer.from(imgData.data), {
            raw: {
              width: imgData.width,
              height: imgData.height,
              channels: imgData.channels,
            },
          })
            .png()
            .toBuffer();

          // Convert to base64
          const base64 = `data:image/png;base64,${pngBuffer.toString('base64')}`;
          imageCounter++;
          const imgId = `img_${imageCounter}`;
          images.push(base64);
          pdfImagesMeta.push({
            id: imgId,
            src: base64,
            pageNumber: pageNum,
            width: imgData.width,
            height: imgData.height,
          });
        } catch (sharpError) {
          log.error(`Failed to convert image ${i + 1} from page ${pageNum}:`, sharpError);
        }
      }
    } catch (pageError) {
      log.error(`Failed to extract images from page ${pageNum}:`, pageError);
    }
  }

  return {
    text: pdfText,
    images,
    metadata: {
      pageCount: numPages,
      parser: 'unpdf',
      imageMapping: Object.fromEntries(pdfImagesMeta.map((m) => [m.id, m.src])),
      pdfImages: pdfImagesMeta,
    },
  };
}

/**
 * Parse a document via AliDocMind (Aliyun Document Mind LLM version).
 * Supports pdf/docx/pptx/xlsx and image types via the same submit → poll → get flow.
 */
async function parseWithAliDocMind(
  config: PDFParserConfig,
  documentBuffer: Buffer,
  options?: ParsePDFOptions,
): Promise<ParsedPdfContent> {
  const fileName = options?.fileName || 'document.pdf';
  const result = await parseWithAliDocMindClient(
    {
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      endpoint: config.baseUrl,
      allowEnvFallback: config.allowEnvFallback,
    },
    {
      buffer: documentBuffer,
      fileName,
      llmEnhancement: true,
      enhancementMode: 'VLM',
      outputHtmlTable: true,
    },
    {
      ...(options?.onProgress ? { onProgress: options.onProgress } : {}),
      ...(options?.resumeToken ? { resumeJobId: options.resumeToken } : {}),
    },
  );

  return aliDocMindLayoutsToParsedPdf(result, fileName);
}

/** Match markdown image syntax `![alt](url)`, capturing the alt text and URL. */
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g;

/**
 * Stand-in for an image reference inside the text being built.
 *
 * An image's final id is only known once every download has settled — a failed
 * download drops out of `pdfImages`, which shifts the ids of every image after
 * it. So the text is assembled with these tokens and resolved in a second pass,
 * once the surviving ids are known. `\u0000` cannot occur in the service's text,
 * so a token can never collide with real content.
 */
const imageRefToken = (index: number) => `\u0000aidm-img:${index}\u0000`;
const IMAGE_REF_TOKEN_RE = /!\[([^\]]*)\]\(\u0000aidm-img:(\d+)\u0000\)/g;

/** Max images downloaded per document (bounds memory + request fan-out). */
const ALIDOCMIND_MAX_IMAGES = 200;
/** Max bytes per image (bounds memory; AliDocMind crops are small PNGs). */
const ALIDOCMIND_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** Concurrent image downloads. */
const ALIDOCMIND_IMAGE_CONCURRENCY = 6;

/**
 * AliDocMind returns image URLs on Aliyun OSS. Restrict fetches to OSS hosts so
 * a compromised/custom endpoint can't turn image extraction into an SSRF vector
 * pointing at internal hosts. Matches `*.oss-*.aliyuncs.com` (and the
 * doc-mind-video bucket host family).
 */
/**
 * AliDocMind returns image URLs on Aliyun OSS. Restrict fetches to Aliyun OSS
 * hosts so a compromised/custom endpoint can't turn image extraction into an
 * SSRF vector pointing at internal hosts. Only `*.aliyuncs.com` over http/https
 * is allowed (OSS signed URLs are sometimes served over http; the fetch upgrades
 * them to https).
 */
function isTrustedAliyunOssUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    const host = u.hostname.toLowerCase();
    // Must be an oss-*.aliyuncs.com host (rules out arbitrary *.aliyuncs.com
    // subdomains that aren't object storage).
    return /(^|\.)oss-[a-z0-9-]+\.aliyuncs\.com$/.test(host);
  } catch {
    return false;
  }
}

/**
 * Download an AliDocMind image URL and return a PNG base64 data URL.
 * Only trusted Aliyun OSS hosts are fetched; downloads are size-capped and
 * redirects are disallowed (an OSS signed URL never needs one). Returns null on
 * any failure so one bad image never fails the whole parse.
 */
export async function fetchAliDocMindImageAsBase64(url: string): Promise<string | null> {
  if (!isTrustedAliyunOssUrl(url)) {
    log.warn(`[AliDocMind] refusing non-OSS image URL: ${url.slice(0, 80)}`);
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'error', // signed OSS URLs are direct; a redirect is suspicious
    });
    if (!res.ok) {
      log.warn(`[AliDocMind] image fetch ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    // Reject early on a declared oversized length…
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > ALIDOCMIND_MAX_IMAGE_BYTES) {
      log.warn(`[AliDocMind] image too large (${declared} bytes), skipping`);
      controller.abort();
      return null;
    }
    // …but a missing/false Content-Length can't be trusted, so stream and abort
    // the moment the cumulative byte count exceeds the cap — the whole body is
    // never buffered past the limit.
    const body = res.body;
    if (!body) return null;
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > ALIDOCMIND_MAX_IMAGE_BYTES) {
          log.warn(
            `[AliDocMind] image stream exceeded ${ALIDOCMIND_MAX_IMAGE_BYTES} bytes, aborting`,
          );
          controller.abort();
          await reader.cancel().catch(() => {});
          return null;
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const png = await sharp(buf).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch (err) {
    log.warn(
      `[AliDocMind] image fetch/convert failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Run `fn` over items with a bounded number of concurrent workers. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Map AliDocMind layouts[] shape → ParsedPdfContent.
 *
 * Layout schema (per AliDocMind docs):
 *   { text, markdownContent, type, subType, pageNum, level, index, uniqueId, alignment,
 *     llmResult?, layoutConf?, pos?, ... }
 *   type ∈ { title, text, figure, picture, table, formula, multicolumn, foot, head, ... }
 *
 * Images: figure/picture blocks embed OSS image URLs inside `markdownContent`
 * (markdown `![](url)`), NOT a dedicated field. We download+inline them to
 * base64 and strip the remote URLs from the emitted text (they expire).
 */
async function aliDocMindLayoutsToParsedPdf(
  result: { data: Record<string, unknown>; pageCountEstimate?: number; jobId?: string },
  fileName: string,
): Promise<ParsedPdfContent> {
  const layouts = (Array.isArray(result.data.layouts) ? result.data.layouts : []) as Array<{
    text?: string;
    markdownContent?: string;
    type?: string;
    subType?: string;
    pageNum?: number;
    llmResult?: string;
    layoutConf?: number;
  }>;

  const textParts: string[] = [];
  const layout: NonNullable<ParsedPdfContent['layout']> = [];
  const imageRefs: Array<{ url: string; pageNumber: number }> = [];
  let maxPage = 0;

  for (const l of layouts) {
    // AliDocMind pageNum is 0-based; normalize to 1-based page numbers.
    const pageNum = (l.pageNum ?? 0) + 1;
    maxPage = Math.max(maxPage, pageNum);

    // Tables carry their extracted content (HTML/markdown) in `llmResult` when
    // outputHtmlTable/LLM enhancement is on — markdownContent may be empty.
    const isTable = l.type === 'table';
    // figure/picture embed image URLs in markdownContent; a chart-type figure
    // may additionally have llmResult (chart→table).
    const isImage = l.type === 'figure' || l.type === 'picture';

    let md: string;
    if (isImage) {
      // Signed OSS URLs expire, so they cannot go into the text — but dropping
      // the block outright left the text with no reference to the image at all,
      // while the image itself still landed in `pdfImages`. Emit the same
      // `![](img_N)` the id-addressed rest of the pipeline expects.
      md = (l.markdownContent ?? '').replace(
        MARKDOWN_IMAGE_RE,
        (_whole, alt: string, url: string) => {
          if (!url || imageRefs.length >= ALIDOCMIND_MAX_IMAGES) return '';
          const index = imageRefs.length;
          imageRefs.push({ url, pageNumber: pageNum });
          // The alt text is kept; only the target is deferred. Replacing the
          // whole match with the bare token would drop the `![](...)` wrapper,
          // and a wrapper rebuilt later cannot tell a failed download (which
          // must vanish) from a succeeded one (which must stay).
          return `![${alt}](${imageRefToken(index)})`;
        },
      );
      // A chart figure's llmResult is the chart read out as a table — content
      // the picture alone does not carry — so keep it beside the reference.
      const chartText = l.llmResult ?? '';
      if (chartText && !md.includes(chartText)) {
        md = md ? `${md}\n\n${chartText}` : chartText;
      }
    } else if (isTable) {
      md = l.llmResult ?? l.markdownContent ?? l.text ?? '';
    } else {
      md = l.markdownContent ?? l.text ?? l.llmResult ?? '';
    }

    if (md) textParts.push(md);

    if (l.type) {
      const mappedType = mapLayoutType(l.type);
      if (mappedType) {
        layout.push({
          page: pageNum,
          type: mappedType,
          content: isTable ? (l.llmResult ?? '') : (l.text ?? l.markdownContent ?? ''),
        });
      }
    }
  }

  // Download images with bounded concurrency; keep the source page number so
  // downstream image→page association is correct. Failed downloads drop out.
  const fetched = await mapWithConcurrency(imageRefs, ALIDOCMIND_IMAGE_CONCURRENCY, async (ref) => {
    const src = await fetchAliDocMindImageAsBase64(ref.url);
    return src ? { src, pageNumber: ref.pageNumber } : null;
  });
  // Ids follow reference order, skipping the failures — so the second pass can
  // turn each token into the id its own image ended up with.
  const pdfImagesMeta: Array<{ id: string; src: string; pageNumber: number }> = [];
  const tokenIds = new Map<number, string>();
  fetched.forEach((image, index) => {
    if (!image) return;
    const id = `img_${pdfImagesMeta.length + 1}`;
    tokenIds.set(index, id);
    pdfImagesMeta.push({ id, src: image.src, pageNumber: image.pageNumber });
  });
  const images = pdfImagesMeta.map((m) => m.src);
  // Resolve the tokens now that the ids are final. The whole image syntax is
  // replaced, so a reference whose download failed disappears entirely rather
  // than lingering as a broken `![]()`: a link to an image that is not in
  // `images[]` dangles, and an empty one is noise.
  const text = textParts
    .map((part) =>
      part.replace(IMAGE_REF_TOKEN_RE, (_match, alt: string, index: string) => {
        const id = tokenIds.get(Number(index));
        return id ? `![${alt}](${id})` : '';
      }),
    )
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join('\n\n');

  return {
    text,
    images,
    layout: layout.length ? layout : undefined,
    metadata: {
      fileName,
      // AliDocMind pageNum and pageCountEstimate are both 0-based (verified
      // against a real response: a 14-page doc reports pageNum 0..13 and
      // pageCountEstimate 13). maxPage is already normalized to 1-based, so
      // prefer it; fall back to pageCountEstimate+1 only if we saw no blocks.
      pageCount: maxPage || (result.pageCountEstimate ?? 0) + 1,
      parser: 'alidocmind',
      taskId: result.jobId,
      imageMapping: Object.fromEntries(pdfImagesMeta.map((m) => [m.id, m.src])),
      pdfImages: pdfImagesMeta,
    },
  };
}

function mapLayoutType(type: string): 'title' | 'text' | 'image' | 'table' | 'formula' | null {
  switch (type) {
    case 'title':
      return 'title';
    case 'text':
    case 'multicolumn':
      return 'text';
    case 'figure':
    case 'picture':
      return 'image';
    case 'table':
      return 'table';
    case 'formula':
      return 'formula';
    default:
      return null;
  }
}

/**
 * Get current PDF parser configuration from settings store
 * Note: This function should only be called in browser context
 */
export async function getCurrentPDFConfig(): Promise<PDFParserConfig> {
  if (typeof window === 'undefined') {
    throw new Error('getCurrentPDFConfig() can only be called in browser context');
  }

  // Dynamic import to avoid circular dependency
  const { useSettingsStore } = await import('@/lib/store/settings');
  const { pdfProviderId, pdfProvidersConfig } = useSettingsStore.getState();

  const providerConfig = pdfProvidersConfig?.[pdfProviderId];

  return {
    providerId: pdfProviderId,
    apiKey: providerConfig?.apiKey,
    baseUrl: providerConfig?.baseUrl,
    accessKeyId: (providerConfig as { accessKeyId?: string })?.accessKeyId,
    accessKeySecret: (providerConfig as { accessKeySecret?: string })?.accessKeySecret,
  };
}

// Re-export from constants for convenience
export { getAllPDFProviders, getPDFProvider } from './constants';
