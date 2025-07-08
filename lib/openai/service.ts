import OpenAI from "openai";
import { createHash } from "crypto";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Cache configuration
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

// Simple in-memory cache with TTL
class Cache<T> {
  private cache = new Map<string, CacheEntry<T>>();

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    // Check if entry is expired
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  set(key: string, data: T): void {
    this.cache.set(key, {
      data,
      timestamp: Date.now(),
    });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }
}

// Initialize caches with proper types
const responseCache = new Cache<Partial<InvoiceData>>();
const emailCache = new Cache<InvoiceData>();

export type InvoiceData = {
  vendor: string | null;
  invoiceNumber: string | null;
  date: string | null;
  dueDate: string | null;
  totalAmount: number | null;
  currency: string | null;
  isInvoice: boolean;
  confidence: number;
  categories: string[];
  source: "email" | "attachment" | "combined";
  processed?: boolean;
  error?: string;
};

type Attachment = {
  filename: string;
  mimeType: string;
  data: string; // Base64 encoded content
};

// Type for the raw response from the AI service
interface AIResponse {
  vendor?: string | null;
  invoiceNumber?: string | null;
  receiptNumber?: string | null;
  date?: string | null;
  invoiceDate?: string | null;
  dueDate?: string | null;
  totalAmount?: number | string | null;
  currency?: string | null;
  isInvoice?: boolean;
  confidence?: number;
  categories?: string[] | null;
  category?: string | null; // Some models might return a single category
}

const INVOICE_SYSTEM_PROMPT = `You are an AI assistant specialized in extracting structured invoice and receipt information.

For each input, analyze the content and extract the following information if available:
1. Determine if this is an invoice, receipt, or purchase-related document (isInvoice: true/false)
2. Extract vendor/organization name
3. Extract invoice/receipt number if present
4. Find the invoice date (prioritize the most recent date if multiple are found)
5. Extract due date if mentioned
6. Find the total amount and its currency (look for phrases like 'total', 'amount due', 'balance', 'subtotal', 'grand total', 'TOTAL CHARGE')
   - Look for amounts with currency symbols ($, £, €, etc.) or currency codes (USD, EUR, GBP, etc.)
   - Check for amounts in tables or line items
   - The total amount is usually the largest number in the document
   - If multiple amounts are found, the total is typically the last one
   - Pay special attention to amounts following 'TOTAL CHARGE:' or similar indicators
   - Amounts may have a space between the currency symbol and number (e.g., '$ 25.00')
7. Categorize the expense (e.g., utilities, office supplies, software, travel, etc.)
8. Provide a confidence score (confidence) from 0.0 to 1.0 indicating how confident you are that this is an invoice or receipt and that the extracted information is accurate

IMPORTANT: Always return the amount as a number (e.g., 25.00) and the currency as a string (e.g., 'USD').

Example JSON response:
{
  "isInvoice": true,
  "vendor": "Heroku",
  "invoiceNumber": "106355247",
  "date": "2025-07-07",
  "dueDate": null,
  "totalAmount": 25.00,
  "currency": "USD",
  "categories": ["cloud-services"],
  "confidence": 0.95
}

Return a JSON object with the extracted information. If a field cannot be determined, set it to null.`;

export type BatchEmailItem = {
  id: string;
  subject: string;
  body: string;
  attachments: Attachment[];
};

export type BatchAnalysisResult = Record<string, InvoiceData>;

export class OpenAIService {
  private static BATCH_SIZE = 10; // Increased batch size for better throughput
  private static MAX_TOKENS_PER_BATCH = 10000; // ~100K tokens for GPT-4-turbo
  private static MAX_TOKENS_PER_EMAIL = 10000; // Max tokens per email to process
  private static RATE_LIMIT_REQUESTS = 100; // Max requests per minute
  private static RATE_LIMIT_INTERVAL = 60 * 1000; // 1 minute in ms

  // Rate limiting
  private static requestQueue: Array<() => Promise<void>> = [];
  private static processingQueue = false;
  private static requestTimestamps: number[] = [];

  private static generateCacheKey(content: string, model: string): string {
    // Create a hash of the content and model to use as cache key
    const hash = createHash("sha256")
      .update(content + model)
      .digest("hex");
    return `ai_cache_${hash}`;
  }

