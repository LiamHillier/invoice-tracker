import OpenAI from 'openai';
import { createHash } from 'crypto';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Simple in-memory cache (consider using Redis in production)
const responseCache = new Map<string, any>();

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
  source: 'email' | 'attachment' | 'combined';
  processed?: boolean;
  error?: string;
};

type Attachment = {
  filename: string;
  mimeType: string;
  data: string; // Base64 encoded content
};

const INVOICE_SYSTEM_PROMPT = `You are an AI assistant specialized in extracting structured invoice and receipt information.

For each input, analyze the content and extract the following information if available:
1. Determine if this is an invoice, receipt, or purchase-related document (isInvoice: true/false)
2. Extract vendor/organization name
3. Extract invoice/receipt number if present
4. Find the invoice date (prioritize the most recent date if multiple are found)
5. Extract due date if mentioned
6. Find the total amount and its currency (look for phrases like 'total', 'amount due', 'balance')
7. Categorize the expense (e.g., utilities, office supplies, software, travel, etc.)

Return a JSON object with the extracted information. If a field cannot be determined, set it to null.`;

export type BatchEmailItem = {
  id: string;
  subject: string;
  body: string;
  attachments: Attachment[];
};

export type BatchAnalysisResult = {
  [key: string]: InvoiceData;
};

export class OpenAIService {
  private static BATCH_SIZE = 5; // Number of emails to process in a single batch

  private static generateCacheKey(content: string, model: string): string {
    // Create a hash of the content and model to use as cache key
    const hash = createHash('sha256')
      .update(content + model)
      .digest('hex');
    return `ai_cache_${hash}`;
  }

  private static preprocessContent(content: string, maxLength = 2000): string {
    if (!content) return '';
    // Remove excessive whitespace and newlines
    let processed = content
      .replace(/\s+/g, ' ')
      .trim();
    
    // Truncate to specified length
    return processed.length > maxLength 
      ? processed.substring(0, maxLength) + '... [truncated]' 
      : processed;
  }

