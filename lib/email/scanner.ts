import { GmailService } from "./gmail";
import { OpenAIService, type BatchEmailItem } from "../openai/service";
import { prisma } from "../db/prisma";
import { GmailMessage, GmailHeader } from "./types";
import { isValidGmailMessage } from "./types";


export class EmailScanner {
  private gmailService: GmailService;
  private userId: string;
  private accountId: string;
  private errors: Array<{ messageId: string; error: string; timestamp: Date }> = [];

  private findHeader(headers: GmailHeader[] | undefined, name: string): string {
    if (!headers) return '';
    const header = headers.find((h) => h.name === name);
    return header ? header.value : '';
  }

  constructor(userId: string, accountId: string) {
    this.userId = userId;
    this.accountId = accountId;
    this.gmailService = new GmailService(userId);
  }

  public async scanEmails(
    query: string = '(invoice OR receipt OR bill OR payment OR "purchase order" OR "sales order")',
    maxResults: number = 500,
    pageToken?: string,
    forceRescan: boolean = false
  ): Promise<{
    processed: number;
    skipped: number;
    errors: number;
    hasMore: boolean;
    nextPageToken?: string;
    errorDetails?: Array<{ messageId: string; error: string; timestamp: Date }>;
  }> {
    try {
      // Search for emails
      console.log(
        `Searching emails with query: "${query}", maxResults: ${maxResults}`
      );
      const {
        messages = [],
        nextPageToken,
        resultSizeEstimate,
      } = await this.gmailService.searchEmails(maxResults, pageToken);

      console.log(
        `Found ${messages.length} emails (${resultSizeEstimate} total estimated)`
      );

      if (messages.length === 0) {
        console.log("No emails found matching the query");
        return {
          processed: 0,
          skipped: 0,
          errors: 0,
          hasMore: false,
          nextPageToken: undefined,
        };
      }

      let processed = 0;
      let skipped = 0;
      let errors = 0;
      const messagesToProcess: GmailMessage[] = [];

      // Filter out already processed messages unless forceRescan is true
      console.log(
        `Processing ${messages.length} messages (forceRescan: ${forceRescan})...`
      );
      for (const message of messages) {
        const messageId = message.id;
        if (!messageId) {
          console.warn("Skipping message with no ID");
          continue;
        }

        // Skip the existence check if forceRescan is true
        if (!forceRescan) {
          const existing = await prisma.invoice.findUnique({
            where: {
              accountId_messageId: { accountId: this.accountId, messageId },
            },
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
        } catch (err) {
          const errorMessage = `Error processing batch: ${
            err instanceof Error ? err.message : String(err)
          }`;
          console.error(errorMessage);
          errors += 1;

          // Track batch errors
          this.errors.push({
            messageId: messageId || "unknown",
            error: errorMessage,
            timestamp: new Date(),
          });
        }
      }

      if (messagesToProcess.length === 0) {
        console.log("All messages have already been processed");
        // Save any remaining errors to the database
        if (this.errors.length > 0) {
          try {
            await prisma.$transaction(
              this.errors.map(({ messageId, error }) =>
                prisma.invoice.upsert({
                  where: { messageId },
                  update: {
                    status: "error",
                    error: error,
                    processedAt: new Date(),
                  },
                  create: {
                    accountId: this.accountId,
                    messageId,
                    subject: "Processing Error",
                    from: "system@invoicetracker",
                    date: new Date(),
                    amount: 0,
                    status: "error",
                    error: error,
                    userId: this.userId,
                  },
                })
              )
            );
          } catch (dbError) {
            console.error("Failed to save batch errors to database:", dbError);
          }
        }

        return {
          processed,
          skipped,
          errors,
          hasMore: !!nextPageToken,
          nextPageToken: nextPageToken || undefined,
          errorDetails: this.errors.length > 0 ? this.errors : undefined,
        };
      }

      // Process in batches
      const BATCH_SIZE = 5;
      for (let i = 0; i < messagesToProcess.length; i += BATCH_SIZE) {
        const batch = messagesToProcess
          .slice(i, i + BATCH_SIZE)
          .filter(isValidGmailMessage);

        try {
          const fetchPromises = batch.map(async (message) => {
            try {
              const headers = message.payload?.headers ?? [];
              const subject =
                headers.find((h) => h.name === "Subject")?.value ??
                "No Subject";
              const body = await this.gmailService.getMessageBody(message);
              const gmailAttachments = await this.gmailService.getAttachments(
                message
              );

              const attachments = gmailAttachments
                .filter((att) => att.data != null)
                .map((att) => ({
                  filename: att.filename ?? "unknown",
                  mimeType: att.mimeType ?? "application/octet-stream",
                  data: att.data as string,
                }));

              const fullMessage = message;
              return {
                id: message.id,
                subject,
                body,
                attachments,
                fullMessage,
              };
            } catch (err) {
              const errorMessage = `Error processing message ${message.id}: ${
                err instanceof Error ? err.message : String(err)
              }`;
              console.error(errorMessage);
              errors++;

              // Track error for batch reporting
              this.errors.push({
                messageId: message.id || "unknown",
                error: errorMessage,
                timestamp: new Date(),
              });

              // Save error to database
              try {
                // Get the full email content including headers for error case
                const subject = this.findHeader(message.payload?.headers, "Subject") || "No Subject";
                const from = this.findHeader(message.payload?.headers, "From") || "Unknown Sender";
                const to = this.findHeader(message.payload?.headers, "To") || "N/A";
                const dateHeader = this.findHeader(message.payload?.headers, "Date") || new Date().toISOString();

                // Get the message body if available
                let body = "No email body content";
                try {
                  body = await this.gmailService.getMessageBody(message);
                } catch (e) {
                  console.error("Failed to get message body:", e);
                }

                const emailContent = [
                  `Subject: ${subject}`,
                  `From: ${from}`,
                  `To: ${to}`,
                  `Date: ${dateHeader}`,
                  "\n",
                  body,
                ].join("\n");

                await prisma.invoice.upsert({
                  where: { messageId: message.id },
                  update: {
                    status: "error",
                    error: errorMessage,
                    processedAt: new Date(),
                    rawContent: emailContent, // Update raw content on error too
                  },
                  create: {
                    accountId: this.accountId,
                    messageId: message.id || `error-${Date.now()}`,
                    threadId: message.threadId || undefined,
                    subject,
                    from,
                    date: message.internalDate
                      ? new Date(parseInt(message.internalDate))
                      : new Date(),
                    amount: 0,
                    status: "error",
                    error: errorMessage,
                    rawContent: emailContent, // Save the full email content
                    processedAt: new Date(),
                    userId: this.userId,
                  },
                });
              } catch (dbError) {
                console.error("Failed to save error to database:", dbError);
              }
              return null;
            }
          });

          const batchResults = (await Promise.all(fetchPromises)).filter(
            Boolean
          ) as Array<BatchEmailItem & { fullMessage: GmailMessage }>;

          if (batchResults.length === 0) continue;

          const analysisResults = await OpenAIService.analyzeBatchEmailContent(
            batchResults.map((item) => ({
              id: item.id,
              subject: item.subject,
              body: item.body,
              attachments: item.attachments,
            }))
          );

          for (const item of batchResults) {
            try {
              const analysis = analysisResults[item.id];

              if (!analysis || analysis.error) {
                console.error(
                  `Error analyzing message ${item.id}:`,
                  analysis?.error ?? "Unknown"
                );
                errors++;
                continue;
              }

              if (!analysis.isInvoice) {
                console.log(
                  `Skipping email ${item.id}: Not identified as an invoice (${analysis.confidence})`
                );
                skipped++;
                continue;
              }

              if (analysis.confidence < 0.5) {
                console.log(
                  `Skipping email ${item.id}: Not confident this is an invoice (${analysis.confidence}% chance)`
                );
                skipped++;
                continue;
              }

              const headers = item.fullMessage.payload?.headers ?? [];
              const from =
                headers.find((h: GmailHeader) => h.name === "From")?.value ??
                "Unknown";
              const to =
                headers.find((h: GmailHeader) => h.name === "To")?.value ??
                undefined;
              const dateHeader =
                headers.find((h: GmailHeader) => h.name === "Date")?.value ??
                new Date().toISOString();
              const invoiceDate = analysis.date
                ? new Date(analysis.date)
                : new Date(dateHeader);
              // Ensure amount is a valid number, default to 0 if not
              const amount =
                analysis.totalAmount !== null &&
                analysis.totalAmount !== undefined
                  ? parseFloat(analysis.totalAmount.toString())
                  : 0;
              const firstAttachment = item.attachments[0];
              const fileSize = firstAttachment?.data
                ? Buffer.byteLength(firstAttachment.data, "base64")
                : null;

              try {
                // Try explicitly separating the create object to avoid compilation issues
                // Ensure amount is always a valid number, default to 0 if missing or invalid
                const safeAmount =
                  amount !== null && !isNaN(amount) ? amount : 0;

                if (amount === null || isNaN(amount)) {
                  console.warn(
                    `No valid amount found for invoice ${
                      analysis.invoiceNumber || item.id
                    }, defaulting to 0`
                  );
                }

                // Get the full email content including headers
                const emailContent = [
                  `Subject: ${item.subject}`,
                  `From: ${from}`,
                  `To: ${to || "N/A"}`,
                  `Date: ${dateHeader}`,
                  "\n",
                  item.body || "No email body content",
                ].join("\n");

                const invoiceCreateData = {
                  messageId: item.id,
                  subject: item.subject,
                  from,
                  to,
                  date: invoiceDate,
                  amount: safeAmount,
                  currency: analysis.currency ?? "AUD",
                  fileName: firstAttachment?.filename,
                  fileType: firstAttachment?.mimeType,
                  fileSize,
                  status: "processed",
                  categories: analysis.categories ?? [],
                  vendor: analysis.vendor ?? from.split("@")[0],
                  invoiceNumber: analysis.invoiceNumber ?? null,
                  dueDate: analysis.dueDate ? new Date(analysis.dueDate) : null,
                  confidence: analysis.confidence,
                  source: analysis.source ?? "email",
                  rawContent: emailContent, // Save the full email content
                  processedAt: new Date(),
                  account: {
                    connect: { id: this.accountId },
                  },
                  user: {
                    connect: { id: this.userId },
                  },
                };

                // Create the invoice using the prepared data
                await prisma.invoice.create({
                  data: invoiceCreateData,
                });
              } catch (invoiceError) {
                console.error(`Error creating invoice: ${invoiceError}`);
                throw invoiceError;
              }

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
          const errorMessage = `Error in scanEmails: ${
            err instanceof Error ? err.message : String(err)
          }`;
          console.error(errorMessage);

          // Save the error to the database
          try {
            await prisma.invoice.create({
              data: {
                accountId: this.accountId,
                messageId: `scan-error-${Date.now()}`,
                subject: "Scan Error",
                from: "system@invoicetracker",
                date: new Date(),
                amount: 0,
                status: "error",
                error: errorMessage,
                userId: this.userId,
              },
            });
          } catch (dbError) {
            console.error("Failed to save scan error to database:", dbError);
          }

          return {
            processed,
            skipped,
            errors: errors + 1,
            hasMore: false,
            errorDetails: this.errors,
          };
        }
      }

      // Save any remaining errors to the database
      if (this.errors.length > 0) {
        try {
          await prisma.$transaction(
            this.errors.map(({ messageId, error }) =>
              prisma.invoice.upsert({
                where: { messageId },
                update: {
                  status: "error",
                  error: error,
                  processedAt: new Date(),
                },
                create: {
                  accountId: this.accountId,
                  messageId,
                  subject: "Processing Error",
                  from: "system@invoicetracker",
                  date: new Date(),
                  amount: 0,
                  status: "error",
                  error: error,
                  userId: this.userId,
                },
              })
            )
          );
        } catch (dbError) {
          console.error("Failed to save batch errors to database:", dbError);
        }
      }

      return {
        processed,
        skipped,
        errors,
        hasMore: !!nextPageToken,
        nextPageToken: nextPageToken || undefined,
        errorDetails: this.errors.length > 0 ? this.errors : undefined,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Update sync status with error
      await prisma.account.update({
        where: { id: this.accountId },
        data: {
          syncStatus: "error",
          syncError: errorMessage,
        },
      });

      throw error;
    }
  }

  public async processAllEmails(
    query: string = '(invoice OR receipt OR bill OR payment OR "purchase order" OR "sales order")',
    maxResults: number = 500,
    batchSize: number = 100,
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
        data: { syncStatus: "syncing", syncError: null },
      });

      console.log(`Starting to process all emails with query: "${query}"`);
      console.log(`Max results: ${maxResults}, Batch size: ${batchSize}`);
      // Performance tracking can be re-enabled if needed
    // const startTime = Date.now();

      while (hasMore) {
        batchNumber++;
        console.log(
          `\n--- Batch ${batchNumber} (${totalEmailsProcessed + 1}-${Math.min(
            totalEmailsProcessed + batchSize,
            maxResults
          )} of max ${maxResults}) ---`
        );
        console.log(`Fetching next batch of up to ${batchSize} messages...`);
        if (pageToken && typeof pageToken === "string") {
          console.log(`Using page token: ${pageToken.substring(0, 8)}...`);
        }

        const batchStartTime = Date.now();
        const result = await this.scanEmails(
          query,
          batchSize,
          pageToken ?? undefined,
          forceRescan
        );
        const batchTime = (Date.now() - batchStartTime) / 1000;

        totalProcessed += result.processed;
        totalSkipped += result.skipped;
        totalErrors += result.errors;
        totalEmailsProcessed = totalProcessed + totalSkipped + totalErrors;
        hasMore = result.hasMore;
        pageToken = result.nextPageToken;

        const batchRate =
          (result.processed + result.skipped) / (batchTime || 1);
        console.log(
          `Batch completed in ${batchTime.toFixed(1)}s (${batchRate.toFixed(
            1
          )} emails/s)`
        );
        console.log(`Batch stats:`);
        console.log(`  Processed: ${result.processed} emails`);
        console.log(`  Skipped: ${result.skipped} emails`);
        console.log(`  Errors: ${result.errors} emails`);
        console.log(`\nCumulative totals after ${batchNumber} batches:`);
        console.log(`  Total processed: ${totalProcessed} emails`);
        console.log(`  Total skipped: ${totalSkipped} emails`);
        console.log(`  Total errors: ${totalErrors} emails`);
        console.log(
          `  Total emails processed: ${totalEmailsProcessed} of max ${maxResults}`
        );

        if (result.nextPageToken) {
          console.log(`Next page token available for next batch`);
        }

        // Add a small delay between batches to avoid rate limiting
        if (hasMore) {
          const delayMs = 1000; // 1 second delay between batches
          console.log(`Waiting ${delayMs}ms before next batch...`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }

      // Update sync status to completed
      await prisma.account.update({
        where: { id: this.accountId },
        data: {
          lastSynced: new Date(),
          syncStatus: "idle",
          syncError: null,
        },
      });

      console.log(
        `Completed processing all emails. Total: ${totalProcessed} processed, ${totalSkipped} skipped, ${totalErrors} errors`
      );
      return {
        totalProcessed,
        totalSkipped,
        totalErrors,
        hasMore: false,
      };
    } catch (error: unknown) {
      console.error("Fatal error in processAllEmails:", error);
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Update sync status with error
      await prisma.account.update({
        where: { id: this.accountId },
        data: {
          syncStatus: "error",
          syncError: errorMessage,
        },
      });

      throw error;
    }
  }
}
