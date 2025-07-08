import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { prisma } from '@/lib/db/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'DELETE') {
    try {
      const { accountId } = req.query;
      
      if (typeof accountId !== 'string') {
        return res.status(400).json({ message: 'Invalid account ID' });
      }

      const session = await getServerSession(req, res, authOptions);
      if (!session?.user?.id) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      // Verify the account belongs to the user
      const account = await prisma.account.findFirst({
        where: {
          id: accountId,
          userId: session.user.id,
        },
      });

      if (!account) {
        return res.status(404).json({ message: 'Account not found' });
      }

      // Delete the account
      await prisma.account.delete({
        where: { id: accountId },
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('Error disconnecting account:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Handle any other HTTP method
  res.setHeader('Allow', ['DELETE']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
