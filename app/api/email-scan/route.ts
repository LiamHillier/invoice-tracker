import { NextResponse, type NextRequest } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/options";
import { prisma } from "@/lib/db/prisma";
import { EmailScanner } from "@/lib/email/scanner";
import { z } from "zod";

// Rate limiting configuration
const RATE_LIMIT = {
  WINDOW_MS: 60 * 1000, // 1 minute
  MAX_REQUESTS: 5, // Max requests per window
};

// Track request counts per user
const requestCounts = new Map<string, { count: number; lastReset: number }>();

export const dynamic = "force-dynamic";

// Input validation schema
const ScanRequestSchema = z.object({
  batchSize: z.number().min(1).max(100).default(50),
  query: z.string().default(""),
  forceRescan: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  const startTime = Date.now();

  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        { success: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    // Rate limiting check
    const now = Date.now();
    const userRequest = requestCounts.get(session.user.id) || {
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
      return NextResponse.json(
        {
          success: false,
          error: "Too many requests. Please try again later.",
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(
              Math.ceil(
                (userRequest.lastReset + RATE_LIMIT.WINDOW_MS - now) / 1000
              )
            ),
            "X-RateLimit-Limit": String(RATE_LIMIT.MAX_REQUESTS),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(
              Math.ceil((userRequest.lastReset + RATE_LIMIT.WINDOW_MS) / 1000)
            ),
          },
        }
      );
    }

    // Increment request count
    userRequest.count++;
    requestCounts.set(session.user.id, userRequest);

    // Parse and validate request body
    let body;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }

    const validation = ScanRequestSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid request parameters",
          details: validation.error.issues,
        },
        { status: 400 }
      );
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
      return NextResponse.json(
        {
          success: false,
          error:
            "No active Gmail accounts found. Please connect a Gmail account first.",
        },
        { status: 400 }
      );
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

    return NextResponse.json({
      success: true,
      message: `Processed ${results.length} accounts in ${(
        totalDuration / 1000
      ).toFixed(2)}s`,
      durationMs: totalDuration,
      summary,
      results,
    });
  } catch (err) {
    console.error("Error in email-scan route:", err);
    return NextResponse.json(
      {
        success: false,
        error: err instanceof Error ? err.message : "Internal server error",
        stack:
          process.env.NODE_ENV === "development" && err instanceof Error
            ? err.stack
            : undefined,
      },
      { status: 500 }
    );
  }
}
