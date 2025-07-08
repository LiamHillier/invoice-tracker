'use client';

import { useSession, signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/ui/icons';
import { toast } from 'sonner';

interface ConnectedAccount {
  id: string;
  provider: string;
  email: string;
  isActive: boolean;
  lastSynced: string | null;
}

export default function ConnectedAccountsPage() {
  const { status } = useSession();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (status === 'unauthenticated') {
      router.push('/auth/sign-in');
      return;
    }

    if (status === 'authenticated') {
      fetchConnectedAccounts();
      
      // Check for success message
      const success = searchParams?.get('success');
      if (success) {
        toast.success(success.replace(/\+/g, ' '));
        // Remove success message from URL
        const newUrl = new URL(window.location.href);
        newUrl.searchParams.delete('success');
        window.history.replaceState({}, '', newUrl.toString());
      }
    }
  }, [status, router, searchParams]);

  const fetchConnectedAccounts = async () => {
    try {
      const response = await fetch('/api/accounts');
      if (!response.ok) {
        throw new Error('Failed to fetch connected accounts');
      }
      const data = await response.json();
      setAccounts(data);
    } catch (error) {
      toast.error('Failed to load connected accounts');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleConnectGmail = async () => {
    try {
      // This will redirect to Google OAuth for account connection
      await signIn('google', { callbackUrl: '/settings/connected-accounts' });
    } catch (error) {
      toast.error('Failed to initiate Gmail connection');
      console.error(error);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm('Are you sure you want to disconnect this account?')) return;
    
    try {
      const response = await fetch(`/api/accounts/${accountId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to disconnect account');
      }

      toast.success('Account disconnected successfully');
      fetchConnectedAccounts();
    } catch (error) {
      toast.error('Failed to disconnect account');
      console.error(error);
    }
  };

  if (status === 'loading' || isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Icons.spinner className="h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="container mx-auto py-10">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold">Connected Accounts</h1>
          <p className="text-muted-foreground">
            Manage your connected email accounts
          </p>
        </div>
        <Button onClick={handleConnectGmail} disabled={isLoading}>
          <Icons.google className="mr-2 h-4 w-4" />
          Connect Gmail
        </Button>
      </div>

      <div className="space-y-4">
        {accounts.length === 0 ? (
          <div className="text-center py-12 border rounded-lg">
            <Icons.google className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium">No connected accounts</h3>
            <p className="text-muted-foreground mt-1 mb-4">
              Connect your Gmail account to start tracking invoices
            </p>
            <Button onClick={handleConnectGmail}>
              <Icons.google className="mr-2 h-4 w-4" />
              Connect Gmail
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {accounts.map((account) => (
              <div
                key={account.id}
                className="flex items-center justify-between p-4 border rounded-lg"
              >
                <div className="flex items-center space-x-4">
                  {account.provider === 'google' && (
                    <Icons.google className="h-6 w-6" />
                  )}
                  <div>
                    <p className="font-medium">{account.email}</p>
                    <p className="text-sm text-muted-foreground">
                      {account.isActive ? 'Active' : 'Inactive'} • {account.provider}
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleDisconnect(account.id)}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Icons.spinner className="h-4 w-4 animate-spin" />
                  ) : (
                    'Disconnect'
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
