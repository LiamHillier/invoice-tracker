import { NextResponse } from 'next/server';
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

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);

    if (!session?.user?.id) {
      return NextResponse.json(
        {
          success: false,
          message: 'Authentication required',
          error: 'Unauthorized',
          data: [],
          total: 0,
          limit: 0,
          offset: 0
        },
        { status: 401 }
      );
    }

    // Get query parameters from URL
    const { searchParams } = new URL(request.url);
    const limit = Math.min(Number(searchParams.get('limit')) || 10, 100);
    const offset = Number(searchParams.get('offset')) || 0;
    const status = searchParams.get('status') || undefined;
    
    // Remove unused variable
    const whereClause = {
      userId: session.user.id,
      ...(status ? { status } : {}),
    };

    // Fetch invoices with pagination using proper typing
    const selectFields = {
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
    const [invoices, total] = await Promise.all([
      prisma.invoice.findMany({
        where: whereClause,
        select: selectFields,
        orderBy: {
          date: 'desc',
        },
        take: limit,
        skip: offset,
      }),
      prisma.invoice.count({
        where: whereClause,
      }),
    ]);

    // Map the invoices to the expected response format
    const response: InvoiceResponse = {
      success: true,
      data: invoices.map((invoice) => ({
        id: invoice.id,
        userId: invoice.userId,
        accountId: invoice.accountId,
        messageId: invoice.messageId,
        externalId: invoice.externalId,
        invoiceNumber: invoice.invoiceNumber,
        date: invoice.date,
        dueDate: invoice.dueDate,
        amount: invoice.amount,
        currency: invoice.currency,
        status: invoice.status,
        vendorName: invoice.vendorName,
        vendorEmail: invoice.vendorEmail,
        description: invoice.description,
        category: invoice.category,
        tags: invoice.tags || [],
        isProcessed: invoice.isProcessed,
        processedAt: invoice.processedAt,
        error: invoice.error,
        source: invoice.source,
        metadata: invoice.metadata ? JSON.parse(JSON.stringify(invoice.metadata)) : null,
        rawData: invoice.rawData,
        createdAt: invoice.createdAt,
        updatedAt: invoice.updatedAt,
        account: {
          email: invoice.account.email,
          provider: invoice.account.provider,
        },
      })),
      total,
      limit,
      offset,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching invoices:', error);
    
    // Handle known error types
    if (error instanceof Error && error.name === 'PrismaClientKnownRequestError') {
      return NextResponse.json(
        {
          success: false,
          message: 'Database error',
          error: error.message,
          data: [],
          total: 0,
          limit: 0,
          offset: 0
        },
        { status: 400 }
      );
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

    return NextResponse.json(errorResponse, { status: 500 });
  }
}
