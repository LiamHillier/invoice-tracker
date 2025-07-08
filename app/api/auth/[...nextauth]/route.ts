import NextAuth from 'next-auth';
import { authOptions } from '@/lib/auth/options';

// Initialize NextAuth with the provided options
const handler = NextAuth(authOptions);

// Export the handler for both GET and POST requests
export { handler as GET, handler as POST };

// For compatibility with older versions
export default handler;
