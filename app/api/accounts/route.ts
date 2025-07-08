import type { NextApiRequest, NextApiResponse } from 'next';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/options';
import { prisma } from '@/lib/db/prisma';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method === 'GET') {
    try {
      const session = await getServerSession(req, res, authOptions);
      
      if (!session?.user?.id) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      const accounts = await prisma.account.findMany({
        where: {
          userId: session.user.id,
        },
        select: {
          id: true,
          provider: true,
          email: true,
          isActive: true,
          lastSynced: true,
        },
      });

      return res.status(200).json(accounts);
    } catch (error) {
      console.error('Error fetching connected accounts:', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Handle any other HTTP method
  res.setHeader('Allow', ['GET']);
  return res.status(405).end(`Method ${req.method} Not Allowed`);
}
