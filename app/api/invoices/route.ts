import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth/next';
import { authOptions } from '@/lib/auth/options';
import { prisma } from '@/lib/db/prisma';

// Type definitions
interface InvoiceResponse {
  success: boolean;
  data: Array<{
    id: string;
    userId: string;
    accountId: string;
    messageId: string;
    externalId: string | null;
    invoiceNumber: string | null;
    date: Date;
    dueDate: Date | null;
    amount: number;
    currency: string;
    status: string;
    vendorName: string | null;
    vendorEmail: string | null;
    description: string | null;
    category: string | null;
    tags: string[];
    isProcessed: boolean;
    processedAt: Date | null;
    error: string | null;
    source: string | null;
    metadata: Record<string, unknown> | null;
    rawData: unknown;
    createdAt: Date;
    updatedAt: Date;
    account: {
      email: string;
      provider: string;
    };
  }>;
  message?: string;
  error?: string;
  details?: unknown;
  total: number;
  limit: number;
  offset: number;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<InvoiceResponse>
) {
  try {
    const session = await getServerSession(authOptions);

    if (req.method !== 'GET') {
      res.setHeader('Allow', ['GET']);
      return res.status(405).end(`Method ${req.method} Not Allowed`);
    }

    if (!session?.user?.id) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required',
        error: 'Unauthorized',
        data: [],
        total: 0,
        limit: 0,
        offset: 0
      });
    }

    // Get query parameters
    const limit = Math.min(Number(req.query.limit) || 999, 1000);
    const offset = Number(req.query.offset) || 0;
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;

    // Build the query
    const where = {
      userId: session.user.id,
      ...(status ? { status } : {}),
    };

    // Define the invoice select fields to ensure type safety
    const invoiceSelect = {
      id: true,
      userId: true,
      accountId: true,
      messageId: true,
      externalId: true,
      invoiceNumber: true,
      date: true,
      dueDate: true,
      amount: true,
      currency: true,
      status: true,
      vendorName: true,
      vendorEmail: true,
      description: true,
      category: true,
      tags: true,
      isProcessed: true,
      processedAt: true,
      error: true,
      source: true,
      metadata: true,
      rawData: true,
      createdAt: true,
      updatedAt: true,
      account: {
        select: {
          email: true,
          provider: true,
        },
      },
    };

    // Get paginated invoices with proper typing
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: invoiceSelect,
        orderBy: { date: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.invoice.count({ where }),
    ]);

    // Create response with proper typing
    const response: InvoiceResponse = {
      success: true,
      data: invoices.map(invoice => ({
        ...invoice,
        // Ensure all required fields are present with proper types
        externalId: invoice.externalId ?? null,
        invoiceNumber: invoice.invoiceNumber ?? null,
        vendorName: invoice.vendorName ?? null,
        vendorEmail: invoice.vendorEmail ?? null,
        description: invoice.description ?? null,
        category: invoice.category ?? null,
        tags: invoice.tags ?? [],
        processedAt: invoice.processedAt ?? null,
        error: invoice.error ?? null,
        source: invoice.source ?? null,
        metadata: invoice.metadata as Record<string, unknown> | null,
      })),
      total,
      limit,
      offset,
    };

    return res.status(200).json(response);
  } catch (error: unknown) {
    console.error('Error fetching invoices:', error);
    
    // Log detailed error for server-side debugging
    if (error instanceof Error) {
      console.error('Error details:', {
        message: error.message,
        stack: error.stack,
        name: error.name,
      });
    }

    const errorResponse: InvoiceResponse = {
      success: false,
      message: 'Failed to fetch invoices',
      error: 'Internal Server Error',
      data: [],
      total: 0,
      limit: 0,
      offset: 0
    };

    if (process.env.NODE_ENV === 'development' && error) {
      errorResponse.details = error;
    }

    return res.status(500).json(errorResponse);
  }
}