  private static preprocessContent(content: string, maxTokens = 8000): string {
    if (!content) return "";

    // First, try to extract text from HTML if it's an HTML email
    let cleanedContent = content;
    if (content.includes("<html") || content.includes("<!DOCTYPE html")) {
      // Remove HTML tags but keep text content
      cleanedContent = content
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "") // Remove style tags
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "") // Remove script tags
        .replace(/<[^>]+>/g, " ") // Remove all other HTML tags
        .replace(/\s+/g, " ") // Collapse multiple spaces
        .replace(/&[a-z]+;/g, " ") // Replace HTML entities with space
        .trim();
    }

    // Simple token estimation (1 token ~= 4 chars for English)
    const tokenEstimate = cleanedContent.length / 4;
    if (tokenEstimate <= maxTokens) return cleanedContent;

    // If still too long, try to find important sections first
    const importantSections = [];
    const receiptPatterns = [
      /(?:total|amount|balance)[:\s]*\$?\s*\d+\.\d{2}/i,
      /(?:invoice|receipt)\s*#?\s*[\w-]+/i,
      /(?:date|due\s*date)[:\s]+\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}/i,
    ];

    // Try to find and keep important sections
    for (const pattern of receiptPatterns) {
      const match = cleanedContent.match(pattern);
      if (match) {
        const start = Math.max(0, match.index! - 100); // 100 chars before match
        const end = Math.min(
          cleanedContent.length,
          match.index! + match[0].length + 100
        ); // 100 chars after match
        importantSections.push(cleanedContent.substring(start, end));
      }
    }

    // If we found important sections, use those
    if (importantSections.length > 0) {
      const importantContent =
        importantSections.join("\n\n") +
        "\n\n" +
        "... [additional content truncated]";
      const importantTokenEstimate = importantContent.length / 4;
      if (importantTokenEstimate <= maxTokens) return importantContent;
    }

    // If no important sections or still too long, truncate but keep the beginning and end
    const maxChars = (maxTokens * 3) / 4; // Reserve 1/4 for the end
    const start = cleanedContent.substring(0, maxChars);
    const end = cleanedContent.substring(
      cleanedContent.length - ((maxTokens * 1) / 4) * 4
    );
    return start + "\n\n... [content truncated] ...\n\n" + end;
  }

  private static async rateLimitedRequest<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const execute = async () => {
        try {
          // Clean up old timestamps
          const now = Date.now();
          this.requestTimestamps = this.requestTimestamps.filter(
            (ts) => now - ts < this.RATE_LIMIT_INTERVAL
          );

          // If we're at the rate limit, wait until we can make another request
          if (this.requestTimestamps.length >= this.RATE_LIMIT_REQUESTS) {
            const oldestRequest = this.requestTimestamps[0];
            const waitTime = Math.max(
              0,
              oldestRequest + this.RATE_LIMIT_INTERVAL - now
            );
            console.log(
              `Rate limit reached, waiting ${waitTime}ms before next request`
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime + 100)); // Add small buffer
          }

          // Make the request
          this.requestTimestamps.push(Date.now());
          const result = await fn();
          resolve(result);
        } catch (error) {
          reject(error);
        } finally {
          // Process next in queue
          this.processQueue();
        }
      };

      // Add to queue and process if not already processing
      this.requestQueue.push(execute);
      if (!this.processingQueue) {
        this.processQueue();
      }
    });
  }

  private static async processQueue() {
    if (this.requestQueue.length === 0) {
      this.processingQueue = false;
      return;
    }

    this.processingQueue = true;
    const next = this.requestQueue.shift();
    if (next) {
      await next();
    }
  }

  private static extractAmountWithRegex(content: string): {
    amount: number | null;
    currency: string | null;
  } {
    if (!content) return { amount: null, currency: null };

    // Look for common amount patterns
    const amountPatterns = [
      // $16.50
      /\$(\d+\.\d{2})\b/,
      // $ 16.50
      /\$\s*(\d+\.\d{2})\b/,
      // USD 16.50
      /(?:USD|EUR|GBP|JPY|CAD|AUD)\s*(\d+\.\d{2})\b/i,
      // 16.50 USD
      /(\d+\.\d{2})\s*(?:USD|EUR|GBP|JPY|CAD|AUD)\b/i,
      // Just the number (as last resort)
      /(?:total|amount|balance)[:\s]*\$?\s*(\d+\.\d{2})\b/i,
    ];

    for (const pattern of amountPatterns) {
      const match = content.match(pattern);
      if (match) {
        const amount = parseFloat(match[1]);
        if (!isNaN(amount)) {
          // Try to determine currency
          let currency = "USD"; // default
          const currencyMatch = content.match(/(USD|EUR|GBP|JPY|CAD|AUD)/i);
          if (currencyMatch) {
            currency = currencyMatch[1].toUpperCase();
          } else if (content.includes("$")) {
            currency = "USD";
          } else if (content.includes("£")) {
            currency = "GBP";
          } else if (content.includes("€")) {
            currency = "EUR";
          } else if (content.includes("¥")) {
            currency = "JPY";
          }

          console.log(
            `Extracted amount ${amount} ${currency} using regex fallback`
          );
          return { amount, currency };
        }
      }
    }

    return { amount: null, currency: null };
  }

  private static async callOpenAI(
    content: string,
    model: string
  ): Promise<Partial<InvoiceData>> {
    const response = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INVOICE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Analyze the following content and extract any invoice or receipt information.
          Focus on identifying key details like vendor, amounts, dates, and categories.
          
          Content:
          ${content}
          
          IMPORTANT: Pay special attention to the total amount and currency. 
          Look for amounts in the format '$25.00' or '$ 25.00' or 'USD 25.00'.
          The amount is likely near phrases like 'TOTAL CHARGE:', 'Amount Due:', or 'Total:'`,
        },
      ],
      temperature: 0.1,
      max_tokens: 1000,
    });

    const result = response.choices[0]?.message?.content;
    if (!result) throw new Error("No response from AI service");

    return JSON.parse(result);
  }

  private static async analyzeWithModel(
    content: string,
    model: "gpt-3.5-turbo" | "gpt-4-turbo" = "gpt-3.5-turbo",
    isRetry = false
  ): Promise<InvoiceData> {
    const processedContent = this.preprocessContent(
      content,
      this.MAX_TOKENS_PER_EMAIL
    );
    const cacheKey = this.generateCacheKey(processedContent, model);

    // Check cache first
    const cached = emailCache.get(cacheKey);
    if (cached) {
      console.log("Returning cached result");
      return cached;
    }

    // Skip API call if content is too short to be an invoice
    if (processedContent.length < 50) {
      console.log("Content too short, skipping AI analysis");
      return this.getDefaultResponse();
    }

    try {
      // Try with AI first
      const aiResult = await this.callOpenAI(processedContent, model);

      // Parse the AI response with proper typing
      const aiResponse = aiResult as AIResponse;
      const responseData: InvoiceData = {
        vendor: aiResponse.vendor || null,
        invoiceNumber: aiResponse.invoiceNumber || aiResponse.receiptNumber || null,
        date: aiResponse.invoiceDate || aiResponse.date || null,
        dueDate: aiResponse.dueDate || null,
        totalAmount: aiResponse.totalAmount
          ? parseFloat(aiResponse.totalAmount.toString())
          : null,
        currency: aiResponse.currency || null,
        isInvoice: aiResponse.isInvoice || false,
        confidence: aiResponse.confidence || 0,
        categories: Array.isArray(aiResponse.categories)
          ? aiResponse.categories
          : aiResponse.category
          ? [aiResponse.category]
          : [],
        source: "email",
      };

      // If AI didn't find an amount, try regex as fallback
      if (
        (!responseData.totalAmount || responseData.totalAmount === 0) &&
        processedContent
      ) {
        console.log("AI did not find amount, trying regex fallback");
        const { amount, currency } =
          this.extractAmountWithRegex(processedContent);
        if (amount) {
          responseData.totalAmount = amount;
          responseData.currency = currency || responseData.currency;
          console.log(
            `Regex fallback found amount: ${amount} ${responseData.currency}`
          );
        }
      }

      // Cache the successful response with TTL
      emailCache.set(cacheKey, responseData);
      return responseData;
    } catch (error) {
      // Type guard to check if error is an object with a code property
      const isErrorWithCode = (error: unknown): error is { code: string } => {
        return typeof error === "object" && error !== null && "code" in error;
      };

      if (!isRetry && model === "gpt-3.5-turbo") {
        // Only fall back to GPT-3.5 for certain error types
        if (
          isErrorWithCode(error) &&
          (error.code === "rate_limit_exceeded" ||
            error.code === "server_error")
        ) {
          return this.analyzeWithModel(content, "gpt-3.5-turbo", true);
        }
      }
      console.error("Error in analyzeWithModel:", error);
      return this.getDefaultResponse();
    }
  }

  private static getDefaultResponse(): InvoiceData {
    return {
      vendor: null,
      invoiceNumber: null,
      date: null,
      dueDate: null,
      totalAmount: null,
      currency: null,
      isInvoice: false,
      confidence: 0,
      categories: [],
      source: "email" as const,
    };
  }

  static async analyzeBatchEmailContent(
    emails: BatchEmailItem[]
  ): Promise<BatchAnalysisResult> {
    if (!emails.length) return {};

    // Process emails in chunks to respect batch size
    const results: BatchAnalysisResult = {};

    for (let i = 0; i < emails.length; i += this.BATCH_SIZE) {
      const batch = emails.slice(i, i + this.BATCH_SIZE);
      try {
        const batchResults = await this.processBatch(batch);
        Object.assign(results, batchResults);
      } catch (error) {
        console.error(
          `Error processing batch ${i / this.BATCH_SIZE + 1}:`,
          error
        );
        // Mark failed emails in this batch
        batch.forEach((email) => {
          results[email.id] = {
            ...this.getDefaultResponse(),
            processed: false,
            error: "Failed to process batch",
            isInvoice: false,
            confidence: 0,
          };
        });
      }
    }

    return results;
  }

  private static async processBatch(
    emails: BatchEmailItem[]
  ): Promise<BatchAnalysisResult> {
    // Check individual email caches first
    const cachedResults: BatchAnalysisResult = {};
    const emailsToProcess: BatchEmailItem[] = [];

    for (const email of emails) {
      const emailKey = this.generateCacheKey(
        `${email.body || ""}${email.subject || ""}`,
        "gpt-3.5-turbo"
      );
      const cached = emailCache.get(emailKey);
      if (cached) {
        cachedResults[email.id] = cached;
      } else {
        emailsToProcess.push(email);
      }
    }

    // If all emails were cached, return early
    if (emailsToProcess.length === 0) {
      return cachedResults;
    }

    // Prepare batch prompt with token optimization
    let currentBatchTokens = 0;
    const batchPrompt = emailsToProcess
      .map((email, index) => {
        const emailContent =
          `Subject: ${email.subject || "No Subject"}\n` +
          `Body: ${this.preprocessContent(email.body, 1500)}`;

        // Simple token estimation
        const emailTokens = Math.ceil(emailContent.length / 4);
        currentBatchTokens += emailTokens;

        return `--- Email ${index + 1} (ID: ${email.id}) ---\n${emailContent}`;
      })
      .join("\n\n");

    // If batch is too large, split it
    if (currentBatchTokens > this.MAX_TOKENS_PER_BATCH) {
      const half = Math.ceil(emailsToProcess.length / 2);
      const firstHalf = await this.processBatch(emailsToProcess.slice(0, half));
      const secondHalf = await this.processBatch(emailsToProcess.slice(half));
      return { ...firstHalf, ...secondHalf, ...cachedResults };
    }

    const cacheKey = this.generateCacheKey(batchPrompt, "gpt-3.5-turbo");

    // Check batch cache
    const cachedBatch = responseCache.get(cacheKey);
    if (cachedBatch) {
      // Convert the cached batch to BatchAnalysisResult format
      const batchResult: BatchAnalysisResult = {};
      for (const email of emails) {
        batchResult[email.id] = {
          ...this.getDefaultResponse(),
          ...cachedBatch,
          processed: true
        };
      }
      return { ...batchResult, ...cachedResults };
    }

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `${INVOICE_SYSTEM_PROMPT}\n\n` +
              `You will receive multiple emails in this format:\n` +
              `--- Email N (ID: [ID]) ---\n` +
              `[Email content]\n\n` +
              `Return a JSON object where keys are the email IDs and values are the extracted data. ` +
              `If an email is not an invoice, set isInvoice: false and confidence: 0.`,
          },
          {
            role: "user",
            content: batchPrompt,
          },
        ],
        temperature: 0.1,
        max_tokens: 3000, // Increased for batch processing
      });

      const result = JSON.parse(response.choices[0].message.content || "{}");

      // Validate and normalize the response
      const processedResults: BatchAnalysisResult = {};
      emailsToProcess.forEach((email) => {
        const emailResult = result[email.id] || this.getDefaultResponse();
        processedResults[email.id] = {
          ...emailResult,
          processed: true,
          // Ensure required fields exist
          isInvoice: emailResult.isInvoice === true,
          categories: Array.isArray(emailResult.categories)
            ? emailResult.categories
            : [],
          source: emailResult.source || "email",
        };
      });

      // Cache individual email results and the batch
      for (const [id, result] of Object.entries(processedResults)) {
        const email = emailsToProcess.find((e) => e.id === id);
        if (email) {
          const emailKey = this.generateCacheKey(
            `${email.body}${email.subject}`,
            "gpt-3.5-turbo"
          );
          emailCache.set(emailKey, result as InvoiceData);
        }
      }

      // Cache the batch result
      responseCache.set(cacheKey, processedResults);

      // Combine with any cached results
      return { ...processedResults, ...cachedResults };
    } catch (error) {
      console.error("Error processing batch:", error);
      // Mark failed emails in this batch
      const errorResults: BatchAnalysisResult = {};
      emailsToProcess.forEach((email) => {
        errorResults[email.id] = {
          ...this.getDefaultResponse(),
          processed: false,
          error: "Failed to process batch",
          isInvoice: false,
        };
      });
      return { ...errorResults, ...cachedResults };
    }
  }

  private static async analyzeEmailContent(
    content: string,
    attachments: Attachment[] = []
  ): Promise<InvoiceData> {
    console.log("Starting email content analysis");
    try {
      // Process the email directly without batching
      const result = await this.analyzeWithModel(content);

      // Process attachments if any
      if (attachments.length > 0) {
        for (const attachment of attachments) {
          try {
            const attachmentContent = Buffer.from(
              attachment.data,
              "base64"
            ).toString("utf-8");
            const attachmentResult = await this.analyzeWithModel(
              attachmentContent
            );

            // Merge results, giving priority to the email content
            if (
              attachmentResult.isInvoice &&
              attachmentResult.confidence > (result.confidence || 0)
            ) {
              Object.assign(result, attachmentResult);
              result.source = "attachment";
            }
          } catch (error) {
            console.error("Error processing attachment:", error);
          }
        }
      }

      console.log("Email analysis completed", {
        isInvoice: result.isInvoice,
        confidence: result.confidence,
        amount: result.totalAmount,
        currency: result.currency,
        source: result.source,
      });

      return result;
    } catch (error) {
      console.error("Error in analyzeEmailContent:", error);
      return this.getDefaultResponse();
    }
  }

  private static async analyzeEmailContentOld(
    emailContent: string,
    attachments: Attachment[] = []
  ): Promise<InvoiceData> {
    try {
      // Check if email is likely to contain invoice data
      const invoiceKeywords = [
        "invoice",
        "receipt",
        "bill",
        "payment",
        "amount",
        "$",
        "due",
        "total",
      ];
      const hasInvoiceIndicators = invoiceKeywords.some((keyword) =>
        emailContent.toLowerCase().includes(keyword)
      );

      // Only process if there are indicators of invoice data
      if (hasInvoiceIndicators) {
        const emailAnalysis = await this.analyzeWithModel(emailContent);

        // If we found a total amount in the email, return early
        if (emailAnalysis.totalAmount) {
          return {
            ...this.getDefaultResponse(),
            ...emailAnalysis,
            source: "email" as const,
          };
        }

        // Process attachments only if email didn't contain invoice data
        if (attachments.length > 0) {
          // Sort attachments by likely relevance (PDFs first, then others)
          const sortedAttachments = [...attachments]
            .filter((att) => {
              // Skip large files and non-PDFs that are unlikely to be invoices
              const isLikelyInvoice = /(invoice|receipt|bill|statement)/i.test(
                att.filename
              );
              return att.mimeType === "application/pdf" || isLikelyInvoice;
            })
            .sort((a, b) => {
              const aScore = a.mimeType === "application/pdf" ? 1 : 0;
              const bScore = b.mimeType === "application/pdf" ? 1 : 0;
              return bScore - aScore;
            });

          // Try each relevant attachment
          for (const attachment of sortedAttachments) {
            try {
              const attachmentAnalysis = await this.analyzeWithModel(
                `Filename: ${attachment.filename}\n` +
                  `Content type: ${attachment.mimeType}\n` +
                  `[Attachment content would be analyzed here]`
              );

              if (attachmentAnalysis.totalAmount) {
                return {
                  ...this.getDefaultResponse(),
                  ...attachmentAnalysis,
                  source: "attachment" as const,
                  vendor:
                    attachmentAnalysis.vendor || emailAnalysis.vendor || null,
                  date: attachmentAnalysis.date || emailAnalysis.date || null,
                };
              }
            } catch (error) {
              console.error(
                "Error processing attachment:",
                attachment.filename,
                error
              );
              continue;
            }
          }
        }
      }

      // Return defaults if no invoice data found
      return this.getDefaultResponse();
    } catch (error) {
      console.error("Error in analyzeEmailContentOld:", error);
      return this.getDefaultResponse();
    }
  }
}
