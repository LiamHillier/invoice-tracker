import { GmailService } from './gmail';
import { OpenAIService, type BatchEmailItem } from '../openai/service';
import { prisma } from '../db/prisma';

// Define local types to avoid import issues
export type Attachment = {
  filename: string;
  mimeType: string;
  data: string;
};

// Define Gmail API message schema
export type GmailHeader = {
  name?: string | null;
  value?: string | null;
};

export type GmailPayloadBody = {
  data?: string | null;
  size?: number | null;
};

export type GmailPayloadPart = {
  mimeType?: string | null;
  body?: GmailPayloadBody | null;
  parts?: GmailPayloadPart[] | null;
};

export type GmailPayload = {
  headers?: GmailHeader[];
  parts?: GmailPayloadPart[] | null;
  body?: GmailPayloadBody | null;
};

export type GmailMessage = {
  id?: string | null;
  threadId?: string | null;
  payload?: GmailPayload | null;
  internalDate?: string | null;
  labelIds?: string[] | null;
};

export class EmailScanner {
  private gmailService: GmailService;
  private userId: string;
  private accountId: string;

  constructor(userId: string, accountId: string) {
    this.userId = userId;
    this.accountId = accountId;
    this.gmailService = new GmailService(userId);
  }

  public async scanEmails(
    query: string = '(invoice OR receipt OR bill OR payment OR "purchase order" OR "sales order")',
    maxResults: number = 100,
    pageToken?: string,
    forceRescan: boolean = false
  ) {
    try {
      // Get the last processed message to avoid rescanning
      const lastProcessed = await prisma.invoice.findFirst({
        where: { accountId: this.accountId },
        orderBy: { date: 'desc' },
        select: { messageId: true, date: true }
      });

      // Search for emails
      console.log(`Searching emails with query: "${query}", maxResults: ${maxResults}`);
      const { messages = [], nextPageToken, resultSizeEstimate } =
        await this.gmailService.searchEmails(query, maxResults, pageToken);
      
      console.log(`Found ${messages.length} emails (${resultSizeEstimate} total estimated)`);

      if (messages.length === 0) {
        console.log('No emails found matching the query');
        return {
          processed: 0,
          skipped: 0,
          errors: 0,
          hasMore: false,
          nextPageToken: undefined
        };
      }

      let processed = 0;
      let skipped = 0;
      let errors = 0;
      const messagesToProcess: GmailMessage[] = [];

      // Filter out already processed messages unless forceRescan is true
      console.log(`Processing ${messages.length} messages (forceRescan: ${forceRescan})...`);
      for (const message of messages) {
        const messageId = message.id;
        if (!messageId) {
          console.warn('Skipping message with no ID');
          continue;
        }

        // Skip the existence check if forceRescan is true
        if (!forceRescan) {
          const existing = await prisma.invoice.findUnique({
            where: { accountId_messageId: { accountId: this.accountId, messageId } }
          });

          if (existing) {
            console.log(`Skipping already processed message: ${messageId}`);
            skipped++;
            continue;
          }
        }
        
        // If we get here, either forceRescan is true or the message hasn't been processed yet
        try {
          const fullMessage = await this.gmailService.getMessage(messageId);
          messagesToProcess.push(fullMessage);
        } catch (error) {
          console.error(`Error fetching message ${messageId}:`, error);
          errors++;
        }
      }

      if (messagesToProcess.length === 0) {
        console.log('All messages have already been processed');
        return { 
          processed, 
          skipped, 
          errors, 
          hasMore: !!nextPageToken,
          nextPageToken
        };
      }

      // Process in batches
      const BATCH_SIZE = 5;
      for (let i = 0; i < messagesToProcess.length; i += BATCH_SIZE) {
        const batch = messagesToProcess
          .slice(i, i + BATCH_SIZE)
          .filter((msg): msg is GmailMessage & { id: string } => !!msg.id);

        try {
          const fetchPromises = batch.map(async (message) => {
            try {
              const headers = message.payload?.headers ?? [];
              const subject =
                headers.find((h) => h.name === 'Subject')?.value ?? 'No Subject';
              const body = await this.gmailService.getMessageBody(message);
              const gmailAttachments = await this.gmailService.getAttachments(message);

              const attachments = gmailAttachments
                .filter((att) => att.data != null)
                .map((att) => ({
                  filename: att.filename ?? 'unknown',
                  mimeType: att.mimeType ?? 'application/octet-stream',
                  data: att.data as string
                }));

              const fullMessage = message;
              return { id: message.id, subject, body, attachments, fullMessage };
            } catch (err) {
              console.error(`Error fetching message ${message.id}:`, err);
              errors++;
              return null;
            }
          });

          const batchResults = (
            await Promise.all(fetchPromises)
          ).filter(Boolean) as Array<BatchEmailItem & { fullMessage: any }>;

          if (batchResults.length === 0) continue;

          const analysisResults = await OpenAIService.analyzeBatchEmailContent(
            batchResults.map((item) => ({
              id: item.id,
              subject: item.subject,
              body: item.body,
              attachments: item.attachments
            }))
          );

          for (const item of batchResults) {
            try {
              const analysis = analysisResults[item.id];

              if (!analysis || analysis.error) {
                console.error(
                  `Error analyzing message ${item.id}:`,
                  analysis?.error ?? 'Unknown'
                );
                errors++;
                continue;
              }

              if (!analysis.isInvoice || analysis.confidence < 0.4) {
                console.log(
                  `Skipping non-invoice email: ${item.id}, confidence: ${analysis.confidence}`
                );
                skipped++;
                continue;
              }

              const headers = item.fullMessage.payload?.headers ?? [];
              const from = headers.find((h: GmailHeader) => h.name === 'From')?.value ?? 'Unknown';
              const to = headers.find((h: GmailHeader) => h.name === 'To')?.value ?? undefined;
              const dateHeader =
                headers.find((h: GmailHeader) => h.name === 'Date')?.value ?? new Date().toISOString();
              const invoiceDate = analysis.date
                ? new Date(analysis.date)
                : new Date(dateHeader);
              const amount = analysis.totalAmount ?? 0;
              const firstAttachment = item.attachments[0];
              const fileSize = firstAttachment?.data
                ? Buffer.byteLength(firstAttachment.data, 'base64')
                : null;

              await prisma.invoice.create({
                data: {
                  accountId: this.accountId,
                  userId: this.userId,
                  messageId: item.id,
                  subject: item.subject,
                  from,
                  to,
                  date: invoiceDate,
                  amount,
                  currency: analysis.currency ?? 'AUD',
                  fileName: firstAttachment?.filename,
                  fileType: firstAttachment?.mimeType,
                  fileSize,
                  status: 'processed',
                  categories: analysis.categories ?? [],
                  vendor: analysis.vendor ?? from.split('@')[0],
                  invoiceNumber: analysis.invoiceNumber ?? null,
                  dueDate: analysis.dueDate ? new Date(analysis.dueDate) : null,
                  confidence: analysis.confidence,
                  source: analysis.source ?? 'email',
                  processedAt: new Date()
                }
              });

              await this.gmailService.markAsProcessed(item.id);
              console.log(
                `Processed invoice ${analysis.invoiceNumber} for ${amount} ${analysis.currency}`
              );
              processed++;
            } catch (err) {
              console.error(`Error saving invoice for ${item.id}:`, err);
              errors++;
            }
          }
        } catch (err) {
          console.error('Error processing batch:', err);
          errors += batch.length;
        }
      }

      return {
        processed,
        skipped,
        errors,
        hasMore: !!nextPageToken,
        nextPageToken: nextPageToken ?? undefined
      };
    } catch (err) {
      console.error('Error in scanEmails:', err);
      throw err;
    }
  }

