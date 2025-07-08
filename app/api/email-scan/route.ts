import type { NextApiRequest, NextApiResponse } from 'next';
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

interface ScanRequest {
  batchSize?: number;
  query?: string;
  forceRescan?: boolean;
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
  results?: Array<{
    accountId: string;
    email: string;
    status: string;
    [key: string]: unknown;
  }>;
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

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<ScanResponse>
) {
  const startTime = Date.now();
  const session = await getServerSession(authOptions);

  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  if (!session?.user?.id) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required',
      error: 'Unauthorized'
    });
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
      res.setHeader('Retry-After', String(Math.ceil((RATE_LIMIT.WINDOW_MS - (now - userRequest.lastReset)) / 1000)));
      res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT.MAX_REQUESTS));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(userRequest.lastReset + RATE_LIMIT.WINDOW_MS));
      
      return res.status(429).json({
        success: false,
        message: 'Rate limit exceeded',
        error: 'Too many requests'
      });
    }

    // Increment request count
    userRequest.count++;
    requestCounts.set(userId, userRequest);

    // Parse and validate request body
    let body: ScanRequest;
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Invalid request body';
      return res.status(400).json({
        success: false,
        message: 'Invalid request',
        error: errorMessage
      });
    }

    const validation = ScanRequestSchema.safeParse(body);
    if (!validation.success) {
      return res.status(400).json({
        success: false,
        message: 'Invalid request data',
        error: 'Validation failed',
        details: validation.error.format()
      });
    }

    const { batchSize, query, forceRescan } = validation.data;

    // Get all active Gmail accounts for the user
    const accounts = await prisma.account.findMany({
      where: {
        userId: session.user.id,
        provider: "google",
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        syncStatus: true,
        lastSynced: true,
      },
    });

    if (accounts.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No active Gmail accounts found',
        error: 'Please connect a Gmail account first.'
      });
    }

    console.log(
      `[Email Scan] Starting scan for user ${session.user.id} with ${accounts.length} accounts`
    );

    // Process each account in parallel with rate limiting
    const batchPromises = accounts.map((account) =>
      (async () => {
        const accountStartTime = Date.now();
        const accountLogger = (message: string) =>
          console.log(`[${account.email}] ${message}`);

        try {
          // Skip if already syncing unless forceRescan is true
          if (!forceRescan && account.syncStatus === "syncing") {
            accountLogger("Skipping - already syncing");
            return {
              accountId: account.id,
              email: account.email,
              status: "skipped",
              reason: "Account is already being synced",
              durationMs: Date.now() - accountStartTime,
            };
          }

          // Update account status
          await prisma.account.update({
            where: { id: account.id },
            data: {
              syncStatus: "syncing",
              syncStartedAt: new Date(),
              syncError: null,
            },
          });

          accountLogger(`Starting scan with batch size ${batchSize}`);
          const scanner = new EmailScanner(session.user.id, account.id);

          // Process emails in batches
          const result = await scanner.processAllEmails(query, batchSize);
          const duration = Date.now() - accountStartTime;

          // Update account with success status
          await prisma.account.update({
            where: { id: account.id },
            data: {
              syncStatus: "idle",
              lastSynced: new Date(),
              syncError: null,
            },
          });

          accountLogger(
            `Completed scan in ${duration}ms: ${JSON.stringify(result)}`
          );

          return {
            accountId: account.id,
            email: account.email,
            status: "completed",
            durationMs: duration,
            ...result,
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Unknown error";
          console.error(`[${account.email}] Error during scan:`, error);

          // Update account with error status
          try {
            await prisma.account.update({
              where: { id: account.id },
              data: {
                syncStatus: "error",
                syncError: errorMessage,
              },
            });
          } catch (dbError) {
            console.error(
              `[${account.email}] Failed to update account status:`,
              dbError
            );
          }

          return {
            accountId: account.id,
            email: account.email,
            status: "error",
            error: errorMessage,
            durationMs: Date.now() - accountStartTime,
          };
        }
      })()
    );

    // Process accounts with a small delay between each to avoid rate limiting
    const BATCH_DELAY_MS = 2000; // 2 seconds between account processing
    const results = [];

    for (let i = 0; i < batchPromises.length; i++) {
      if (i > 0) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS));
      }
      results.push(await batchPromises[i]);
    }

    // Define the shape of our summary object
    interface ScanSummary {
      completed: number;
      skipped: number;
      error: number;
      totalProcessed: number;
      totalSkipped: number;
      totalErrors: number;
      [key: string]: number; // Allow any string key with number value
    }

    // Calculate summary
    const summary = results.reduce<ScanSummary>(
      (acc, result) => {
        acc[result.status] = (acc[result.status] || 0) + 1;

        // Handle different result structures - successful scans vs error scans
        if (result.status === "completed" && "totalProcessed" in result) {
          acc.totalProcessed += result.totalProcessed || 0;
          acc.totalSkipped += result.totalSkipped || 0;
          acc.totalErrors += result.totalErrors || 0;
        }

        return acc;
      },
      {
        completed: 0,
        skipped: 0,
        error: 0,
        totalProcessed: 0,
        totalSkipped: 0,
        totalErrors: 0,
      }
    );

    const totalDuration = Date.now() - startTime;

    console.log(
      `[Email Scan] Completed scan for user ${session.user.id} in ${totalDuration}ms`,
      {
        accountsProcessed: results.length,
        ...summary,
      }
    );

    return res.status(200).json({
      success: true,
      message: `Processed ${results.length} accounts in ${(totalDuration / 1000).toFixed(2)}s`,
      durationMs: totalDuration,
      summary,
      results,
    });
  } catch (error) {
    console.error('Error in email scan:', error);
    
    // Log detailed error for server-side debugging
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });
    }

    const errorResponse: ScanResponse = {
      success: false,
      message: 'An error occurred during email scanning',
      error: 'Internal Server Error'
    };

    if (process.env.NODE_ENV === 'development' && error) {
      errorResponse.details = error;
    }

    return res.status(500).json(errorResponse);
  }
}
