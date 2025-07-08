'use client';

import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/ui/icons';
import { toast } from 'sonner';
import { prisma } from '@/lib/db/prisma';
import { formatCurrency } from '@/lib/utils';

interface Invoice {
  id: string;
  subject: string;
  from: string;
  date: string;
  amount: number;
  currency: string;
  status: string;
  vendor?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
}

export default function DashboardPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isScanning, setIsScanning] = useState(false);
  const [forceRescan, setForceRescan] = useState(false);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/auth/sign-in');
      return;
    }

    if (status === 'authenticated') {
      fetchInvoices();
    }
  }, [status, router]);

  const fetchInvoices = async () => {
    try {
      const response = await fetch('/api/invoices');
      if (!response.ok) {
        throw new Error('Failed to fetch invoices');
      }
      const data = await response.json();
      setInvoices(data);
    } catch (error) {
      console.error('Error fetching invoices:', error);
      toast.error('Failed to load invoices');
    } finally {
      setIsLoading(false);
    }
  };

  const handleScanEmails = async (force: boolean = false) => {
    if (isScanning) return;
    
    setIsScanning(true);
    const toastId = toast.loading(force ? 'Force rescanning all emails...' : 'Scanning emails for invoices...');
    
    try {
      const response = await fetch('/api/email-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          batchSize: 50,
          query: 'in:inbox is:unread',
          forceRescan: force,
        }),
      });
      
      const result = await response.json();
      
      if (response.ok) {
        toast.success(result.message, { id: toastId });
        await fetchInvoices();
      } else {
        throw new Error(result.error || 'Failed to scan emails');
      }
    } catch (error) {
      console.error('Error scanning emails:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to scan emails', {
        id: toastId,
      });
    } finally {
      setIsScanning(false);
    }
  };

  if (status === 'loading' || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Icons.spinner className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  if (status === 'unauthenticated') {
    return null; // Redirecting to sign-in
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-8 gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Invoice Tracker</h1>
          <p className="text-muted-foreground">
            Manage and track your invoices in one place
          </p>
        </div>
        <div className="flex flex-col space-y-2">
          <Button 
            onClick={() => handleScanEmails(false)} 
            disabled={isScanning}
            variant="outline"
            className="w-full"
          >
            {isScanning && !forceRescan ? (
              <Icons.spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.refresh className="mr-2 h-4 w-4" />
            )}
            Scan New Emails
          </Button>
          <Button 
            onClick={() => handleScanEmails(true)}
            disabled={isScanning}
            variant="outline"
            className="w-full"
          >
            {isScanning && forceRescan ? (
              <Icons.spinner className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Icons.refresh className="mr-2 h-4 w-4" />
            )}
            Force Rescan All
          </Button>
        </div>
      </div>

      <div className="rounded-md border">
        <div className="relative w-full overflow-auto">
          <table className="w-full caption-bottom text-sm">
            <thead className="[&_tr]:border-b">
              <tr className="border-b transition-colors hover:bg-muted/50">
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Vendor</th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Subject</th>
                <th className="h-12 px-4 text-left align-middle font-medium text-muted-foreground">Date</th>
                <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">Amount</th>
                <th className="h-12 px-4 text-right align-middle font-medium text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody className="[&_tr:last-child]:border-0">
              {invoices.length > 0 ? (
                invoices.map((invoice) => (
                  <tr key={invoice.id} className="border-b transition-colors hover:bg-muted/50">
                    <td className="p-4 align-middle font-medium">
                      {invoice.vendor || invoice.from}
                    </td>
                    <td className="p-4 align-middle">
                      <div className="font-medium">{invoice.subject}</div>
                      {invoice.fileName && (
                        <div className="text-sm text-muted-foreground">
                          {invoice.fileName}
                        </div>
                      )}
                    </td>
                    <td className="p-4 align-middle">
                      {new Date(invoice.date).toLocaleDateString()}
                    </td>
                    <td className="p-4 text-right align-middle font-medium">
                      {formatCurrency(invoice.amount, invoice.currency)}
                    </td>
                    <td className="p-4 text-right align-middle">
                      <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        invoice.status === 'processed'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                          : 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200'
                      }`}>
                        {invoice.status}
                      </span>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-muted-foreground">
                    No invoices found. Click "Scan for Invoices" to start.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
