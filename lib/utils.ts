import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// List of valid ISO 4217 currency codes
const VALID_CURRENCIES = new Set([
  'AUD', 'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'CNY', 'INR', 'NZD', 'SGD'
]);

export function formatCurrency(amount: number, currency: string = 'AUD'): string {
  // Clean the currency code - remove any non-alphabetic characters and convert to uppercase
  const cleanCurrency = currency.replace(/[^A-Za-z]/g, '').toUpperCase();
  
  // Use the provided currency if it's valid, otherwise default to AUD
  const safeCurrency = VALID_CURRENCIES.has(cleanCurrency) ? cleanCurrency : 'AUD';
  
  try {
    return new Intl.NumberFormat('en-AU', {
      style: 'currency',
      currency: safeCurrency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch (error) {
    // If formatting fails for any reason, fall back to a simple format
    return `${safeCurrency} ${amount.toFixed(2)}`;
  }
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return 'N/A';
  
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('en-AU', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function truncateString(str: string, maxLength: number = 50): string {
  if (!str) return '';
  return str.length > maxLength ? `${str.substring(0, maxLength)}...` : str;
}

export function isEmail(text: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(text);
}

export function formatFileSize(bytes: number = 0): string {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeout: NodeJS.Timeout;
  
  return function executedFunction(...args: Parameters<T>) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}
