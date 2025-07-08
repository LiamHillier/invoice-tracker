import { NextResponse } from 'next/server';
import { hash } from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';

interface SignupRequest {
  name: string;
  email: string;
  password: string;
}

interface ErrorResponse {
  success: boolean;
  message: string;
  error: string;
  stack?: string;
}

export async function POST(request: Request) {
  try {
    const { name, email, password } = (await request.json()) as SignupRequest;

    // Validate input
    if (!name?.trim() || !email?.trim() || !password) {
      return NextResponse.json(
        { 
          success: false,
          message: 'Name, email, and password are required' 
        },
        { status: 400 }
      );
    }

    // Normalize email
    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (existingUser) {
      return NextResponse.json(
        { 
          success: false,
          message: 'User with this email already exists' 
        },
        { status: 400 }
      );
    }

    // Hash password
    const hashedPassword = await hash(password, 12);

    // Create user
    const user = await prisma.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(
      { 
        success: true,
        message: 'User created successfully',
        data: user
      },
      { status: 201 }
    );
  } catch (error) {
    console.error('Signup error:', error);
    const errorResponse: ErrorResponse = {
      success: false,
      message: 'Failed to create user',
      error: error instanceof Error ? error.message : 'Unknown error',
    };

    if (process.env.NODE_ENV === 'development') {
      errorResponse.stack = error instanceof Error ? error.stack : undefined;
    }

    return NextResponse.json(
      errorResponse,
      { status: 500 }
    );
  }
}
