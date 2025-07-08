import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/options';
import { prisma } from '@/lib/db/prisma';
import { EmailScanner } from '@/lib/email/scanner';
import { z } from 'zod';

// Type definitions
interface RateLimitState {
  count: number;
  lastReset: number;
}

type EmailProvider = 'gmail' | 'outlook' | 'imap';

interface ScanResult {
  accountId: string;
  email: string;
  status: 'success' | 'error' | 'skipped';
  processed?: number;
  failed?: number;
  error?: string;
  details?: unknown;
}

interface ScanResponse {
  success: boolean;
  message: string;
  data?: {
    processed: number;
    failed: number;
    total: number;
    duration: number;
  };
  error?: string;
  details?: unknown;
  durationMs?: number;
  summary?: Record<string, number>;
  results?: ScanResult[];
}

const SUPPORTED_PROVIDERS: EmailProvider[] = ['gmail', 'outlook', 'imap'];

function isSupportedProvider(provider: string): provider is EmailProvider {
  return SUPPORTED_PROVIDERS.includes(provider as EmailProvider);
}

// Rate limiting configuration
const RATE_LIMIT = {
  WINDOW_MS: 60 * 1000, // 1 minute
  MAX_REQUESTS: 5, // Max requests per window
};

// Track request counts per user
const requestCounts = new Map<string, RateLimitState>();

// Input validation schema
const ScanRequestSchema = z.object({
  batchSize: z.number().min(1).max(100).default(50),
  query: z.string().default(''),
  forceRescan: z.boolean().default(false),
}).strict();

export async function POST(request: Request) {
  const startTime = Date.now();
  const session = await getServerSession(authOptions);

  if (!session?.user?.id) {
    return NextResponse.json(
      {
        success: false,
        message: 'Authentication required',
        error: 'Unauthorized'
      },
      { status: 401 }
    );
  }

  try {

    // Rate limiting check
    const now = Date.now();
    const userId = session.user.id;
    const userRequest = requestCounts.get(userId) || {
      count: 0,
      lastReset: now,
    };

    // Reset counter if window has passed
    if (now - userRequest.lastReset > RATE_LIMIT.WINDOW_MS) {
      userRequest.count = 0;
      userRequest.lastReset = now;
    }

    // Check rate limit
    if (userRequest.count >= RATE_LIMIT.MAX_REQUESTS) {
      const headers = new Headers();
      headers.set('Retry-After', String(Math.ceil((RATE_LIMIT.WINDOW_MS - (now - userRequest.lastReset)) / 1000)));
      headers.set('X-RateLimit-Limit', String(RATE_LIMIT.MAX_REQUESTS));
      headers.set('X-RateLimit-Remaining', '0');
      headers.set('X-RateLimit-Reset', String(userRequest.lastReset + RATE_LIMIT.WINDOW_MS));

      return NextResponse.json(
        {
          success: false,
          message: 'Too many requests',
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((RATE_LIMIT.WINDOW_MS - (now - userRequest.lastReset)) / 1000)
        },
        { status: 429, headers, statusText: 'Too Many Requests' }
      );
    }

    // Increment request count
    userRequest.count++;
    requestCounts.set(userId, userRequest);

    // Parse and validate request body
    const body = await request.json();
    const validation = ScanRequestSchema.safeParse(body);

    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          message: 'Invalid request data',
          error: 'Validation failed',
          details: validation.error.format()
        },
        { status: 400 }
      );
    }


    // Get active email accounts for the user
    const accounts = await prisma.account.findMany({
      where: {
        userId: session.user.id,
        isActive: true,
        // Removed lastError as it's not part of the Account model
      },
      select: {
        id: true,
        email: true,
        provider: true,
        access_token: true,
        refresh_token: true,
        expires_at: true,
        updatedAt: true,
      },
    });

    if (accounts.length === 0) {
      return NextResponse.json(
        {
          success: false,
          message: 'No active email accounts found',
          error: 'No accounts available for scanning'
        },
        { status: 400 }
      );
    }

    console.log(
      `[Email Scan] Starting scan for user ${session.user.id} with ${accounts.length} accounts`
    );

    const results: ScanResult[] = [];
    let processed = 0;
    let failed = 0;

    for (const account of accounts) {
      const scanner = new EmailScanner(session.user.id, account.id);
      try {
        if (!isSupportedProvider(account.provider)) {
          results.push({
            accountId: account.id,
            email: account.email,
            status: 'skipped',
            error: `Unsupported provider: ${account.provider}`
          });
          continue;
        }

        const result = await scanner.scanEmails(
          validation.data.query || '(invoice OR receipt OR bill OR payment OR "purchase order" OR "sales order")',
          validation.data.batchSize || 500,
          undefined, // pageToken
          validation.data.forceRescan || false
        );

        const scanResult: ScanResult = {
          accountId: account.id,
          email: account.email,
          status: 'success',
          processed: result.processed,
          failed: result.errors,
          details: result
        };

        results.push(scanResult);
        processed += result.processed;
        failed += result.errors;
      } catch (error) {
        console.error(`Error scanning account ${account.email}:`, error);
        failed++;
        const errorResult: ScanResult = {
          accountId: account.id,
          email: account.email,
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
        };

        if (process.env.NODE_ENV === 'development') {
          errorResult.details = error instanceof Error ? error.stack : error;
        }

        results.push(errorResult);
      }
    }

    const response: ScanResponse = {
      success: true,
      message: `Processed ${processed} emails (${failed} failed)`,
      data: {
        processed,
        failed,
        total: processed + failed,
        duration: Math.floor((Date.now() - startTime) / 1000),
      },
      results,
      durationMs: Date.now() - startTime,
    };

    // Add summary of results
    if (results.length > 0) {
      response.summary = results.reduce((acc, result) => {
        acc[result.status] = (acc[result.status] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);
    }

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    console.error('Error in email scan handler:', error);
    const errorResponse: ScanResponse = {
      success: false,
      message: 'Failed to process email scan',
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.details = error instanceof Error ? error.stack : error;
    }

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
