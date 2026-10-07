export * from './env.js';

export const APP_CONSTANTS = {
  NAME: 'Kindred AidTrail Registry API',
  VERSION: '1.0.0',
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  SUPPORTED_DOCUMENT_MIME_TYPES: [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
  ],
  MAX_DOCUMENT_SIZE_BYTES: 10 * 1024 * 1024, // 10 MB
  SUPPORTED_CATEGORIES: [
    'FOOD',
    'HEALTH',
    'SHELTER',
    'EDUCATION',
    'UTILITIES',
    'EMERGENCY',
  ] as const,
} as const;

export type SupportedCategory = typeof APP_CONSTANTS.SUPPORTED_CATEGORIES[number];
