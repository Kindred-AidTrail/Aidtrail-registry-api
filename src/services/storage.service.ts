import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { APP_CONSTANTS } from '../config/index.js';
import { cryptoService } from './crypto.service.js';

export interface UploadResult {
  s3Key: string;
  fileHash: string;
  sizeBytes: number;
  mimeType: string;
}

export class StorageService {
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor() {
    this.bucketName = env.S3_BUCKET_NAME;
    this.client = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }

  /**
   * Uploads a document to S3/MinIO with SHA-256 verification and metadata tagging.
   */
  public async uploadDocument(params: {
    buffer: Buffer;
    filename: string;
    mimeType: string;
    userId: string;
    docType: string;
  }): Promise<UploadResult> {
    const { buffer, filename, mimeType, userId, docType } = params;

    // 1. Validate file size
    if (buffer.length > APP_CONSTANTS.MAX_DOCUMENT_SIZE_BYTES) {
      throw new Error(
        `File exceeds maximum permitted size of ${APP_CONSTANTS.MAX_DOCUMENT_SIZE_BYTES / (1024 * 1024)}MB`
      );
    }

    // 2. Validate MIME type
    const isSupportedMime = APP_CONSTANTS.SUPPORTED_DOCUMENT_MIME_TYPES.includes(
      mimeType as any
    );
    if (!isSupportedMime) {
      throw new Error(`Unsupported document MIME type: ${mimeType}`);
    }

    // 3. Compute SHA-256 integrity hash
    const fileHash = cryptoService.hashSha256(buffer);
    const extension = filename.split('.').pop()?.toLowerCase() || 'bin';
    const timestamp = Date.now();
    const sanitizedDocType = docType.replace(/[^a-zA-Z0-9_-]/g, '_');
    const s3Key = `documents/${userId}/${timestamp}_${sanitizedDocType}_${fileHash.slice(0, 8)}.${extension}`;

    // 4. Dispatch S3 PutObject
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
      Body: buffer,
      ContentType: mimeType,
      Metadata: {
        'x-aidtrail-sha256': fileHash,
        'x-aidtrail-doctype': sanitizedDocType,
        'x-aidtrail-userid': userId,
      },
    });

    await this.client.send(command);

    return {
      s3Key,
      fileHash,
      sizeBytes: buffer.length,
      mimeType,
    };
  }

  /**
   * Generates a time-limited presigned URL for downloading the document.
   */
  public async getDownloadPresignedUrl(
    s3Key: string,
    expiresInSeconds = 900
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  /**
   * Deletes a document from storage for GDPR right to erasure compliance.
   */
  public async deleteDocument(s3Key: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
    });
    await this.client.send(command);
  }

  /**
   * Verifies that the document exists and has not been tampered with.
   */
  public async verifyDocumentIntegrity(
    s3Key: string,
    expectedHash: string
  ): Promise<boolean> {
    try {
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: s3Key,
      });
      const response = await this.client.send(getCommand);
      const streamToBuffer = async (stream: any): Promise<Buffer> => {
        const chunks: any[] = [];
        for await (const chunk of stream) {
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      };

      const buffer = await streamToBuffer(response.Body);
      const computedHash = cryptoService.hashSha256(buffer);
      return computedHash === expectedHash;
    } catch {
      return false;
    }
  }
}

export const storageService = new StorageService();
