import { prisma } from '@/lib/db/prisma';

// This would be called by a scheduled job (e.g., Vercel Cron Jobs, GitHub Actions, etc.)
export async function scheduledEmailScan() {
  try {
    // Get all active accounts that are due for a sync
    const accounts = await prisma.account.findMany({
      where: {
        isActive: true,
        provider: 'google',
        OR: [
          { lastSynced: null },
          {
            lastSynced: {
              lt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 24 hours since last sync
            },
          },
        ],
      },
      select: {
        id: true,
        userId: true,
        email: true,
      },
    });

    if (accounts.length === 0) {
      console.log('No accounts due for sync');
      return { success: true, message: 'No accounts due for sync' };
    }

    console.log(`Initiating scheduled scan for ${accounts.length} accounts`);

    // Process each account
    const results = [];
    for (const account of accounts) {
      try {
        const scanner = new EmailScanner(account.userId, account.id);
        const result = await scanner.processAllEmails(20, 5); // Smaller batches for scheduled scans
        
        results.push({
          accountId: account.id,
          email: account.email,
          success: true,
          ...result,
        });
      } catch (error) {
        console.error(`Error processing account ${account.id}:`, error);
        
        await prisma.account.update({
          where: { id: account.id },
          data: {
            syncStatus: 'error',
            syncError: error instanceof Error ? error.message : 'Unknown error',
          },
        });
        
        results.push({
          accountId: account.id,
          email: account.email,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    const successfulScans = results.filter((r) => r.success).length;
    const failedScans = results.length - successfulScans;

    return {
      success: true,
      message: `Scheduled scan completed: ${successfulScans} successful, ${failedScans} failed`,
      results,
    };
  } catch (error) {
    console.error('Error in scheduled email scan:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// This would be called by your scheduled job handler
export async function handler() {
  if (process.env.VERCEL_ENV !== 'production') {
    console.log('Skipping scheduled scan in non-production environment');
    return { success: true, message: 'Skipped in non-production' };
  }

  return scheduledEmailScan();
}