  private static async analyzeWithModel(
    content: string,
    model: 'gpt-3.5-turbo' | 'gpt-4-turbo-preview' = 'gpt-4-turbo-preview',
    isRetry = false
  ): Promise<Partial<InvoiceData>> {
    const processedContent = this.preprocessContent(content);
    const cacheKey = this.generateCacheKey(processedContent, model);
    
    // Check cache first
    if (responseCache.has(cacheKey)) {
      return responseCache.get(cacheKey);
    }

    try { 
      // Skip API call if content is too short to be an invoice
      if (processedContent.length < 50) {
        return this.getDefaultResponse();
      }

      const response = await openai.chat.completions.create({
        model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: INVOICE_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Analyze the following content and extract any invoice or receipt information.
            Focus on identifying key details like vendor, amounts, dates, and categories.
            
            Content:
            ${processedContent}`,
          },
        ],
        temperature: 0.1,
        max_tokens: 500, // Reduced from 1000 as we don't need that many tokens
      });

      const result = response.choices[0]?.message?.content;
      if (!result) throw new Error('No response from AI service');

      const parsed = JSON.parse(result);
      const responseData = {
        vendor: parsed.vendor || null,
        invoiceNumber: parsed.invoiceNumber || parsed.receiptNumber || null,
        date: parsed.invoiceDate || parsed.date || null,
        dueDate: parsed.dueDate || null,
        totalAmount: parsed.totalAmount ? parseFloat(parsed.totalAmount) : null,
        currency: parsed.currency || null,
        isInvoice: parsed.isInvoice || false,
        confidence: parsed.confidence || (model === 'gpt-4-turbo-preview' ? 0.8 : 0.6),
        categories: Array.isArray(parsed.categories) 
          ? parsed.categories 
          : (parsed.category ? [parsed.category] : [])
      };

      // Cache the successful response
      responseCache.set(cacheKey, responseData);
      return responseData;
      
    } catch (error) {
      // Type guard to check if error is an object with a code property
      const isErrorWithCode = (error: unknown): error is { code: string } => {
        return typeof error === 'object' && error !== null && 'code' in error;
      };

      if (!isRetry && model === 'gpt-4-turbo-preview') {
        // Only fall back to GPT-3.5 for certain error types
        if (isErrorWithCode(error) && (error.code === 'rate_limit_exceeded' || error.code === 'server_error')) {
          return this.analyzeWithModel(content, 'gpt-3.5-turbo', true);
        }
      }
      console.error('Error in analyzeWithModel:', error);
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
      source: 'email' as const
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
        console.error(`Error processing batch ${i / this.BATCH_SIZE + 1}:`, error);
        // Mark failed emails in this batch
        batch.forEach(email => {
          results[email.id] = {
            ...this.getDefaultResponse(),
            processed: false,
            error: 'Failed to process batch',
            isInvoice: false,
            confidence: 0
          };
        });
      }
    }
    
    return results;
  }

  private static async processBatch(emails: BatchEmailItem[]): Promise<BatchAnalysisResult> {
    // Create a prompt that includes all emails in the batch
    const batchPrompt = emails.map((email, index) => 
      `--- Email ${index + 1} (ID: ${email.id}) ---\n` +
      `Subject: ${email.subject || 'No Subject'}\n` +
      `Body: ${this.preprocessContent(email.body, 1500)}\n`
    ).join('\n\n');

    const cacheKey = this.generateCacheKey(batchPrompt, 'gpt-4-turbo-preview');
    
    // Check cache first
    if (responseCache.has(cacheKey)) {
      return responseCache.get(cacheKey);
    }

    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-4-turbo-preview',
        response_format: { type: "json_object" },
        messages: [
          { 
            role: "system", 
            content: `${INVOICE_SYSTEM_PROMPT}\n\n` +
              `You will receive multiple emails in this format:\n` +
              `--- Email N (ID: [ID]) ---\n` +
              `[Email content]\n\n` +
              `Return a JSON object where keys are the email IDs and values are the extracted data. ` +
              `If an email is not an invoice, set isInvoice: false and confidence: 0.`
          },
          {
            role: "user",
            content: batchPrompt
          }
        ],
        temperature: 0.1,
        max_tokens: 3000, // Increased for batch processing
      });

      const result = JSON.parse(response.choices[0].message.content || '{}');
      
      // Validate and normalize the response
      const processedResults: BatchAnalysisResult = {};
      emails.forEach(email => {
        const emailResult = result[email.id] || this.getDefaultResponse();
        processedResults[email.id] = {
          ...emailResult,
          processed: true,
          // Ensure required fields exist
          isInvoice: emailResult.isInvoice === true,
          confidence: Math.min(1, Math.max(0, emailResult.confidence || 0)),
          categories: Array.isArray(emailResult.categories) ? emailResult.categories : [],
          source: emailResult.source || 'email'
        };
      });

      // Cache the results
      responseCache.set(cacheKey, processedResults);
      return processedResults;
    } catch (error) {
      console.error('Error in batch processing:', error);
      throw error;
    }
  }

  static async analyzeEmailContent(
    content: string,
    attachments: Attachment[] = []
  ): Promise<InvoiceData> {
    // For backward compatibility, wrap single email in a batch
    const dummyEmail = {
      id: 'single-email',
      subject: 'Single Email Processing',
      body: content,
      attachments
    };
    
    const results = await this.analyzeBatchEmailContent([dummyEmail]);
    return results['single-email'] || this.getDefaultResponse();
  }

  static async analyzeEmailContentOld(
    emailContent: string,
    attachments: Attachment[] = []
  ): Promise<InvoiceData> {
    try {
      // Check if email is likely to contain invoice data
      const invoiceKeywords = ['invoice', 'receipt', 'bill', 'payment', 'amount', '$', 'due', 'total'];
      const hasInvoiceIndicators = invoiceKeywords.some(keyword => 
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
            source: 'email' as const
          };
        }

        // Process attachments only if email didn't contain invoice data
        if (attachments.length > 0) {
          // Sort attachments by likely relevance (PDFs first, then others)
          const sortedAttachments = [...attachments]
            .filter(att => {
              // Skip large files and non-PDFs that are unlikely to be invoices
              const isLikelyInvoice = /(invoice|receipt|bill|statement)/i.test(att.filename);
              return att.mimeType === 'application/pdf' || isLikelyInvoice;
            })
            .sort((a, b) => {
              const aScore = a.mimeType === 'application/pdf' ? 1 : 0;
              const bScore = b.mimeType === 'application/pdf' ? 1 : 0;
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
                  source: 'attachment' as const,
                  vendor: attachmentAnalysis.vendor || emailAnalysis.vendor || null,
                  date: attachmentAnalysis.date || emailAnalysis.date || null,
                };
              }
            } catch (error) {
              console.error('Error processing attachment:', attachment.filename, error);
              continue;
            }
          }
        }
      }

      // Return defaults if no invoice data found
      return this.getDefaultResponse();
      
    } catch (error) {
      console.error('Error in analyzeEmailContent:', error);
      return this.getDefaultResponse();
    }
  }
}
