/**
 * PDF Provider Constants
 * Separated from pdf-providers.ts to avoid importing sharp in client components
 */

import type { PDFProviderId, PDFProviderConfig } from './types';

export const ALIDOCMIND_DEFAULT_BASE = 'https://docmind-api.cn-hangzhou.aliyuncs.com';

/**
 * PDF Provider Registry
 */
export const PDF_PROVIDERS: Record<PDFProviderId, PDFProviderConfig> = {
  unpdf: {
    id: 'unpdf',
    name: 'unpdf',
    requiresApiKey: false,
    icon: '/logos/unpdf.svg',
    features: ['text', 'images', 'metadata'],
  },

  alidocmind: {
    id: 'alidocmind',
    name: 'AliDocMind',
    requiresApiKey: true,
    icon: '/logos/aliyun.svg',
    features: ['text', 'images', 'tables', 'formulas', 'layout-analysis', 'ocr'],
  },
};

/**
 * Get all available PDF providers
 */
export function getAllPDFProviders(): PDFProviderConfig[] {
  return Object.values(PDF_PROVIDERS);
}

/**
 * Get PDF provider by ID
 */
export function getPDFProvider(providerId: PDFProviderId): PDFProviderConfig | undefined {
  return PDF_PROVIDERS[providerId];
}
