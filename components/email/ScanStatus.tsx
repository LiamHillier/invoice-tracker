'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Icons } from '@/components/ui/icons';
import { toast } from 'sonner';

interface ScanStatusProps {
  accountId: string;
  isActive: boolean;
  lastSynced?: Date | null;
  syncStatus?: string | null;
  onScanComplete?: () => void;
}

export function ScanStatus({
  isActive,
  lastSynced,
  syncStatus,
  onScanComplete,
}: ScanStatusProps) {
  const [isScanning, setIsScanning] = useState(false);

  const handleScan = async () => {
    if (isScanning) return;
    
    setIsScanning(true);
    const toastId = toast.loading('Scanning emails...');
    
    try {
      const response = await fetch('/api/email-scan', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      });
      
      const result = await response.json();
      
      if (response.ok) {
        toast.success(result.message, { id: toastId });
        if (onScanComplete) onScanComplete();
      } else {
        toast.error(result.error || 'Failed to scan emails', { id: toastId });
      }
    } catch (error) {
      console.error('Error scanning emails:', error);
      toast.error('Failed to start email scan', { id: toastId });
    } finally {
      setIsScanning(false);
    }
  };

  return (
    <div className="flex flex-col space-y-2">
      <div className="flex items-center space-x-2">
        <span className="text-sm font-medium">Status:</span>
        <span className="text-sm text-muted-foreground">
          {isActive ? (
            <span className="flex items-center">
              <span className="h-2 w-2 rounded-full bg-green-500 mr-2" />
              Active
            </span>
          ) : (
            <span className="flex items-center">
              <span className="h-2 w-2 rounded-full bg-gray-500 mr-2" />
              Inactive
            </span>
          )}
        </span>
      </div>
      
      {lastSynced && (
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium">Last Synced:</span>
          <span className="text-sm text-muted-foreground">
            {new Date(lastSynced).toLocaleString()}
          </span>
        </div>
      )}
      
      {syncStatus && (
        <div className="flex items-center space-x-2">
          <span className="text-sm font-medium">Sync Status:</span>
          <span className="text-sm text-muted-foreground capitalize">
            {syncStatus}
          </span>
        </div>
      )}
      
      <Button
        onClick={handleScan}
        disabled={isScanning || !isActive}
        className="mt-2 w-full sm:w-auto"
        size="sm"
      >
        {isScanning ? (
          <>
            <Icons.spinner className="mr-2 h-4 w-4 animate-spin" />
            Scanning...
          </>
        ) : (
          'Scan Now'
        )}
      </Button>
    </div>
  );
}
