import { PrismaAdapter } from "@auth/prisma-adapter";
import { NextAuthOptions, User, Account, Profile, getServerSession } from "next-auth";
import { JWT } from "next-auth/jwt";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import { compare } from "bcryptjs";
import { prisma } from "@/lib/db/prisma";
import { ProviderType } from "@prisma/client";
import { AdapterUser } from "next-auth/adapters";

// Extend the built-in session types
declare module "next-auth" {
  interface Session {
    accessToken?: string;
    user: User & {
      id: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    accessToken?: string;
    refreshToken?: string;
    accessTokenExpires?: number;
  }
}

export const authOptions: NextAuthOptions = {
  adapter: PrismaAdapter(prisma),
  providers: [
    CredentialsProvider({
      name: 'credentials',
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" }
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error('Please enter your email and password');
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email }
        });

        if (!user || !user.password) {
          throw new Error('No user found with this email');
        }

        const isPasswordValid = await compare(credentials.password, user.password);

        if (!isPasswordValid) {
          throw new Error('Incorrect password');
        }

        return {
          id: user.id,
          email: user.email,
          name: user.name,
          image: user.image,
        };
      },
    }),
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      authorization: {
        params: {
          prompt: "consent",
          access_type: "offline",
          response_type: "code",
          scope: [
            "openid",
            "email",
            "profile",
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.modify",
          ].join(" "),
        },
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account, profile }) {
      // If this is a credentials sign-in, just return true
      if (account?.provider === 'credentials') {
        return true;
      }

      // Handle Google OAuth sign-in
      if (account?.provider === 'google') {
        try {
          // Check if we're in the middle of a session (account linking)
          const session = await getServerSession(authOptions);
          
          if (session?.user?.id) {
            // Verify the user exists before attempting to link accounts
            const existingUser = await prisma.user.findUnique({
              where: { id: session.user.id },
            });

            if (!existingUser) {
              console.error('User not found for account linking:', session.user.id);
              return '/auth/error?error=UserNotFound';
            }

            // Check if this account is already linked to any user
            const existingAccount = await prisma.account.findFirst({
              where: {
                provider: account.provider,
                providerAccountId: account.providerAccountId,
              },
            });

            if (existingAccount) {
              // If account is already linked to a different user
              if (existingAccount.userId !== session.user.id) {
                return '/auth/error?error=AccountAlreadyLinked';
              }
              // Update existing account
              await prisma.account.update({
                where: { id: existingAccount.id },
                data: {
                  access_token: account.access_token,
                  refresh_token: account.refresh_token,
                  expires_at: account.expires_at,
                  token_type: account.token_type,
                  scope: account.scope,
                  id_token: account.id_token,
                  session_state: account.session_state as string | null,
                  isActive: true,
                  lastSynced: new Date(),
                  email: (user as AdapterUser).email || '',
                },
              });
            } else {
              // Create new account link
              await prisma.account.create({
                data: {
                  userId: session.user.id,
                  type: account.type as ProviderType,
                  provider: account.provider,
                  providerAccountId: account.providerAccountId,
                  refresh_token: account.refresh_token || null,
                  access_token: account.access_token || null,
                  expires_at: account.expires_at || null,
                  token_type: account.token_type || null,
                  scope: account.scope || null,
                  id_token: account.id_token || null,
                  session_state: account.session_state as string | null,
                  isActive: true,
                  lastSynced: new Date(),
                  email: (user as AdapterUser).email || '',
                },
              });
            }

            // Redirect to the connected accounts page
            return '/settings/connected-accounts?success=Account+connected+successfully';
          }
        } catch (error) {
          console.error('Error in signIn callback:', error);
          return '/auth/error?error=AccountLinkingFailed';
        }
      }

      return true;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
      }
      return session;
    },
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
  },
  session: {
    strategy: "jwt",
  },
  pages: {
    signIn: "/auth/sign-in",
    error: "/auth/error",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