  public async processAllEmails(
    query: string = '(invoice OR receipt OR bill OR payment OR "purchase order" OR "sales order" OR "tax invoice" OR "statement" OR "order confirmation")',
    maxResults: number = 500,
    batchSize: number = 50,
    forceRescan: boolean = false
  ) {
    let totalProcessed = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let pageToken: string | null | undefined;
    let hasMore = true;
    let batchNumber = 0;
    let totalEmailsProcessed = 0;

    try {
      // Update sync status
      await prisma.account.update({
        where: { id: this.accountId },
        data: { syncStatus: 'syncing', syncError: null }
      });

      console.log(`Starting to process all emails with query: "${query}"`);
      console.log(`Max results: ${maxResults}, Batch size: ${batchSize}`);
      const startTime = Date.now();

      while (hasMore) {
        batchNumber++;
        console.log(`\n--- Batch ${batchNumber} (${totalEmailsProcessed + 1}-${Math.min(totalEmailsProcessed + batchSize, maxResults)} of max ${maxResults}) ---`);
        console.log(`Fetching next batch of up to ${batchSize} messages...`);
        if (pageToken && typeof pageToken === 'string') {
          console.log(`Using page token: ${pageToken.substring(0, 8)}...`);
        }
        
        const batchStartTime = Date.now();
        const result = await this.scanEmails(query, batchSize, pageToken ?? undefined, forceRescan);
        const batchTime = (Date.now() - batchStartTime) / 1000;
        
        totalProcessed += result.processed;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
        totalEmailsProcessed = totalProcessed + totalSkipped + totalErrors;
        hasMore = result.hasMore;
        pageToken = result.nextPageToken;

        const batchRate = (result.processed + result.skipped) / (batchTime || 1);
        console.log(`Batch completed in ${batchTime.toFixed(1)}s (${batchRate.toFixed(1)} emails/s)`);
        console.log(`Batch stats:`);
        console.log(`  Processed: ${result.processed} emails`);
        console.log(`  Skipped: ${result.skipped} emails`);
        console.log(`  Errors: ${result.errors} emails`);
        console.log(`\nCumulative totals after ${batchNumber} batches:`);
        console.log(`  Total processed: ${totalProcessed} emails`);
        console.log(`  Total skipped: ${totalSkipped} emails`);
        console.log(`  Total errors: ${totalErrors} emails`);
        console.log(`  Total emails processed: ${totalEmailsProcessed} of max ${maxResults}`);
        
        if (result.nextPageToken) {
          console.log(`Next page token available for next batch`);
        }
        
        // Add a small delay between batches to avoid rate limiting
        if (hasMore) {
          const delayMs = 1000; // 1 second delay between batches
          console.log(`Waiting ${delayMs}ms before next batch...`);
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }

      // Update sync status to completed
      await prisma.account.update({
        where: { id: this.accountId },
        data: { 
          lastSynced: new Date(),
          syncStatus: 'idle',
          syncError: null 
        }
      });

      console.log(`Completed processing all emails. Total: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalErrors} errors`);
      return {
        totalProcessed,
        totalSkipped,
        totalErrors,
        hasMore: false
      };
    } catch (error: unknown) {
      console.error('Fatal error in processAllEmails:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Update sync status with error
      await prisma.account.update({
        where: { id: this.accountId },
        data: { 
          syncStatus: 'error',
          syncError: errorMessage
        }
      });

      throw error;
    }
  }
}
